use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, RwLock, oneshot, watch};
use tokio::task::JoinHandle;
use tracing::debug;

/// Default activity window: a session stays active for 2 seconds after the last
/// `%output` event from tmux control mode.
pub const DEFAULT_ACTIVITY_TIMEOUT: Duration = Duration::from_secs(2);

/// `stop()` 等 reaper 记账退出码的有界上界。SIGKILL 后进程必退，2s 只为
/// 兜住调度抖动，不会成为常规耗时。
const EXIT_CODE_WAIT: Duration = Duration::from_secs(2);

/// 信号致死时代替退出码的哨兵值：Unix 退出码取 waitpid 状态高 8 位
/// （0..=255），-1 不可能是真实退出码，故可无歧义表示「已退出、无退出码」。
/// Windows 上 `ExitStatus::code()` 对异常终止同样返回 `None`，哨兵语义一致。
/// 平台中立——reap/stop 记账路径是无条件编译的，勿加平台门控（v0.2.24 发版
/// Windows job 实测：门控 unix 使 `reap_child` E0425）。
const EXITED_WITHOUT_CODE: i32 = -1;

/// A single tmux control-mode connection for one session.
///
/// Spawns `tmux -C attach-session -t <session>` and asynchronously parses
/// `%output` events to track the most recent pane output time.
///
/// # 子进程生命周期（P2-2，2026-09-22 修复）
///
/// `Child` 句柄的唯一所有者是构造时 spawn 的常驻收割任务（见
/// [`reap_child`]）：它 `wait()` 到进程退出，**无论死因**（自然退出 / SIGHUP /
/// kill / 客户端被 drop 后的孤儿），corpse 都恰好被收割一次。
///
/// 修复前的结构缺口：句柄存在 `self.child` 里，只有 `stop()` 会 `wait()`。而
/// tmux 会话被外部 kill（或 tmux server 退出）时，`tmux -C attach-session`
/// 子进程**自行退出**，此时没有任何调用方会 `stop()`——句柄滞留在
/// [`SessionActivityMonitor`] 的 map 里直到该会话被重新 track，进程在
/// `/proc` 留僵尸（现场实测 10 个 `defunct tmux: client`、最久 10 天，父进程
/// 均为后端本体）。`Drop` 同样只 `start_kill()` 不 `wait()`，补刀无济于事。
pub struct ControlModeClient {
    session_name: String,
    last_output_at: Arc<Mutex<Option<Instant>>>,
    stdout: Mutex<Option<BufReader<ChildStdout>>>,
    stdin: Mutex<Option<ChildStdin>>,
    /// 子进程 pid（kill 指令与诊断用；句柄已交托 reaper 任务）。
    child_pid: Option<u32>,
    /// reaper 写入的子进程退出观测：`None` = 尚未退出；`Some(code)` = 已退出
    /// （信号致死 = [`EXITED_WITHOUT_CODE`]，无退出码）。`is_alive` 与 `stop`
    /// 日志读它。
    exit_code: Mutex<watch::Receiver<Option<i32>>>,
    reader_handle: Mutex<Option<JoinHandle<()>>>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    /// 强杀指令（`stop`/`Drop` → reaper 执行 `start_kill`）。句柄归 reaper
    /// 所有，故 kill 也只能经它转发，保证「发过 kill 的进程必被 wait」。
    kill_tx: Mutex<Option<oneshot::Sender<()>>>,
}

impl ControlModeClient {
    /// Spawn a new `tmux -C attach-session` child process for `session_name`.
    ///
    /// The reader task is not started until [`Self::listen`] is called.
    pub async fn new(session_name: impl Into<String>) -> Result<Self> {
        let session_name = session_name.into();
        let mut cmd = super::tmux_cmd();
        cmd.args(["-C", "attach-session", "-t", &session_name]);
        Self::spawn_client(session_name, cmd).await
    }

    /// 实际构造逻辑，命令由调用方注入。
    ///
    /// 生产入口只有 [`Self::new`]（tmux 控制连接）；测试注入假 tmux 客户端
    /// 驱动**同一段**子进程生命周期代码（spawn / 收割 / kill 时序），使
    /// P2-2 的回归不依赖 tmux server。新增子进程行为只改这里，勿再复制。
    async fn spawn_client(session_name: String, mut cmd: Command) -> Result<Self> {
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                anyhow!("failed to spawn tmux control mode for session {}: {}", session_name, e)
            })?;

        let stdin =
            child.stdin.take().ok_or_else(|| anyhow!("tmux control mode stdin not available"))?;
        let stdout =
            child.stdout.take().ok_or_else(|| anyhow!("tmux control mode stdout not available"))?;
        let stderr =
            child.stderr.take().ok_or_else(|| anyhow!("tmux control mode stderr not available"))?;

        // Capture stderr so we can diagnose unexpected child exits.
        tokio::spawn(stderr_reader(session_name.clone(), stderr));

        let child_pid = child.id();
        let (exit_code_tx, exit_code_rx) = watch::channel(None);
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        // 常驻收割任务：Child 句柄唯一所有者，wait 到进程退出（见结构体文档
        // 的 P2-2 说明）。退出码经 watch 广播给 is_alive / stop。
        tokio::spawn(reap_child(session_name.clone(), child, kill_rx, exit_code_tx));

        debug!("started tmux control mode client for session {}", session_name);

        Ok(Self {
            session_name,
            last_output_at: Arc::new(Mutex::new(None)),
            stdout: Mutex::new(Some(BufReader::new(stdout))),
            stdin: Mutex::new(Some(stdin)),
            child_pid,
            exit_code: Mutex::new(exit_code_rx),
            reader_handle: Mutex::new(None),
            shutdown_tx: Mutex::new(None),
            kill_tx: Mutex::new(Some(kill_tx)),
        })
    }

    /// Return the underlying OS process id, if available.
    #[allow(dead_code)] // 待核：遗留/未接线/仅测试用，见 docs/dev/plans/backlog/dead-code-triage.md
    pub async fn pid(&self) -> Option<u32> {
        self.child_pid
    }

    /// Start the async reader task that watches for `%output` events.
    pub async fn listen(&self) -> Result<()> {
        let mut stdout_guard = self.stdout.lock().await;
        let reader =
            stdout_guard.take().ok_or_else(|| anyhow!("control mode reader already started"))?;

        let (tx, rx) = oneshot::channel();
        let last_output_at = Arc::clone(&self.last_output_at);
        let session_name = self.session_name.clone();
        let handle = tokio::spawn(reader_loop(session_name, reader, last_output_at, rx));

        let mut handle_guard = self.reader_handle.lock().await;
        *handle_guard = Some(handle);

        let mut shutdown_guard = self.shutdown_tx.lock().await;
        *shutdown_guard = Some(tx);

        Ok(())
    }

    /// 连接是否存活：读循环在跑**且**子进程未退出。
    ///
    /// 两个信号任一即死：stdout EOF（读循环结束）或 reaper 记账退出。据此
    /// [`SessionActivityMonitor::ensure_session`] 才会重建死连接。
    pub async fn is_alive(&self) -> bool {
        let reader_alive = {
            let guard = self.reader_handle.lock().await;
            guard.as_ref().is_some_and(|handle| !handle.is_finished())
        };
        if !reader_alive {
            return false;
        }
        self.exit_code.lock().await.borrow().is_none()
    }

    /// Return `true` if the session has produced output within `timeout`.
    pub async fn is_active(&self, timeout: Duration) -> bool {
        let guard = self.last_output_at.lock().await;
        match *guard {
            Some(t) => Instant::now().duration_since(t) < timeout,
            None => false,
        }
    }

    /// Gracefully stop the control mode connection and reap the child process.
    ///
    /// 顺序：读循环退出信号 → 关 stdin（tmux client 干净退出）→ 经 reaper
    /// 兜底强杀 → 等读循环结束 → 等 reaper 记账退出码（有界）。返回时子进程
    /// 已退出且被收割（`PidfdReaper`/僵尸都不会残留）。
    pub async fn stop(&self) {
        // Signal the reader to exit.
        if let Some(tx) = {
            let mut guard = self.shutdown_tx.lock().await;
            guard.take()
        } {
            let _ = tx.send(());
        }

        // Closing stdin causes the tmux client to exit cleanly.
        {
            let mut guard = self.stdin.lock().await;
            let _ = guard.take();
        }

        // Backstop kill: forwarded to the reaper, which owns the Child handle.
        if let Some(tx) = {
            let mut guard = self.kill_tx.lock().await;
            guard.take()
        } {
            let _ = tx.send(());
        }

        // Wait for the reader to finish (its stdout EOF means the child is gone).
        let handle = {
            let mut guard = self.reader_handle.lock().await;
            guard.take()
        };
        if let Some(handle) = handle {
            let _ = handle.await;
        }

        // Wait (bounded) for the reaper to record the exit code. Registration
        // happens right after the kernel reaps the corpse, so once it lands the
        // process is fully gone from /proc.
        {
            let mut rx = self.exit_code.lock().await;
            let _ = tokio::time::timeout(EXIT_CODE_WAIT, rx.changed()).await;
        }
        let exit_code = *self.exit_code.lock().await.borrow();
        debug!(
            "tmux control mode process for session {} exited with {:?}",
            self.session_name, exit_code
        );
    }
}

impl Drop for ControlModeClient {
    fn drop(&mut self) {
        // 与 `stop` 同口径但无 await：信号发齐即返回，收割由常驻 reaper 任务
        // 负责（它独占 Child 句柄，进程退出必被 wait）。Drop 里既不能也不
        // 需要同步 wait——修复前「只 start_kill 不 wait」正是僵尸来源之一。
        if let Ok(mut guard) = self.shutdown_tx.try_lock()
            && let Some(tx) = guard.take()
        {
            let _ = tx.send(());
        }

        if let Ok(mut guard) = self.stdin.try_lock() {
            let _ = guard.take();
        }

        if let Ok(mut guard) = self.kill_tx.try_lock()
            && let Some(tx) = guard.take()
        {
            let _ = tx.send(());
        }
    }
}

/// 常驻收割任务（`Child` 句柄唯一所有者，P2-2 修复的核心）。
///
/// `wait()` 到子进程退出——自然退出、SIGHUP、`stop`/`Drop` 的强杀都汇到这
/// 一条路径，故 corpse 恰好被收割一次；`kill_rx` 到点时先 `start_kill`
/// 再等。退出码写入 `exit_code`（`is_alive` / `stop` 日志读）。
///
/// 修复前句柄存在 `ControlModeClient.child` 里、只有 `stop()` 会 wait：
/// tmux 会话被外部 kill 时控制连接子进程自行退出而无人 `stop`，僵尸滞留
/// `/proc` 直到会话被重新 track（现场 10 个、最久 10 天）。
async fn reap_child(
    session_name: String,
    mut child: Child,
    mut kill_rx: oneshot::Receiver<()>,
    exit_code: watch::Sender<Option<i32>>,
) {
    let result = tokio::select! {
        status = child.wait() => status,
        _ = &mut kill_rx => {
            // stop/Drop 的兜底强杀。进程已退出时 kill 报 ESRCH 之类的错误，
            // 忽略——下面的 wait 无论如何都会收尾。
            if let Err(e) = child.start_kill() {
                debug!(
                    "failed to kill tmux control mode process for session {}: {}",
                    session_name, e
                );
            }
            child.wait().await
        }
    };
    match result {
        Ok(status) => {
            // 信号致死（如 SIGKILL）没有退出码，记 EXITED_WITHOUT_CODE 哨兵。
            let code = status.code().unwrap_or(EXITED_WITHOUT_CODE);
            let _ = exit_code.send(Some(code));
            debug!("tmux control mode process for session {} exited with {}", session_name, status);
        }
        Err(e) => {
            let _ = exit_code.send(Some(EXITED_WITHOUT_CODE));
            debug!("tmux control mode process for session {} wait error: {}", session_name, e);
        }
    }
}

async fn reader_loop(
    session_name: String,
    mut reader: BufReader<ChildStdout>,
    last_output_at: Arc<Mutex<Option<Instant>>>,
    mut shutdown: oneshot::Receiver<()>,
) {
    // Use a byte buffer because pane output may contain invalid UTF-8.
    let mut line = Vec::new();

    loop {
        line.clear();

        tokio::select! {
            _ = &mut shutdown => break,
            result = reader.read_until(b'\n', &mut line) => {
                match result {
                    Ok(0) => {
                        debug!("tmux control mode stdout closed for session {}", session_name);
                        break;
                    }
                    Ok(_) => {
                        if line.starts_with(b"%output") {
                            let mut guard = last_output_at.lock().await;
                            *guard = Some(Instant::now());
                            debug!(
                                "tmux control mode %output event received for session {}",
                                session_name
                            );
                        }
                    }
                    Err(e) => {
                        debug!(
                            "tmux control mode read error for session {}: {}",
                            session_name, e
                        );
                        break;
                    }
                }
            }
        }
    }

    debug!("tmux control mode reader loop exited for session {}", session_name);
}

async fn stderr_reader(session_name: String, stderr: tokio::process::ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) => break,
            Ok(_) => {
                let text = String::from_utf8_lossy(&line);
                debug!("tmux control mode stderr for session {}: {}", session_name, text.trim());
            }
            Err(e) => {
                debug!("tmux control mode stderr error for session {}: {}", session_name, e);
                break;
            }
        }
    }
}

/// Manages control-mode connections for multiple sessions and exposes a simple
/// `is_active(session_name)` query.
#[derive(Clone)]
pub struct SessionActivityMonitor {
    clients: Arc<RwLock<HashMap<String, ControlModeClient>>>,
    timeout: Duration,
}

impl SessionActivityMonitor {
    /// Create a new monitor with the given inactivity timeout.
    pub fn new(timeout: Duration) -> Self {
        Self { clients: Arc::new(RwLock::new(HashMap::new())), timeout }
    }

    /// Ensure a control-mode connection exists for `session_name`.
    ///
    /// If an existing connection has died, it is removed and recreated.
    pub async fn ensure_session(&self, session_name: &str) -> Result<()> {
        let needs_recreate = {
            let clients = self.clients.read().await;
            match clients.get(session_name) {
                Some(client) => !client.is_alive().await,
                None => true,
            }
        };

        if !needs_recreate {
            return Ok(());
        }

        let mut clients = self.clients.write().await;
        // Recheck under the write lock to avoid duplicate creation races.
        if let Some(client) = clients.get(session_name) {
            if client.is_alive().await {
                return Ok(());
            }
            // Remove the dead client before replacing it.
            let client = clients.remove(session_name).expect("client existed a moment ago");
            client.stop().await;
        }

        let client = ControlModeClient::new(session_name).await?;
        client.listen().await?;
        clients.insert(session_name.to_string(), client);
        Ok(())
    }

    /// Remove and stop the control-mode connection for `session_name`.
    pub async fn remove_session(&self, session_name: &str) {
        let client = {
            let mut clients = self.clients.write().await;
            clients.remove(session_name)
        };
        if let Some(client) = client {
            client.stop().await;
        }
    }

    /// Return `true` if the session has produced output recently.
    pub async fn is_active(&self, session_name: &str) -> bool {
        let clients = self.clients.read().await;
        if let Some(client) = clients.get(session_name) {
            client.is_active(self.timeout).await
        } else {
            false
        }
    }
}

#[allow(dead_code)]
const _: () = {
    fn assert_send_sync<T: Send + Sync>() {}
    fn _assert() {
        assert_send_sync::<ControlModeClient>();
        assert_send_sync::<SessionActivityMonitor>();
    }
};

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::process::Command;
    use uuid::Uuid;

    /// 建测试用 tmux 会话。`pane_cmd` 为 `Some` 时用该命令替代默认 shell——
    /// 默认 shell 会在 attach 后异步打印提示符（实测本机 ~440ms、CI 更快），
    /// 落进「初始不活跃」断言窗口就成了与机器速度相关的 flaky。
    async fn create_test_tmux_session(name: &str, pane_cmd: Option<&str>) {
        let mut args: Vec<&str> = vec!["new-session", "-d", "-s", name];
        if let Some(cmd) = pane_cmd {
            args.push(cmd);
        }
        let output =
            Command::new("tmux").args(&args).output().await.expect("tmux should be available");
        assert!(output.status.success(), "failed to create tmux session: {:?}", output);
    }

    /// 送一次输入到测试会话，返回是否在 `wait` 内观测到活跃。
    async fn poke_input(
        client: &ControlModeClient,
        name: &str,
        timeout: Duration,
        wait: Duration,
    ) -> bool {
        let output = Command::new("tmux")
            .args(["send-keys", "-t", name, "echo hello", "Enter"])
            .output()
            .await
            .expect("send-keys should succeed");
        assert!(output.status.success(), "send-keys should succeed: {output:?}");
        wait_for_active(client, timeout, true, wait).await
    }

    /// 有界轮询等待 `is_active(timeout)` 达到 `want`。
    ///
    /// 替代固定 sleep + 立即断言：`%output` 的到达时机取决于 pane 进程与 tmux
    /// 调度，固定睡眠在慢/快机器上必然出现窗口错配。
    async fn wait_for_active(
        client: &ControlModeClient,
        timeout: Duration,
        want: bool,
        budget: Duration,
    ) -> bool {
        let deadline = Instant::now() + budget;
        loop {
            if client.is_active(timeout).await == want {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    async fn kill_test_tmux_session(name: &str) {
        let _ = Command::new("tmux").args(["kill-session", "-t", name]).output().await;
    }

    /// 假 tmux 控制客户端：与 `tmux -C attach-session` 走同一段 spawn/收割/
    /// kill 生命周期代码（`ControlModeClient::spawn_client` 注入命令）。
    ///
    /// 存在的理由：本环境（容器无 devpts，`/dev/pts` 为空）tmux server 起不来，
    /// 依赖真实 tmux 的既有测试在此不可跑；而 P2-2 的回归钉的是**子进程
    /// 收割时序**，与对端是不是真 tmux 无关。
    fn fake_tmux_client(script: &str) -> Command {
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg(script);
        cmd
    }

    /// 轮询 `/proc/<pid>` 直到进程被完全收割（条目消失）。
    async fn wait_reaped(pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            // 僵尸也留在 /proc（状态 Z），故「条目消失」才是已收割的精确信号。
            if std::path::Path::new(&format!("/proc/{pid}")).exists() {
                if Instant::now() >= deadline {
                    return false;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            } else {
                return true;
            }
        }
    }

    /// P2-2 回归（核心反馈环）：子进程**自行退出**时必须被收割。
    ///
    /// 现场形态：tmux 会话被外部 kill（或 server 退出）→ `tmux -C attach-session`
    /// 子进程随之退出，而 omniterm 侧没有任何调用方会 `stop()`——句柄滞留在
    /// `SessionActivityMonitor` map 里，进程在 /proc 留僵尸（实测 10 个
    /// `defunct tmux: client`、最久 10 天）。修复 = 常驻 reap 任务独占句柄
    /// 并 wait，死因无关。
    ///
    /// 本用例**不调用 stop()**，钉的正是「无人 stop」这条路径。
    #[tokio::test]
    async fn control_mode_child_is_reaped_after_natural_death() {
        let name = format!("omniterm_test_reap_{}", Uuid::new_v4());
        // 0.3s 后自行退出（留窗口保证 spawn 后断言存活的确定性），退出码 7。
        let client = ControlModeClient::spawn_client(name, fake_tmux_client("sleep 0.3; exit 7"))
            .await
            .expect("client should start");
        client.listen().await.expect("listener should start");

        let pid = client.pid().await.expect("client should have a pid");
        assert!(std::path::Path::new(&format!("/proc/{pid}")).exists(), "spawn 后子进程应在跑");

        // 不 stop、不 kill：等它自己退出。此后 /proc/<pid> 必须消失（被收割）。
        assert!(
            wait_reaped(pid, Duration::from_secs(5)).await,
            "control mode 子进程 {pid} 已自行退出但未被收割（僵尸残留，P2-2 回归）"
        );
        // reaper 的退出码记账也应已落。
        assert_eq!(*client.exit_code.lock().await.borrow(), Some(7), "reaper 应记录到退出码 7");
        assert!(!client.is_alive().await, "子进程退出后 is_alive 应为 false");
    }

    /// P2-2 回归（stop 路径）：`stop()` 对驻留客户端必须杀且收割，
    /// 返回时 `/proc/<pid>` 已消失（无僵尸）。
    #[tokio::test]
    async fn control_mode_stop_kills_and_reaps_child() {
        let name = format!("omniterm_test_stop_{}", Uuid::new_v4());
        let client = ControlModeClient::spawn_client(name, fake_tmux_client("sleep 30"))
            .await
            .expect("client should start");
        client.listen().await.expect("listener should start");

        let pid = client.pid().await.expect("client should have a pid");
        assert!(std::path::Path::new(&format!("/proc/{pid}")).exists(), "stop 前子进程应在跑");

        // 超时包一层：若 kill 路由退化（没人发信号），stop 会挂在等读循环上，
        // 这里把它转成明确失败而不是挂死整个测试套件。
        tokio::time::timeout(Duration::from_secs(10), client.stop())
            .await
            .expect("stop 不应挂死（子进程未被杀死？）");

        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "stop 返回后子进程应已退出且被收割（无僵尸）"
        );
        // SIGKILL 致死无退出码：记 EXITED_WITHOUT_CODE 哨兵。
        assert_eq!(
            *client.exit_code.lock().await.borrow(),
            Some(EXITED_WITHOUT_CODE),
            "SIGKILL 致死时退出码应为哨兵值"
        );
    }

    #[tokio::test]
    async fn control_mode_client_detects_output_and_timeout() {
        let name = format!("omniterm_test_active_{}", Uuid::new_v4());
        // pane 用 cat：不产生启动输出，只把输入回显出去（送 send-keys 必得 %output）。
        create_test_tmux_session(&name, Some("cat")).await;

        let client = ControlModeClient::new(&name).await.expect("client should start");
        client.listen().await.expect("listener should start");

        let timeout = Duration::from_secs(2);

        // 无输出即不活跃；预算给足 timeout，attach 期若有残留事件也会自然过期。
        assert!(
            wait_for_active(&client, timeout, false, Duration::from_secs(5)).await,
            "session without any output should be inactive"
        );

        // 产生输出后进入活跃态。**不能只送一次**：control-mode 只转发 attach 之后的
        // 输出（attach 不回放屏幕内容），而握手（`%session-changed`）可能晚于第一次
        // send-keys，早于握手产生的回显就永远不会被转发——实测未等握手即送键时 7/30
        // 丢失（等 300ms 后送键 0/30）。故在预算内有界重试送键，直到观测到活跃。
        let deadline = Instant::now() + Duration::from_secs(6);
        let mut observed = false;
        while !observed && Instant::now() < deadline {
            observed = poke_input(&client, &name, timeout, Duration::from_millis(500)).await;
        }
        assert!(observed, "session should be active after producing output");

        // 静默超过 timeout 后转为不活跃（预算 = timeout + 余量）。
        assert!(
            wait_for_active(&client, timeout, false, timeout + Duration::from_secs(3)).await,
            "session should become inactive after the activity timeout"
        );

        client.stop().await;
        kill_test_tmux_session(&name).await;
    }

    #[tokio::test]
    async fn control_mode_client_cleans_up_child() {
        let name = format!("omniterm_test_cleanup_{}", Uuid::new_v4());
        create_test_tmux_session(&name, None).await;

        let client = ControlModeClient::new(&name).await.expect("client should start");
        client.listen().await.expect("listener should start");

        let pid = client.pid().await.expect("client should have a process id");
        assert!(std::path::Path::new(&format!("/proc/{}", pid)).exists());

        client.stop().await;

        // Give the kernel a moment to reap the process.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!std::path::Path::new(&format!("/proc/{}", pid)).exists());

        kill_test_tmux_session(&name).await;
    }
}
