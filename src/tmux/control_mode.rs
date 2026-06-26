use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex, RwLock};
use tokio::task::JoinHandle;
use tracing::{debug, error, warn};

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

        let mut child = Command::new("tmux")
            .args(["-C", "attach-session", "-t", &session_name])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                anyhow!(
                    "failed to spawn tmux control mode for session {}: {}",
                    session_name,
                    e
                )
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("tmux control mode stdin not available"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("tmux control mode stdout not available"))?;

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
    pub async fn pid(&self) -> Option<u32> {
        let guard = self.child.lock().await;
        guard.as_ref()?.id()
    }

    /// Start the async reader task that watches for `%output` events.
    pub async fn listen(&self) -> Result<()> {
        let mut stdout_guard = self.stdout.lock().await;
        let reader = stdout_guard
            .take()
            .ok_or_else(|| anyhow!("control mode reader already started"))?;

        let (tx, rx) = oneshot::channel();
        let last_output_at = Arc::clone(&self.last_output_at);
        let handle = tokio::spawn(reader_loop(reader, last_output_at, rx));

        let mut handle_guard = self.reader_handle.lock().await;
        *handle_guard = Some(handle);

        let mut shutdown_guard = self.shutdown_tx.lock().await;
        *shutdown_guard = Some(tx);

        Ok(())
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
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
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
        if let Ok(mut guard) = self.shutdown_tx.try_lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }

        if let Ok(mut guard) = self.stdin.try_lock() {
            let _ = guard.take();
        }

        if let Ok(mut guard) = self.child.try_lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.start_kill();
            }
        }
    }
}

async fn reader_loop(
    mut reader: BufReader<ChildStdout>,
    last_output_at: Arc<Mutex<Option<Instant>>>,
    mut shutdown: oneshot::Receiver<()>,
) {
    let mut line = String::new();

    loop {
        line.clear();

        tokio::select! {
            _ = &mut shutdown => break,
            result = reader.read_line(&mut line) => {
                match result {
                    Ok(0) => break,
                    Ok(_) => {
                        if line.starts_with("%output") {
                            let mut guard = last_output_at.lock().await;
                            *guard = Some(Instant::now());
                            debug!("tmux control mode %output event received");
                        }
                    }
                    Err(e) => {
                        debug!("tmux control mode read error: {}", e);
                        break;
                    }
                }
            }
        }
    }

    debug!("tmux control mode reader loop exited");
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
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            timeout,
        }
    }

    /// Ensure a control-mode connection exists for `session_name`.
    pub async fn ensure_session(&self, session_name: &str) -> Result<()> {
        let exists = { self.clients.read().await.contains_key(session_name) };
        if exists {
            return Ok(());
        }

        let client = ControlModeClient::new(session_name).await?;
        client.listen().await?;

        let mut clients = self.clients.write().await;
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

    async fn create_test_tmux_session(name: &str) {
        let output = Command::new("tmux")
            .args(["new-session", "-d", "-s", name])
            .output()
            .await
            .expect("tmux should be available");
        assert!(output.status.success(), "failed to create tmux session: {:?}", output);
    }

    async fn kill_test_tmux_session(name: &str) {
        let _ = Command::new("tmux")
            .args(["kill-session", "-t", name])
            .output()
            .await;
    }

    #[tokio::test]
    async fn control_mode_client_detects_output_and_timeout() {
        let name = format!("omniterm_test_active_{}", Uuid::new_v4());
        create_test_tmux_session(&name).await;

        let client = ControlModeClient::new(&name).await.expect("client should start");
        client.listen().await.expect("listener should start");

        let timeout = Duration::from_secs(2);

        // Initially inactive.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!client.is_active(timeout).await);

        // Send output to the session.
        let output = Command::new("tmux")
            .args(["send-keys", "-t", &name, "echo hello", "Enter"])
            .output()
            .await
            .expect("send-keys should succeed");
        assert!(output.status.success());

        // Allow time for the %output event to be read.
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(client.is_active(timeout).await);

        // Wait past the timeout.
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert!(!client.is_active(timeout).await);

        client.stop().await;
        kill_test_tmux_session(&name).await;
    }

    #[tokio::test]
    async fn control_mode_client_cleans_up_child() {
        let name = format!("omniterm_test_cleanup_{}", Uuid::new_v4());
        create_test_tmux_session(&name).await;

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
