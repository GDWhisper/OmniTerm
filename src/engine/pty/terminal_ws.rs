//! 自管 pty 引擎的终端 WS 链路。
//!
//! 注意：当前实现生命周期 = WS 连接期（断开即 SIGHUP），属 Phase 1 收敛的
//! 临时形态；Phase 2 切片 A 将以 PtyEngine 常驻会话（断开不杀进程 + 输出
//! 订阅 + 补屏）整体替换，勿在此基础上加功能。

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
#[cfg(unix)]
use std::os::unix::io::RawFd;
use std::sync::{Arc, Mutex};
use tracing::{debug, error, info, warn};

use crate::AppState;
use crate::engine::pty_io;
use crate::ws::terminal::{ClientControl, ServerControl, TerminalQuery};
use tokio::sync::oneshot;

pub async fn handle_pty_terminal(
    ws: WebSocket,
    session_id: String,
    query: TerminalQuery,
    state: AppState,
) {
    info!("terminal WS connected (pty): session={}", session_id);

    let cwd: String = sqlx::query_as("SELECT workspace_path FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .map(|(p,)| p)
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()));

    let pty_size = PtySize {
        rows: query.rows.filter(|&r| r > 0 && r <= 1000).unwrap_or(24),
        cols: query.cols.filter(|&c| c > 0 && c <= 1000).unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };

    info!(
        "terminal PTY initial size: {}x{} for session={}",
        pty_size.cols, pty_size.rows, session_id
    );

    #[cfg(windows)]
    tokio::spawn(crate::engine::apply_multiplexer_escape_time_workaround());

    let pty_system = native_pty_system();
    let pty_pair = match pty_system.openpty(pty_size) {
        Ok(pair) => pair,
        Err(e) => {
            error!("failed to open PTY (pty): {}", e);
            let (mut sender, _) = ws.split();
            let msg =
                serde_json::to_string(&ServerControl::Error { message: "failed to open PTY" })
                    .unwrap();
            let _ = sender.send(Message::Text(msg.into())).await;
            return;
        }
    };

    let mut cmd = CommandBuilder::new(if cfg!(windows) { "cmd.exe" } else { "bash" });
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");

    let mut child = match pty_pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            error!("failed to spawn pty shell: {}", e);
            let (mut sender, _) = ws.split();
            let msg = serde_json::to_string(&ServerControl::Error {
                message: "failed to start terminal",
            })
            .unwrap();
            let _ = sender.send(Message::Text(msg.into())).await;
            return;
        }
    };

    let mut pty_reader = pty_pair.master.try_clone_reader().expect("clone reader");
    let master_pty: Arc<Mutex<Option<Box<dyn portable_pty::MasterPty>>>> =
        Arc::new(Mutex::new(Some(pty_pair.master)));

    let (mut ws_tx, mut ws_rx) = ws.split();

    let attached_msg =
        serde_json::to_string(&ServerControl::Attached { session: &session_id }).unwrap();
    if ws_tx.send(Message::Text(attached_msg.into())).await.is_err() {
        return;
    }

    let (_agent_tx, mut agent_rx) = tokio::sync::mpsc::channel::<String>(16);
    let (pty_out_tx, mut pty_out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);

    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut buf = [0u8; 8192];
        loop {
            match pty_reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if pty_out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        debug!("PTY reader exited (pty)");
    });

    let mut ws_tx2 = ws_tx;
    let forward_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(data) = pty_out_rx.recv() => {
                    if ws_tx2.send(Message::Binary(data.into())).await.is_err() {
                        break;
                    }
                }
                Some(_json_text) = agent_rx.recv() => {
                    // Pty sessions currently have no agent state channel.
                }
                else => break,
            }
        }
    });

    let (pty_in_tx, mut pty_in_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);

    #[cfg(unix)]
    {
        let pty_fd: RawFd = master_pty
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|m| m.as_raw_fd())
            .expect("master PTY has a raw fd on unix");
        std::thread::spawn(move || {
            while let Some(data) = pty_in_rx.blocking_recv() {
                let mut written = 0;
                while written < data.len() {
                    match pty_io::write_pty(pty_fd, &data[written..]) {
                        Ok(0) => return,
                        Ok(n) => written += n,
                        Err(e) => {
                            if e.raw_os_error() == Some(libc::EBADF) {
                                debug!("PTY fd closed (pty), writer thread exiting");
                            } else {
                                warn!("PTY write failed (pty): {}", e);
                            }
                            return;
                        }
                    }
                }
            }
            debug!("PTY writer exited (pty)");
        });
    }
    #[cfg(windows)]
    {
        let writer = master_pty
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|m| m.take_writer().ok())
            .expect("master PTY has a writer on windows");
        std::thread::spawn(move || {
            let mut writer = writer;
            while let Some(data) = pty_in_rx.blocking_recv() {
                let mut written = 0;
                while written < data.len() {
                    match pty_io::write_pty(writer.as_mut(), &data[written..]) {
                        Ok(0) => return,
                        Ok(n) => written += n,
                        Err(e) => {
                            warn!("PTY write failed (pty): {}", e);
                            return;
                        }
                    }
                }
            }
            debug!("PTY writer exited (pty)");
        });
    }

    let (_shutdown_tx, _shutdown_rx) = oneshot::channel::<()>();
    let agent_handle: Option<tokio::task::JoinHandle<()>> = None;

    let resize_pty = Arc::clone(&master_pty);
    let read_handle = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                #[allow(clippy::collapsible_match)]
                Ok(Message::Binary(data)) => {
                    if pty_in_tx.send(data.to_vec()).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Text(text)) => {
                    if let Ok(ctrl) = serde_json::from_str::<ClientControl>(&text) {
                        match ctrl {
                            ClientControl::Resize { cols, rows } => {
                                if cols > 0
                                    && cols <= 1000
                                    && rows > 0
                                    && rows <= 1000
                                    && let Ok(guard) = resize_pty.lock()
                                    && let Some(master) = guard.as_ref()
                                {
                                    let new_size =
                                        PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
                                    if let Err(e) = master.resize(new_size) {
                                        warn!("PTY resize failed (pty): {}", e);
                                    }
                                }
                            }
                            ClientControl::Ping => {
                                debug!("ping received (pty)");
                            }
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Err(_) => break,
                _ => {}
            }
        }
    });

    let child_pid = child.process_id();
    let (exit_tx, mut exit_rx) = tokio::sync::mpsc::channel::<Option<i32>>(1);
    tokio::task::spawn_blocking(move || {
        let status = child.wait();
        let code = status.ok().map(|s| s.exit_code() as i32);
        let _ = exit_tx.blocking_send(code);
    });

    tokio::select! {
        _ = forward_handle => {
            debug!("PTY->WS forward ended (pty)");
        }
        _ = read_handle => {
            debug!("WS->PTY read ended (pty)");
        }
        code = exit_rx.recv() => {
            info!("pty process exited: {:?}", code);
        }
    }

    if let Some(handle) = agent_handle {
        let _ = handle.await;
        debug!("agent poll task joined (pty)");
    }

    if let Some(pid) = child_pid {
        pty_io::kill_session_process(pid);
        debug!("sent SIGHUP to pty pid={}", pid);
    }

    if let Ok(mut guard) = master_pty.lock() {
        guard.take();
    }

    info!("terminal WS disconnected (pty): session={}", session_id);
}
