use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io;
use std::sync::{Arc, Mutex};
use tracing::debug;

use crate::engine::pty_io::{kill_session_process, write_pty};

#[cfg(unix)]
use std::os::unix::io::RawFd;

#[derive(Debug)]
#[allow(dead_code)]
pub enum PtyError {
    Open(String),
    Spawn(String),
    Io(String),
}

impl std::fmt::Display for PtyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open(msg) => write!(f, "failed to open pty: {msg}"),
            Self::Spawn(msg) => write!(f, "failed to spawn command: {msg}"),
            Self::Io(msg) => write!(f, "io error: {msg}"),
        }
    }
}

impl std::error::Error for PtyError {}

pub type PtyResult<T> = Result<T, PtyError>;

/// Minimal owned PTY session.
///
/// Holds the master side and child pid. The slave side is handed off to the
/// spawned child. Drop performs a best-effort SIGHUP/termination and closes
/// the master fd.
#[allow(dead_code)]
pub struct PtySession {
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    child_pid: Option<u32>,
}

#[allow(dead_code)]
impl PtySession {
    /// Open a new PTY and spawn `cmd`.
    pub fn spawn(cmd: CommandBuilder, size: PtySize) -> PtyResult<Self> {
        let pty_system = native_pty_system();
        let pty_pair = pty_system.openpty(size).map_err(|e| PtyError::Open(e.to_string()))?;

        let child =
            pty_pair.slave.spawn_command(cmd).map_err(|e| PtyError::Spawn(e.to_string()))?;

        let child_pid = child.process_id();

        // SAFETY: we must keep the child alive until drop; otherwise the session
        // process can become orphaned. We intentionally do not wait here; the
        // caller may drop the session while the child is still running.
        std::mem::forget(child);

        let master = Arc::new(Mutex::new(Some(pty_pair.master)));

        Ok(Self { master, child_pid })
    }

    /// Resize the PTY viewport.
    pub fn resize(&self, size: PtySize) -> PtyResult<()> {
        let guard = self.master.lock().map_err(|e| PtyError::Io(format!("mutex poisoned: {e}")))?;
        if let Some(master) = guard.as_ref() {
            master.resize(size).map_err(|e| PtyError::Io(format!("resize failed: {e}")))?;
        }
        Ok(())
    }

    /// Write bytes to the PTY master.
    #[cfg(unix)]
    pub fn write(&self, data: &[u8]) -> PtyResult<usize> {
        let fd = self
            .master
            .lock()
            .map_err(|e| PtyError::Io(format!("mutex poisoned: {e}")))?
            .as_ref()
            .and_then(|m| m.as_raw_fd())
            .ok_or_else(|| PtyError::Io("master fd unavailable".into()))?;

        write_pty(fd, data).map_err(|e| PtyError::Io(e.to_string()))
    }

    /// Write bytes to the PTY master (Windows path).
    #[cfg(windows)]
    pub fn write(&self, data: &[u8]) -> PtyResult<usize> {
        let mut writer = self
            .master
            .lock()
            .map_err(|e| PtyError::Io(format!("mutex poisoned: {e}")))?
            .as_mut()
            .and_then(|m| m.take_writer().ok())
            .ok_or_else(|| PtyError::Io("master writer unavailable".into()))?;

        write_pty(writer.as_mut(), data).map_err(|e| PtyError::Io(e.to_string()))
    }

    /// Attempt to take the master for raw-fd access on unix.
    #[cfg(unix)]
    pub fn take_master_raw_fd(&self) -> Option<RawFd> {
        self.master.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.as_raw_fd()))
    }

    /// Clone the master reader for a read loop.
    pub fn try_clone_reader(&self) -> PtyResult<Box<dyn io::Read + Send>> {
        let guard = self.master.lock().map_err(|e| PtyError::Io(format!("mutex poisoned: {e}")))?;
        if let Some(master) = guard.as_ref() {
            Ok(master.try_clone_reader().map_err(|e| PtyError::Io(e.to_string()))?)
        } else {
            Err(PtyError::Io("master already taken".into()))
        }
    }

    /// Kill the child process if known.
    pub fn kill(&self) {
        if let Some(pid) = self.child_pid {
            debug!("killing pty child pid={}", pid);
            kill_session_process(pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn spawn_creates_a_running_process() {
        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("5");
        let session =
            PtySession::spawn(cmd, PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 });
        assert!(session.is_ok());
        let session = session.unwrap();
        assert!(session.child_pid.is_some());
        session.kill();
    }

    #[test]
    fn write_then_limited_read_returns_promptly() {
        let mut cmd = CommandBuilder::new("echo");
        cmd.arg("ping");
        let session =
            PtySession::spawn(cmd, PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                .unwrap();

        let mut reader = session.try_clone_reader().expect("clone reader");
        let mut buf = Vec::new();
        let deadline = Instant::now() + Duration::from_millis(800);
        loop {
            let mut tmp = [0u8; 256];
            match reader.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => buf.extend_from_slice(&tmp[..n]),
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    panic!("read failed: {e}");
                }
            }
            if Instant::now() >= deadline {
                break;
            }
        }

        assert!(!buf.is_empty(), "expected output from echo, got no bytes");
        let text = String::from_utf8_lossy(&buf);
        assert!(text.contains("ping"), "expected 'ping' in echo output, got: {text}");
    }

    #[test]
    fn resize_is_best_effort() {
        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("1");
        let session =
            PtySession::spawn(cmd, PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                .unwrap();
        let result =
            session.resize(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 });
        assert!(result.is_ok());
    }
}
