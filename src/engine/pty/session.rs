use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io;
use std::sync::{Arc, Mutex};

use crate::engine::pty_io::write_pty;

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
/// Holds the master side, child handle and pid. The slave side is handed off
/// to the spawned child. The engine takes the child via [`PtySession::take_child`]
/// to reap it (exit detection); `kill` performs best-effort SIGHUP.
pub struct PtySession {
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    child_pid: Option<u32>,
}

impl PtySession {
    /// Open a new PTY and spawn `cmd`.
    pub fn spawn(cmd: CommandBuilder, size: PtySize) -> PtyResult<Self> {
        let pty_system = native_pty_system();
        let pty_pair = pty_system.openpty(size).map_err(|e| PtyError::Open(e.to_string()))?;

        let child =
            pty_pair.slave.spawn_command(cmd).map_err(|e| PtyError::Spawn(e.to_string()))?;

        let child_pid = child.process_id();
        let master = Arc::new(Mutex::new(Some(pty_pair.master)));

        Ok(Self { master, child: Mutex::new(Some(child)), child_pid })
    }

    /// Child pid（spawn 时记录；进程树识别/cwd 采样/清理用它）。
    pub fn child_pid(&self) -> Option<u32> {
        self.child_pid
    }

    /// 交出 child 句柄供调用方收割（`wait` 检测退出，避免僵尸）。
    /// 只能取一次；取走后本结构不再持有 child。
    pub fn take_child(&self) -> Option<Box<dyn Child + Send + Sync>> {
        self.child.lock().ok().and_then(|mut g| g.take())
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

    /// Clone the master reader for a read loop.
    pub fn try_clone_reader(&self) -> PtyResult<Box<dyn io::Read + Send>> {
        let guard = self.master.lock().map_err(|e| PtyError::Io(format!("mutex poisoned: {e}")))?;
        if let Some(master) = guard.as_ref() {
            Ok(master.try_clone_reader().map_err(|e| PtyError::Io(e.to_string()))?)
        } else {
            Err(PtyError::Io("master already taken".into()))
        }
    }

    /// 关闭 master（drop fd）。读循环收到 EOF/EIO 退出，写侧后续写入 EBADF。
    pub fn close_master(&self) {
        if let Ok(mut guard) = self.master.lock() {
            guard.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::pty_io;
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
        let mut child = session.take_child().expect("child handle");
        pty_io::kill_session_process(session.child_pid().unwrap());
        // 收割 child：kill 后 wait 必须返回（进程可被检测退出，无僵尸）
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        panic!("child did not exit after SIGHUP");
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => panic!("try_wait failed: {e}"),
            }
        }
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
        let mut child = session.take_child().expect("child handle");
        let _ = child.wait();
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
        let mut child = session.take_child().expect("child handle");
        pty_io::kill_session_process(session.child_pid().unwrap());
        let _ = child.wait();
    }
}
