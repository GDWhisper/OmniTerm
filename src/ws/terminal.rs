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
#[cfg(unix)]
use std::os::unix::io::RawFd;
use std::sync::{Arc, Mutex};
use tracing::{debug, error, info, warn};

use tokio::sync::oneshot;
use std::time::Duration;
use crate::AppState;
use crate::tmux;

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
    #[serde(rename = "agent_state")]
    AgentState {
        agent_kind: Option<&'a str>,
        state: &'a str,
        attention_reason: Option<&'a str>,
        agent_event: Option<&'a str>,
        agent_nonce: Option<&'a str>,
    },
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

    // Check if hooks are enabled for this session
    let hook_enabled: bool = sqlx::query_as(
        "SELECT hook_enabled FROM sessions WHERE id = ?",
    )
    .bind(&session_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .map(|(enabled,): (bool,)| enabled)
    .unwrap_or(false);

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

    // Take PTY reader, keep master alive for both resize and writing.
    //
    // We intentionally do NOT call `master.take_writer()` here. The
    // `portable_pty::MasterWriter` it returns has a `Drop` impl that writes
    // `\n + VEOF (0x04)` to the PTY fd. If that ever runs against a still-
    // alive tmux client (PTY slave), the bytes are forwarded to the pane
    // and the agent interprets `\x04` (Ctrl+D / EOF) as end-of-input,
    // aborting its current task — the user-visible bug. Drop ordering
    // (SIGHUP before master drop) is not enough: the writer holds an
    // independently-dup'd fd, so closing the master does not prevent the
    // writer's Drop from writing to its own fd.
    //
    // Instead, we keep the master for its full lifetime and use its raw
    // fd directly for input. When the master is dropped, the fd is closed
    // and the writer thread's writes start failing with EBADF, so it exits
    // cleanly without ever invoking the problematic `MasterWriter::drop`.
    let mut pty_reader = pty_pair.master.try_clone_reader().expect("clone reader");
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

    // === Agent state poll channel (for hook-enabled sessions) ===
    // Agent state text frames are sent to this channel and merged into the
    // PTY→WS forward loop, so they share the same ws_tx.
    let (agent_tx, mut agent_rx) = tokio::sync::mpsc::channel::<String>(16);

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

    // Forward loop: merge PTY output + agent state messages → WS
    let mut ws_tx2 = ws_tx;  // ws_tx moved here
    let forward_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(data) = pty_out_rx.recv() => {
                    if ws_tx2.send(Message::Binary(data.into())).await.is_err() {
                        break;
                    }
                }
                Some(json_text) = agent_rx.recv() => {
                    if ws_tx2.send(Message::Text(json_text.into())).await.is_err() {
                        break;
                    }
                }
                else => break,
            }
        }
    });

    // === WS binary → PTY stdin (via raw fd, see comment above) ===
    let (pty_in_tx, mut pty_in_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);

    // Get the master's raw fd. We capture it here (before the master is
    // moved into `master_pty`) and use it for all input writes. The fd is
    // owned by the master; when the master is dropped, the fd is closed and
    // any further writes fail with EBADF, which the writer thread handles
    // by exiting.
    let pty_fd: RawFd = master_pty
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|m| m.as_raw_fd())
        .expect("master PTY has a raw fd on unix");
    std::thread::spawn(move || {
        while let Some(data) = pty_in_rx.blocking_recv() {
            // Write directly to the fd, looping on partial writes. We
            // deliberately do NOT use any `Write`-implementing wrapper here
            // — the portable_pty `MasterWriter` writes `\n + VEOF` on drop
            // and there is no way to suppress that without leaking the fd.
            let mut written = 0;
            while written < data.len() {
                let n = unsafe {
                    libc::write(
                        pty_fd,
                        data[written..].as_ptr() as *const libc::c_void,
                        data.len() - written,
                    )
                };
                if n <= 0 {
                    // EBADF (fd closed) or error — stop the thread; the
                    // master is going away.
                    if n < 0 {
                        let errno = std::io::Error::last_os_error().raw_os_error();
                        if errno == Some(libc::EBADF) {
                            debug!("PTY fd closed, writer thread exiting");
                        } else {
                            warn!("PTY write failed: errno={:?}", errno);
                        }
                    }
                    return;
                }
                written += n as usize;
            }
        }
        debug!("PTY writer exited");
    });

    // === Agent state poll task (only for hook-enabled sessions) ===
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let agent_tx_clone = agent_tx.clone();
    let tmux_name_clone = tmux_name.clone();
    let agent_handle: Option<tokio::task::JoinHandle<()>> = if hook_enabled {
        Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut last_nonce: Option<String> = None;
            let mut consecutive_timeouts: u32 = 0;

            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        // Poll the agent option with a 2s timeout
                        let result = tokio::time::timeout(
                            Duration::from_secs(2),
                            tmux::get_session_agent_option(&tmux_name_clone),
                        )
                        .await;

                        match result {
                            Ok(Ok(Some(snapshot))) => {
                                consecutive_timeouts = 0;
                                let current_nonce = snapshot.agent_nonce.clone();
                                if current_nonce != last_nonce {
                                    last_nonce = current_nonce;
                                    let msg = serde_json::json!({
                                        "type": "agent_state",
                                        "agent_kind": snapshot.agent_kind.as_str(),
                                        "state": snapshot.agent_state.as_str(),
                                        "attention_reason": snapshot.attention_reason.map(|r| r.as_str()),
                                        "agent_event": snapshot.agent_event,
                                        "agent_nonce": snapshot.agent_nonce,
                                    });
                                    if let Ok(text) = serde_json::to_string(&msg) {
                                        let _ = agent_tx_clone.send(text).await;
                                    }
                                }
                            }
                            Ok(Ok(None)) => {
                                consecutive_timeouts = 0;
                            }
                            Ok(Err(e)) => {
                                warn!("agent poll error for {}: {}", tmux_name_clone, e);
                                consecutive_timeouts += 1;
                            }
                            Err(_elapsed) => {
                                warn!("agent poll timeout for {}", tmux_name_clone);
                                consecutive_timeouts += 1;
                            }
                        }

                        if consecutive_timeouts >= 3 {
                            warn!(
                                "agent poll stopping after {} consecutive failures for {}",
                                consecutive_timeouts, tmux_name_clone
                            );
                            let msg = serde_json::json!({
                                "type": "agent_state",
                                "state": "unknown",
                            });
                            if let Ok(text) = serde_json::to_string(&msg) {
                                let _ = agent_tx_clone.send(text).await;
                            }
                            break;
                        }
                    }
                    _ = &mut shutdown_rx => {
                        debug!("agent poll task received shutdown signal");
                        break;
                    }
                }
            }
            debug!("agent poll task exited cleanly");
        }))
    } else {
        None
    };

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

    // Send shutdown signal to agent poll task and await its exit
    let _ = shutdown_tx.send(());
    if let Some(handle) = agent_handle {
        let _ = handle.await;
        debug!("agent poll task joined");
    }

    // === Cleanup order is critical to prevent agent interruption ===
    //
    // We avoid the `MasterWriter::drop` entirely by writing via the raw
    // fd, so there is no `\n + VEOF` leak. The only thing we need to do
    // here is:
    //   1. SIGHUP the tmux client so it detaches cleanly from the session.
    //   2. Drop the PTY master. Its Drop closes the underlying fd, which
    //      causes the writer thread's blocking writes to start failing
    //      with EBADF and exit on their own.
    //
    // No writer wrapper is ever constructed, so the previous race
    // condition between SIGHUP and the writer's `\n+\x04` leak cannot
    // occur.

    if let Some(pid) = child_pid {
        unsafe {
            libc::kill(pid as i32, libc::SIGHUP);
        }
        debug!("sent SIGHUP to tmux client pid={}", pid);
    }

    // Drop the PTY master to close the fd. The writer thread will exit
    // on its next write attempt.
    if let Ok(mut guard) = master_pty.lock() {
        guard.take();
    }

    info!("terminal WS disconnected: session={}", session_id);
}
