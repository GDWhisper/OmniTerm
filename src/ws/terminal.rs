use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::{Arc, Mutex};
use tracing::{debug, error, info, warn};

use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum ClientControl {
    #[serde(rename = "resize")]
    Resize { cols: u16, rows: u16 },
    #[serde(rename = "ping")]
    Ping,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum ServerControl<'a> {
    #[serde(rename = "attached")]
    Attached { session: &'a str },
    #[serde(rename = "pong")]
    Pong,
    #[serde(rename = "error")]
    Error { message: &'a str },
    #[serde(rename = "exit")]
    Exit { code: Option<i32> },
}

#[derive(Debug, Deserialize)]
pub struct TerminalQuery {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// WebSocket upgrade handler for terminal connections.
/// Accepts optional `cols` and `rows` query params for initial PTY size.
pub async fn ws_terminal_handler(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    Query(query): Query<TerminalQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_terminal(socket, session_id, query, state))
}

async fn handle_terminal(ws: WebSocket, session_id: String, query: TerminalQuery, state: AppState) {
    // Look up the session
    let tmux_name: Option<(String,)> =
        sqlx::query_as("SELECT tmux_session_name FROM sessions WHERE id = ?")
            .bind(&session_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

    let tmux_name = match tmux_name {
        Some((name,)) => name,
        None => {
            let (mut sender, _) = ws.split();
            let msg = serde_json::to_string(&ServerControl::Error {
                message: "session not found",
            })
            .unwrap();
            let _ = sender.send(Message::Text(msg.into())).await;
            return;
        }
    };

    info!("terminal WS connected: session={} tmux={}", session_id, tmux_name);

    // Look up workspace_path for the tmux session CWD
    let cwd: Option<(String,)> = sqlx::query_as(
        "SELECT workspace_path FROM sessions WHERE id = ?",
    )
    .bind(&session_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    let cwd = cwd
        .map(|(p,)| p)
        .unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()));

    // Determine initial PTY size from query params (like tmuxes does),
    // falling back to 80x24 if not provided.
    let cols = query.cols.filter(|&c| c > 0 && c <= 1000).unwrap_or(80);
    let rows = query.rows.filter(|&r| r > 0 && r <= 1000).unwrap_or(24);
    let pty_size = PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    };

    info!(
        "terminal PTY initial size: {}x{} for session={}",
        cols, rows, session_id
    );

    // Open PTY at the correct viewport size and spawn tmux
    let pty_system = native_pty_system();
    let pty_pair = match pty_system.openpty(pty_size) {
        Ok(pair) => pair,
        Err(e) => {
            error!("failed to open PTY: {}", e);
            let (mut sender, _) = ws.split();
            let msg = serde_json::to_string(&ServerControl::Error {
                message: "failed to open PTY",
            })
            .unwrap();
            let _ = sender.send(Message::Text(msg.into())).await;
            return;
        }
    };

    let mut cmd = CommandBuilder::new("tmux");
    cmd.args(["new-session", "-A", "-s", &tmux_name]);
    cmd.cwd(&cwd);
    cmd.env("TERM", "xterm-256color");

    let mut child = match pty_pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            error!("failed to spawn tmux: {}", e);
            let (mut sender, _) = ws.split();
            let msg = serde_json::to_string(&ServerControl::Error {
                message: "failed to start terminal",
            })
            .unwrap();
            let _ = sender.send(Message::Text(msg.into())).await;
            return;
        }
    };

    // Take PTY reader/writer, keep master alive for resize
    let mut pty_reader = pty_pair.master.try_clone_reader().expect("clone reader");
    let pty_writer = pty_pair.master.take_writer().expect("take writer");
    let master_pty: Arc<Mutex<Option<Box<dyn portable_pty::MasterPty>>>> =
        Arc::new(Mutex::new(Some(pty_pair.master)));

    // Split WS into sender/receiver
    let (mut ws_tx, mut ws_rx) = ws.split();

    // Send attached confirmation
    let attached_msg = serde_json::to_string(&ServerControl::Attached {
        session: &tmux_name,
    })
    .unwrap();
    if ws_tx.send(Message::Text(attached_msg.into())).await.is_err() {
        return;
    }

    // === PTY stdout → WS binary frames ===
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
        debug!("PTY reader exited");
    });

    let forward_handle = tokio::spawn(async move {
        while let Some(data) = pty_out_rx.recv().await {
            if ws_tx.send(Message::Binary(data.into())).await.is_err() {
                break;
            }
        }
    });

    // === WS binary → PTY stdin ===
    let (pty_in_tx, mut pty_in_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);

    let pty_writer = std::sync::Mutex::new(pty_writer);
    std::thread::spawn(move || {
        while let Some(data) = pty_in_rx.blocking_recv() {
            let mut writer = pty_writer.lock().unwrap();
            if writer.write_all(&data).is_err() {
                break;
            }
        }
        debug!("PTY writer exited");
    });

    // === WS message read loop (handles input + resize + ping) ===
    let resize_pty = Arc::clone(&master_pty);
    let read_handle = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    if pty_in_tx.send(data.to_vec()).await.is_err() {
                        break;
                    }
                }
                Ok(Message::Text(text)) => {
                    if let Ok(ctrl) = serde_json::from_str::<ClientControl>(&text) {
                        match ctrl {
                            ClientControl::Resize { cols, rows } => {
                                if cols > 0 && cols <= 1000 && rows > 0 && rows <= 1000 {
                                    if let Ok(guard) = resize_pty.lock() {
                                        if let Some(master) = guard.as_ref() {
                                            let new_size = PtySize {
                                                rows,
                                                cols,
                                                pixel_width: 0,
                                                pixel_height: 0,
                                            };
                                            if let Err(e) = master.resize(new_size) {
                                                warn!("PTY resize failed: {}", e);
                                            }
                                        }
                                    }
                                }
                            }
                            ClientControl::Ping => {
                                // Pong requires ws_tx which lives in forward_handle.
                                // Client handles missing pong via timeout — low priority.
                                debug!("ping received");
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

    // === Child exit watcher ===
    // Save PID before moving child into the exit watcher thread.
    let child_pid = child.process_id();
    let (exit_tx, mut exit_rx) = tokio::sync::mpsc::channel::<Option<i32>>(1);
    tokio::task::spawn_blocking(move || {
        let status = child.wait();
        let code = status.ok().map(|s| s.exit_code() as i32);
        let _ = exit_tx.blocking_send(code);
    });

    // Wait for any task to finish, then clean up
    tokio::select! {
        _ = forward_handle => {
            debug!("PTY→WS forward ended");
        }
        _ = read_handle => {
            debug!("WS→PTY read ended");
        }
        code = exit_rx.recv() => {
            info!("tmux process exited: {:?}", code);
        }
    }

    // Explicitly send SIGHUP to the tmux client process BEFORE dropping the PTY
    // master. This mirrors tmuxes' ptyProc.kill() approach and ensures clean
    // detachment without the extra \n+EOF that portable-pty's MasterWriter::drop
    // writes to the PTY (which can leak into the running TUI app).
    if let Some(pid) = child_pid {
        unsafe {
            libc::kill(pid as i32, libc::SIGHUP);
        }
        debug!("sent SIGHUP to tmux client pid={}", pid);
    }

    // Drop the PTY master to close file descriptors.
    if let Ok(mut guard) = master_pty.lock() {
        guard.take();
    }

    info!("terminal WS disconnected: session={}", session_id);
}
