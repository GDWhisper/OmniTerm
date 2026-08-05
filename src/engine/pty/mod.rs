use std::sync::{Arc, Mutex};
use tokio::task::spawn_blocking;
use tracing::debug;

use crate::tmux::pty;

#[allow(dead_code)]
pub struct PtyEngine;

#[allow(dead_code)]
impl PtyEngine {
    pub fn new() -> Self {
        Self
    }

    pub async fn spawn_command(
        &self,
        cmd: portable_pty::CommandBuilder,
        size: portable_pty::PtySize,
    ) -> anyhow::Result<PtySessionHandle> {
        let session = pty::PtySession::spawn(cmd, size)?;
        let mut reader = session.try_clone_reader()?;
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);

        let session = Arc::new(Mutex::new(Some(session)));
        let reader_session = session.clone();
        spawn_blocking(move || {
            use std::io::Read;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            debug!("pty engine reader exited");
            drop(reader_session.lock());
        });

        Ok(PtySessionHandle { session, rx })
    }
}

#[allow(dead_code)]
pub struct PtySessionHandle {
    session: Arc<Mutex<Option<pty::PtySession>>>,
    rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
}

#[allow(dead_code)]
impl PtySessionHandle {
    pub fn rx(&mut self) -> &mut tokio::sync::mpsc::Receiver<Vec<u8>> {
        &mut self.rx
    }

    pub fn write(&self, data: &[u8]) -> anyhow::Result<usize> {
        self.session
            .lock()
            .map_err(|_| anyhow::anyhow!("pty session mutex poisoned"))?
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("pty session already taken"))?
            .write(data)
            .map_err(Into::into)
    }

    pub fn resize(&self, size: portable_pty::PtySize) -> anyhow::Result<()> {
        self.session
            .lock()
            .map_err(|_| anyhow::anyhow!("pty session mutex poisoned"))?
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("pty session already taken"))?
            .resize(size)
            .map_err(Into::into)
    }

    pub fn kill(&self) {
        if let Ok(guard) = self.session.lock()
            && let Some(session) = guard.as_ref()
        {
            session.kill();
        }
    }
}

impl Drop for PtySessionHandle {
    fn drop(&mut self) {
        self.kill();
        if let Ok(mut guard) = self.session.lock() {
            guard.take();
        }
        debug!("pty engine session dropped");
    }
}
