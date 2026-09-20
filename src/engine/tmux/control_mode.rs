use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{Mutex, RwLock, oneshot};
use tokio::task::JoinHandle;
use tracing::{debug, warn};

/// Default activity window: a session stays active for 2 seconds after the last
/// `%output` event from tmux control mode.
pub const DEFAULT_ACTIVITY_TIMEOUT: Duration = Duration::from_secs(2);

/// A single tmux control-mode connection for one session.
///
/// Spawns `tmux -C attach-session -t <session>` and asynchronously parses
/// `%output` events to track the most recent pane output time.
pub struct ControlModeClient {
    session_name: String,
    last_output_at: Arc<Mutex<Option<Instant>>>,
    stdout: Mutex<Option<BufReader<ChildStdout>>>,
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    reader_handle: Mutex<Option<JoinHandle<()>>>,
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
}

impl ControlModeClient {
    /// Spawn a new `tmux -C attach-session` child process for `session_name`.
    ///
    /// The reader task is not started until [`Self::listen`] is called.
    pub async fn new(session_name: impl Into<String>) -> Result<Self> {
        let session_name = session_name.into();

        let mut child = super::tmux_cmd()
            .args(["-C", "attach-session", "-t", &session_name])
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

        debug!("started tmux control mode client for session {}", session_name);

        Ok(Self {
            session_name,
            last_output_at: Arc::new(Mutex::new(None)),
            stdout: Mutex::new(Some(BufReader::new(stdout))),
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
            reader_handle: Mutex::new(None),
            shutdown_tx: Mutex::new(None),
        })
    }

    /// Return the underlying OS process id, if available.
    #[allow(dead_code)] // 待核：遗留/未接线/仅测试用，见 docs/dev/plans/backlog/dead-code-triage.md
    pub async fn pid(&self) -> Option<u32> {
        let guard = self.child.lock().await;
        guard.as_ref()?.id()
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

    /// Return `true` if the reader task is still running.
    pub async fn is_alive(&self) -> bool {
        let guard = self.reader_handle.lock().await;
        guard.as_ref().is_some_and(|handle| !handle.is_finished())
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

        // Kill and reap the child process.
        let child_opt = {
            let mut guard = self.child.lock().await;
            guard.take()
        };

        if let Some(mut child) = child_opt {
            if let Err(e) = child.start_kill() {
                warn!(
                    "failed to kill tmux control mode process for session {}: {}",
                    self.session_name, e
                );
            }
            match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                Ok(Ok(status)) => debug!(
                    "tmux control mode process for session {} exited with {}",
                    self.session_name, status
                ),
                Ok(Err(e)) => debug!(
                    "tmux control mode process for session {} wait error: {}",
                    self.session_name, e
                ),
                Err(_) => debug!(
                    "tmux control mode process for session {} did not exit in time",
                    self.session_name
                ),
            }
        }

        let handle_opt = {
            let mut guard = self.reader_handle.lock().await;
            guard.take()
        };

        if let Some(handle) = handle_opt {
            let _ = handle.await;
        }
    }
}

impl Drop for ControlModeClient {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.shutdown_tx.try_lock()
            && let Some(tx) = guard.take()
        {
            let _ = tx.send(());
        }

        if let Ok(mut guard) = self.stdin.try_lock() {
            let _ = guard.take();
        }

        if let Ok(mut guard) = self.child.try_lock()
            && let Some(mut child) = guard.take()
        {
            let _ = child.start_kill();
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
