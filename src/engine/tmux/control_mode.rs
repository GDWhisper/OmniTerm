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

use super::client_registry::{self, ClientRegistry};
use crate::process_identity;

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
    /// P0-2 登记表句柄（未初始化时 `None`，不登记——见 `client_registry`）。
    registry: Option<ClientRegistry>,
}

impl ControlModeClient {
    /// Spawn a new `tmux -C attach-session` child process for `session_name`.
    ///
    /// The reader task is not started until [`Self::listen`] is called.
    pub async fn new(session_name: impl Into<String>) -> Result<Self> {
        let session_name = session_name.into();
        let mut cmd = super::tmux_cmd();
        cmd.args(["-C", "attach-session", "-t", &session_name]);
        Self::spawn_client(session_name, cmd, client_registry::global()).await
    }

    /// 实际构造逻辑，命令由调用方注入。
    ///
    /// 生产入口只有 [`Self::new`]（tmux 控制连接）；测试注入假 tmux 客户端
    /// 驱动**同一段**子进程生命周期代码（spawn / 收割 / kill 时序），使
    /// P2-2 的回归不依赖 tmux server。新增子进程行为只改这里，勿再复制。
    ///
    /// # PDEATHSIG（P0-1）与 spawn 线程边界
    ///
    /// VERIFIED 2026-09-22（docs/workflows/integration-checklist.md §A.1/A.2，
    /// 计划 `docs/dev/plans/2026-09-22-tmux-server-shutdown-hang.md` §5 P0-1）：
    /// - `prctl(PR_SET_PDEATHSIG, SIGKILL)` 生效性已真进程 e2e 验证：父进程被
    ///   SIGKILL 后子进程秒级消失（回归 `pdeathsig_kills_child_when_parent_process_dies`）；
    ///   `/proc/<pid>/status` 的 `PDeathSig` 字段受内核配置门控（本机 7.0.0
    ///   未导出），字段存在时回归断言其值 = 9，缺失时以行为断言为 OS 真值；
    /// - 内核语义差异（实测 kernel 7.0.0 + man prctl / kernel.org #43300 /
    ///   dotnet/runtime#96470 对照）：本内核为**进程**退出触发；文档与历史 issue
    ///   记载为**创建线程**终止触发——跨内核版本不可依赖。故 fork/exec 固定发生在
    ///   [`spawn_thread`] 持有的长寿命线程上，与调用方线程生命周期解耦，
    ///   「线程死亡不误杀」成为结构保证（回归
    ///   `pdeathsig_child_survives_spawning_thread_exit`）；
    /// - **禁止**把本函数包进 `spawn_blocking` 或任何短寿线程（阻塞池线程空闲
    ///   ~10s 退役；在按线程触发的内核上会误杀活得好好的客户端）；
    /// - `pre_exec` 内 `getppid()` 复查只覆盖 fork→prctl 之间的父**进程**死亡
    ///   竞态，不能替代上面的线程边界。
    async fn spawn_client(
        session_name: String,
        mut cmd: Command,
        registry: Option<ClientRegistry>,
    ) -> Result<Self> {
        // P0-1：父死杀子（仅 Linux；D1 决策 pty 路径不做，见 apply_pdeathsig）。
        apply_pdeathsig(&mut cmd);

        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = spawn_thread::spawn(cmd).await.map_err(|e| {
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

        // P0-2 登记：(pid, spawn_ppid, start_key, session) 入登记表供启动对账。
        // 超限拒登的 WARN 在 register 内记（父死兜底是 PDEATHSIG，不构成泄漏）。
        if let (Some(reg), Some(pid)) = (&registry, child_pid) {
            let start_key = process_identity::process_identity(pid)
                .map(|ident| ident.start_key)
                .unwrap_or_default();
            let _ = reg.register(client_registry::ClientEntry::new(
                pid,
                std::process::id(),
                start_key,
                &session_name,
            ));
        }

        let (exit_code_tx, exit_code_rx) = watch::channel(None);
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        // 常驻收割任务：Child 句柄唯一所有者，wait 到进程退出（见结构体文档
        // 的 P2-2 说明）。退出码经 watch 广播给 is_alive / stop；观测到退出即
        // 注销登记（P0-2 增删对称之一）。
        tokio::spawn(reap_child(
            session_name.clone(),
            child,
            kill_rx,
            exit_code_tx,
            registry.clone(),
            child_pid,
        ));

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
            registry,
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

        // P0-2 注销（增删对称之二）：ensure_session 死连接重建的替换路径在
        // 此收尾——注销不只挂优雅退出，否则实例内死条目滞留累积。按 pid
        // 幂等，与 reap 侧注销可重复执行。
        if let (Some(reg), Some(pid)) = (&self.registry, self.child_pid) {
            reg.deregister(pid);
        }
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

/// P0-1：给 `tmux -C` 子进程挂 PDEATHSIG（SIGKILL）——父进程死亡时内核直接
/// 杀子，覆盖 panic / abort / SIGKILL 等 `Drop`/`stop()` 到不了的崩溃路径
/// （计划 P0-1；D1 决策：pty 子进程**不做**，保留 pty(7) SIGHUP 收尾）。
///
/// 平台边界：`prctl(2)` 仅 Linux——macOS/Windows 无等价机制，由 P0-2 启动对账
/// 兜底（覆盖率差异见 `docs/architecture/backend.md` 平台差异表，AGENTS §8）。
///
/// pre_exec 闭包 async-signal-safe：`prctl` / `getppid` / `_exit` 均安全。
/// `getppid()` 复查只覆盖 fork→prctl 之间的父**进程**死亡竞态（彼时 PDEATHSIG
/// 已无从投递，只能自行退出），**不能替代** spawn 线程边界（见 [`spawn_thread`]）。
#[cfg(target_os = "linux")]
fn apply_pdeathsig(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    let expected_ppid = std::process::id();
    unsafe {
        cmd.as_std_mut().pre_exec(move || {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() as u32 != expected_ppid {
                // fork→prctl 竞态窗口内父已亡（被收养），PDEATHSIG 无从投递。
                libc::_exit(1);
            }
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn apply_pdeathsig(_cmd: &mut Command) {
    // 非 Linux 无 PDEATHSIG 等价物（D1 平台边界）：由 P0-2 启动对账兜底。
}

/// `tmux -C` 子进程 fork/exec 的固定发生地（P0-1 的线程语义隔离边界）。
///
/// PDEATHSIG 在**部分内核**上于「创建该子进程的线程」终止时触发（man prctl 与
/// kernel.org #43300、dotnet/runtime#96470 均按此记载），tokio 阻塞池线程退役
/// （空闲 ~10s）或任何短寿线程都会误杀活得好好的客户端；kernel 7.0 实测为进程
/// 退出触发，但跨版本不可依赖。故所有 `tmux -C` 子进程固定由本模块持有的
/// **长寿命线程** fork/exec，与调用方线程（tokio worker / 测试线程 / 未来任何
/// 短寿线程）的生命周期解耦——「线程死亡不误杀」因此是结构保证而非纪律约定
/// （§9 反向断言 `pdeathsig_child_survives_spawning_thread_exit` 守门）。
mod spawn_thread {
    use std::sync::mpsc;
    use std::sync::{Mutex, OnceLock};

    use tokio::process::{Child, Command};
    use tokio::runtime::Handle;
    use tokio::sync::oneshot;

    struct Job {
        cmd: Command,
        handle: Handle,
        reply: oneshot::Sender<std::io::Result<Child>>,
    }

    static SPAWN_TX: OnceLock<Mutex<mpsc::Sender<Job>>> = OnceLock::new();

    fn spawn_tx() -> &'static Mutex<mpsc::Sender<Job>> {
        SPAWN_TX.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("omniterm-tmux-spawn".into())
                .spawn(move || {
                    while let Ok(mut job) = rx.recv() {
                        // tokio 的 Child 包装（管道 PollEvented 注册）需要运行时
                        // 上下文：把调用方的 Handle 带进本线程 enter 后再 spawn。
                        let _enter = job.handle.enter();
                        let _ = job.reply.send(job.cmd.spawn());
                    }
                })
                .expect("failed to start omniterm-tmux-spawn thread");
            Mutex::new(tx)
        })
    }

    /// 在长寿命 spawn 线程上执行 `cmd.spawn()`（见模块注）。
    pub async fn spawn(cmd: Command) -> std::io::Result<Child> {
        let (reply, rx) = oneshot::channel();
        let job = Job { cmd, handle: Handle::current(), reply };
        spawn_tx()
            .lock()
            .expect("tmux spawn 线程通道锁中毒")
            .send(job)
            .map_err(|_| std::io::Error::other("omniterm-tmux-spawn 线程已退出"))?;
        rx.await.map_err(|_| std::io::Error::other("omniterm-tmux-spawn 线程未应答"))?
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
    registry: Option<ClientRegistry>,
    child_pid: Option<u32>,
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

    // P0-2 注销（增删对称之一）：观测到子进程退出即注销登记——覆盖自然死亡 /
    // Drop 强杀，不依赖调用方走 `stop()`。按 pid 幂等。
    if let (Some(reg), Some(pid)) = (&registry, child_pid) {
        reg.deregister(pid);
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
        let client =
            ControlModeClient::spawn_client(name, fake_tmux_client("sleep 0.3; exit 7"), None)
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
        let client = ControlModeClient::spawn_client(name, fake_tmux_client("sleep 30"), None)
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

    // ── P0-1 PDEATHSIG 回归（计划 §9 验收） ──────────────────────────────

    /// §9 OS 真值断言：`/proc/<pid>/status` 的 `PDeathSig` 字段必须为 9(SIGKILL)。
    ///
    /// 字段受内核配置门控（实测本机 kernel 7.0.0 未导出）——存在则断言其值，
    /// 缺失则跳过字段断言；无论字段在否，行为 OS 真值由
    /// `pdeathsig_kills_child_when_parent_process_dies` 无条件覆盖。
    #[tokio::test]
    async fn pdeathsig_os_truth_pdeathsig_field_is_sigkill() {
        let name = format!("omniterm_test_pdeathsig_field_{}", Uuid::new_v4());
        let client = ControlModeClient::spawn_client(name, fake_tmux_client("sleep 30"), None)
            .await
            .expect("client should start");
        let pid = client.pid().await.expect("pid");

        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).expect("read status");
        match status.lines().find(|line| line.starts_with("PDeathSig")) {
            Some(line) => {
                assert_eq!(
                    line.split_whitespace().nth(1),
                    Some("9"),
                    "PDeathSig 必须为 SIGKILL(9)：{line}"
                );
            }
            None => {
                eprintln!(
                    "[skip] 本内核未导出 /proc/<pid>/status PDeathSig 字段，跳过字段断言（行为断言仍覆盖）"
                );
            }
        }
        client.stop().await;
    }

    /// §9：spawn 受管理的 `tmux -C` 子进程 → SIGKILL 父进程 → 子进程在约定时限
    /// 内消失（PDEATHSIG 的行为 OS 真值，真进程 e2e）。
    ///
    /// 父进程 = 重新拉起的本测试二进制（helper 模式，见
    /// `pdeathsig_helper_parent`）：它经 `spawn_client` 生出子进程并回报 pid 后
    /// 长睡，本用例 SIGKILL 之，观察子进程随之消失。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pdeathsig_kills_child_when_parent_process_dies() {
        let exe = std::env::current_exe().expect("current_exe");
        let mut helper = Command::new(exe)
            .args([
                // libtest 的 --exact 按**全名**匹配（模块路径前缀必须带上）。
                "engine::tmux::control_mode::tests::pdeathsig_helper_parent",
                "--exact",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn helper parent");

        // 有界读取 helper 回报的子进程 pid。libtest 的 `test <name> ... ` 前缀
        // 与 println! 共线，须按子串取值而非 strip_prefix。
        let mut reader = BufReader::new(helper.stdout.take().expect("helper stdout"));
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut child_pid: Option<u32> = None;
        while Instant::now() < deadline && child_pid.is_none() {
            let mut line = String::new();
            match tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line)).await {
                Ok(Ok(0)) => break,
                Ok(Ok(_)) => {
                    child_pid = line
                        .split("PDEATHSIG_CHILD_PID=")
                        .nth(1)
                        .and_then(|p| p.trim().parse().ok());
                }
                Ok(Err(_)) | Err(_) => continue,
            }
        }
        let child_pid = child_pid.expect("helper 应回报 PDEATHSIG_CHILD_PID=<pid>");
        assert!(
            std::path::Path::new(&format!("/proc/{child_pid}")).exists(),
            "helper 存活期间子进程应在跑"
        );

        // SIGKILL 父进程 → PDEATHSIG 必须让子进程在约定时限内消失。
        let _ = helper.kill().await;
        let _ = helper.wait().await;
        assert!(
            wait_reaped(child_pid, Duration::from_secs(10)).await,
            "父进程被 SIGKILL 后 PDEATHSIG 子进程应消失（{child_pid} 残留）"
        );
    }

    /// [`pdeathsig_kills_child_when_parent_process_dies`] 的 helper（**勿直接
    /// 跑**）：`#[ignore]` 保护，只被外层用例以 `--ignored --exact` 重新拉起。
    /// 起受管理的假 `tmux -C` 子进程，回报 pid 后长睡，等外层 SIGKILL。
    #[tokio::test]
    #[ignore = "helper: 仅由 pdeathsig_kills_child_when_parent_process_dies 以 --ignored --exact 拉起"]
    async fn pdeathsig_helper_parent() {
        let client = ControlModeClient::spawn_client(
            "omniterm_test_pdeathsig_helper".to_string(),
            fake_tmux_client("sleep 300"),
            None,
        )
        .await
        .expect("client should start");
        let pid = client.pid().await.expect("pid");
        println!("PDEATHSIG_CHILD_PID={pid}");
        tokio::time::sleep(Duration::from_secs(300)).await;
    }

    /// §9 反向断言（PDEATHSIG 线程误触发）：起独立线程 spawn 后 join——创建
    /// 线程退出而进程存活 → 子进程必须存活。
    ///
    /// 钉住 [`spawn_thread`] 的结构不变式：fork/exec 不发生在随调用方消亡的
    /// 线程上（在按创建线程触发 PDEATHSIG 的内核上，直接 spawn 实现过不了本
    /// 用例）。详见 `spawn_client` 的 VERIFIED 注。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pdeathsig_child_survives_spawning_thread_exit() {
        let name = format!("omniterm_test_reverse_{}", Uuid::new_v4());
        let runtime = tokio::runtime::Handle::current();
        let client = std::thread::spawn(move || {
            runtime.block_on(async move {
                ControlModeClient::spawn_client(name, fake_tmux_client("sleep 30"), None).await
            })
        })
        .join()
        .expect("独立 spawn 线程应正常结束")
        .expect("client should start");
        let pid = client.pid().await.expect("pid");

        // 创建线程已死（join 返回）；给内核触发窗口后子进程必须仍存活。
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "创建线程退出而进程存活，子进程被误杀（PDEATHSIG 线程误触发回归）"
        );
        client.stop().await;
    }

    /// 收割不回归（§9）：PDEATHSIG 子进程仍由常驻收割任务恰好回收，stop() 返回
    /// 时 `/proc/<pid>` 已消失、无新僵尸（与 `control_mode_stop_kills_and_reaps_child`
    /// 同口径，但子进程带 PDEATHSIG 标记——死因无关收割路径不因 PDEATHSIG 破坏）。
    #[tokio::test]
    async fn pdeathsig_child_is_still_reaped_exactly_once() {
        let name = format!("omniterm_test_pdeathsig_reap_{}", Uuid::new_v4());
        let client = ControlModeClient::spawn_client(name, fake_tmux_client("sleep 30"), None)
            .await
            .expect("client should start");
        let pid = client.pid().await.expect("pid");

        tokio::time::timeout(Duration::from_secs(10), client.stop()).await.expect("stop 不应挂死");
        assert!(
            wait_reaped(pid, Duration::from_secs(5)).await,
            "PDEATHSIG 子进程必须被收割（无僵尸）"
        );
    }
}
