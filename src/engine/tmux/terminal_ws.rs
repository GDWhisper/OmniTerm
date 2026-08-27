//! 冻结复用器引擎的终端 WS attach 链路：经 portable-pty 拉起复用器客户端，
//! 终端 I/O 全走 PTY，control-mode/agent option 走引擎注册表。

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
#[cfg(unix)]
use std::os::unix::io::RawFd;
use std::sync::{Arc, Mutex};
use tracing::{debug, error, info, warn};

use crate::AppState;
use crate::engine::pty_io;
use crate::models::session::RuntimeKind;
use crate::ws::terminal::{ClientControl, ServerControl, TerminalQuery};
use std::time::Duration;
use tokio::sync::oneshot;

/// tmux 默认 escape-time 500ms 会导致:1) 孤立 ESC 延迟 500ms 才转发给 pane;
/// 2) 500ms 内连按两次 ESC 被合并为 Alt+ESC(`\x1b\x1b`)一次转发,使 agent TUI
/// (如 opencode)的 "esc again to interrupt" 中止流程失效。取 10ms 而非 0,
/// 避免慢速链路上转义序列被拆断误判为孤立 ESC。
const TMUX_ESCAPE_TIME_MS: &str = "10";

/// Build the tmux client command spawned on the PTY: set server-level
/// escape-time, then create-or-attach the target session.
#[cfg(unix)]
fn build_tmux_attach_cmd(tmux_name: &str, cwd: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("tmux");
    cmd.args([
        "set-option",
        "-s",
        "escape-time",
        TMUX_ESCAPE_TIME_MS,
        ";",
        "new-session",
        "-A",
        "-s",
        tmux_name,
    ]);
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd
}

/// Windows (psmux) 版本：不可与 set-option 用 `;` 链式组合。
///
/// 多实现差异（AGENTS §8）：tmux 的链式命令仍会进入交互 attach；而 psmux
/// 一旦命令行含多条命令就进入一次性命令模式，执行完直接退出 (exit 0)，
/// 终端只剩 "[attached]" 提示无任何输出。escape-time 改由
/// `apply_escape_time_workaround` 单独一次性设置。
#[cfg(windows)]
fn build_tmux_attach_cmd(tmux_name: &str, cwd: &str) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("tmux");
    cmd.args(["new-session", "-A", "-s", tmux_name]);
    cmd.cwd(cwd);
    cmd.env("TERM", "xterm-256color");
    cmd
}

/// Windows (psmux)：链式命令不可用（见 `build_tmux_attach_cmd`），改用单独的
/// 一次性命令设置 escape-time。fail-silent：server 未运行时失败不阻断 attach
/// （随后的 new-session -A 会拉起 server，只是首次使用默认 escape-time）。
///
/// 性能：一次性 psmux 命令实测 ~40ms，若每次 attach 都串行等待会拖慢会话
/// 切换。escape-time 是 server 级持久选项，设成功一次即覆盖全部会话，故：
/// 成功后置位标志、后续连接直接跳过；失败（如 server 未起）不置位、
/// 下次连接重试。调用方 fire-and-forget，不阻塞 attach 链路。
///
/// 已知边缘：psmux server 后续被杀重启后标志不会重置，新 server 回到默认
/// 500ms（仅影响 ESC 手感，不破坏功能；重启后端即恢复）。
#[cfg(windows)]
pub(crate) async fn apply_escape_time_workaround() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static APPLIED: AtomicBool = AtomicBool::new(false);
    if APPLIED.load(Ordering::Relaxed) {
        return;
    }
    match tokio::process::Command::new("tmux")
        .args(["set-option", "-s", "escape-time", TMUX_ESCAPE_TIME_MS])
        .output()
        .await
    {
        Ok(out) if out.status.success() => {
            APPLIED.store(true, Ordering::Relaxed);
        }
        Ok(out) => {
            debug!("escape-time set-option failed: {}", String::from_utf8_lossy(&out.stderr));
        }
        Err(e) => debug!("escape-time set-option spawn failed: {}", e),
    }
}

pub async fn handle_terminal(
    ws: WebSocket,
    session_id: String,
    query: TerminalQuery,
    state: AppState,
) {
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
            let msg = serde_json::to_string(&ServerControl::Error { message: "session not found" })
                .unwrap();
            let _ = sender.send(Message::Text(msg.into())).await;
            return;
        }
    };

    info!("terminal WS connected: session={} tmux={}", session_id, tmux_name);

    // Establish control mode connection to track session activity.
    // Failure is non-fatal: terminal I/O goes through a separate PTY channel.
    if let Err(e) = state.engines.track_session(RuntimeKind::Tmux, &tmux_name).await {
        warn!("failed to ensure control mode for session {}: {}", tmux_name, e);
    }

    // Check if hooks are enabled for this session
    let hook_enabled: bool = sqlx::query_as("SELECT hook_enabled FROM sessions WHERE id = ?")
        .bind(&session_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .map(|(enabled,): (bool,)| enabled)
        .unwrap_or(false);

    // Look up workspace_path for the tmux session CWD
    let cwd: Option<(String,)> = sqlx::query_as("SELECT workspace_path FROM sessions WHERE id = ?")
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
    let pty_size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };

    info!("terminal PTY initial size: {}x{} for session={}", cols, rows, session_id);

    #[cfg(windows)]
    tokio::spawn(apply_escape_time_workaround());

    // Open PTY at the correct viewport size and spawn tmux
    let pty_system = native_pty_system();
    let pty_pair = match pty_system.openpty(pty_size) {
        Ok(pair) => pair,
        Err(e) => {
            error!("failed to open PTY: {}", e);
            let (mut sender, _) = ws.split();
            let msg =
                serde_json::to_string(&ServerControl::Error { message: "failed to open PTY" })
                    .unwrap();
            let _ = sender.send(Message::Text(msg.into())).await;
            return;
        }
    };

    let cmd = build_tmux_attach_cmd(&tmux_name, &cwd);

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
    let attached_msg =
        serde_json::to_string(&ServerControl::Attached { session: &tmux_name }).unwrap();
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
    let mut ws_tx2 = ws_tx; // ws_tx moved here
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
                                debug!("PTY fd closed, writer thread exiting");
                            } else {
                                warn!("PTY write failed: {}", e);
                            }
                            return;
                        }
                    }
                }
            }
            debug!("PTY writer exited");
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
                            warn!("PTY write failed: {}", e);
                            return;
                        }
                    }
                }
            }
            debug!("PTY writer exited");
        });
    }

    // === Agent state poll task (only for hook-enabled sessions) ===
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
    let agent_tx_clone = agent_tx.clone();
    let tmux_name_clone = tmux_name.clone();
    let engines = state.engines.clone();
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
                            engines.agent_snapshot(RuntimeKind::Tmux, &tmux_name_clone),
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
                // clippy 建议把 if 折叠进 match guard，但 guard 内不能 .await，只能保持嵌套
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
                                        warn!("PTY resize failed: {}", e);
                                    }
                                }
                            }
                            ClientControl::Ping => {
                                // Pong requires ws_tx which lives in forward_handle.
                                // Client handles missing pong via timeout — low priority.
                                debug!("ping received");
                            }
                            // tmux 会话是 raw 字节直通，无 cell_frame diff 基线，
                            // 重同步请求无操作（仅 pty 引擎消费，见其读循环）。
                            ClientControl::Resync => {}
                            // tmux raw 直通无服务端 grid，历史窗口由 tmux 自身管理。
                            ClientControl::ViewportRequest { .. } => {}
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
        pty_io::kill_session_process(pid);
        debug!("sent SIGHUP to tmux client pid={}", pid);
    }

    // Drop the PTY master to close the fd. The writer thread will exit
    // on its next write attempt.
    if let Ok(mut guard) = master_pty.lock() {
        guard.take();
    }

    info!("terminal WS disconnected: session={}", session_id);
}

/// Handle terminal connection for an external tmux session (no DB record).
/// Identical to `handle_terminal` except it skips all DB lookups — the tmux
/// session name is used directly, hooks are disabled, and CWD is resolved
/// from the live tmux pane.
pub async fn handle_external_terminal(
    ws: WebSocket,
    tmux_name: String,
    query: TerminalQuery,
    state: AppState,
) {
    info!("terminal WS connected (external): tmux={}", tmux_name);

    // Establish control mode connection to track session activity.
    if let Err(e) = state.engines.track_session(RuntimeKind::Tmux, &tmux_name).await {
        warn!("failed to ensure control mode for external session {}: {}", tmux_name, e);
    }

    let _hook_enabled = false;

    // Resolve CWD from the live tmux pane (fall back to HOME)
    let cwd = state
        .engines
        .current_cwd(RuntimeKind::Tmux, &tmux_name)
        .await
        .unwrap_or_else(|_| std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()));

    // Determine initial PTY size from query params
    let cols = query.cols.filter(|&c| c > 0 && c <= 1000).unwrap_or(80);
    let rows = query.rows.filter(|&r| r > 0 && r <= 1000).unwrap_or(24);
    let pty_size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };

    info!("terminal PTY initial size: {}x{} for tmux={}", cols, rows, tmux_name);

    #[cfg(windows)]
    tokio::spawn(apply_escape_time_workaround());

    // Open PTY at the correct viewport size and spawn tmux
    let pty_system = native_pty_system();
    let pty_pair = match pty_system.openpty(pty_size) {
        Ok(pair) => pair,
        Err(e) => {
            error!("failed to open PTY: {}", e);
            let (mut sender, _) = ws.split();
            let msg =
                serde_json::to_string(&ServerControl::Error { message: "failed to open PTY" })
                    .unwrap();
            let _ = sender.send(Message::Text(msg.into())).await;
            return;
        }
    };

    let cmd = build_tmux_attach_cmd(&tmux_name, &cwd);

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

    let mut pty_reader = pty_pair.master.try_clone_reader().expect("clone reader");
    let master_pty: Arc<Mutex<Option<Box<dyn portable_pty::MasterPty>>>> =
        Arc::new(Mutex::new(Some(pty_pair.master)));

    let (mut ws_tx, mut ws_rx) = ws.split();

    let attached_msg =
        serde_json::to_string(&ServerControl::Attached { session: &tmux_name }).unwrap();
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
        debug!("PTY reader exited");
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
                Some(json_text) = agent_rx.recv() => {
                    if ws_tx2.send(Message::Text(json_text.into())).await.is_err() {
                        break;
                    }
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
                                debug!("PTY fd closed, writer thread exiting");
                            } else {
                                warn!("PTY write failed: {}", e);
                            }
                            return;
                        }
                    }
                }
            }
            debug!("PTY writer exited");
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
                            warn!("PTY write failed: {}", e);
                            return;
                        }
                    }
                }
            }
            debug!("PTY writer exited");
        });
    }

    // Agent poll task: external sessions never have hooks, so this is never started.
    // We keep the shutdown channel for symmetry but never spawn a poll task.
    let (_shutdown_tx, _shutdown_rx) = oneshot::channel::<()>();
    let agent_handle: Option<tokio::task::JoinHandle<()>> = None;

    let resize_pty = Arc::clone(&master_pty);
    let read_handle = tokio::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                // clippy 建议把 if 折叠进 match guard，但 guard 内不能 .await，只能保持嵌套
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
                                        warn!("PTY resize failed: {}", e);
                                    }
                                }
                            }
                            ClientControl::Ping => {
                                debug!("ping received");
                            }
                            // raw 字节直通，无 diff 基线可作废（见 handle_terminal 同名分支）
                            ClientControl::Resync => {}
                            // 同上：无服务端 grid，viewport 窗口由 tmux 自身管理
                            ClientControl::ViewportRequest { .. } => {}
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
            debug!("PTY→WS forward ended");
        }
        _ = read_handle => {
            debug!("WS→PTY read ended");
        }
        code = exit_rx.recv() => {
            info!("tmux process exited: {:?}", code);
        }
    }

    if let Some(handle) = agent_handle {
        let _ = handle.await;
        debug!("agent poll task joined");
    }

    if let Some(pid) = child_pid {
        pty_io::kill_session_process(pid);
        debug!("sent SIGHUP to tmux client pid={}", pid);
    }

    if let Ok(mut guard) = master_pty.lock() {
        guard.take();
    }

    info!("terminal WS disconnected (external): tmux={}", tmux_name);
}
