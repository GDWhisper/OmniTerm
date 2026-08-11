//! 自管 pty 引擎的终端 WS 链路（Phase 2 切片 A：常驻会话）。
//!
//! 生命周期：WS 只是会话的一个「视图」——attach 时订阅输出 + 收补屏，
//! 断开只解绑订阅，会话进程由 [`super::PtyEngine`] 常驻持有；会话自身
//! 退出后引擎自动注销，下次 attach 重建（D5 过渡形态）。

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use portable_pty::PtySize;
use tokio::sync::broadcast::error::RecvError;
use tracing::{debug, error, info, warn};

use crate::AppState;
use crate::ws::terminal::{ClientControl, ServerControl, TerminalQuery};

pub async fn handle_pty_terminal(
    ws: WebSocket,
    session_id: String,
    query: TerminalQuery,
    state: AppState,
) {
    info!("terminal WS connected (pty): session={}", session_id);

    // 引擎会话键存于冻结列 tmux_session_name（过渡期两引擎共用，D10）；
    // 旧记录可能为 NULL，回退用 session_id。last_cwd 是 cwd 采样回写值（D5），
    // 重建会话时优先使用，目录已失效则回退 workspace_path。
    let row: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT workspace_path, tmux_session_name, last_cwd FROM sessions WHERE id = ?",
    )
    .bind(&session_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    let Some((workspace, engine_key, last_cwd)) = row else {
        let (mut sender, _) = ws.split();
        let msg =
            serde_json::to_string(&ServerControl::Error { message: "session not found" }).unwrap();
        let _ = sender.send(Message::Text(msg.into())).await;
        return;
    };
    let key = engine_key.unwrap_or_else(|| session_id.clone());
    let spawn_cwd = last_cwd.filter(|p| std::path::Path::new(p).is_dir()).unwrap_or(workspace);

    let size = PtySize {
        rows: query.rows.filter(|&r| r > 0 && r <= 1000).unwrap_or(24),
        cols: query.cols.filter(|&c| c > 0 && c <= 1000).unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };
    info!(
        "terminal PTY initial size: {}x{} for session={} (pty key={})",
        size.cols, size.rows, session_id, key
    );

    // resolve-or-create：后端重启/进程退出后的 attach 自动重建会话
    let attach = match state.engines.attach_pty(&key, &spawn_cwd, size).await {
        Ok(a) => a,
        Err(e) => {
            error!("failed to attach pty session {}: {}", key, e);
            let (mut sender, _) = ws.split();
            let msg = serde_json::to_string(&ServerControl::Error {
                message: "failed to start terminal",
            })
            .unwrap();
            let _ = sender.send(Message::Text(msg.into())).await;
            return;
        }
    };

    // 本连接视口尺寸生效（单视图模型：最后 attach 者决定尺寸）
    if let Err(e) = attach.resize(size) {
        warn!("initial resize failed (pty): {}", e);
    }
    // 重连重绘 nudge（herdr pty/actor/unix.rs:712-756）：rows-1 → 30ms → rows，
    // 强制 TUI（vim/htop 类）按新尺寸重绘，防补屏后花屏。新建会话不需要。
    if attach.reconnected && size.rows > 1 {
        let nudged = PtySize { rows: size.rows - 1, ..size };
        let _ = attach.resize(nudged);
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        let _ = attach.resize(size);
    }

    let (mut ws_tx, mut ws_rx) = ws.split();

    let attached_msg = serde_json::to_string(&ServerControl::Attached { session: &key }).unwrap();
    if ws_tx.send(Message::Text(attached_msg.into())).await.is_err() {
        return;
    }

    // 补屏：attach 时刻的补屏环快照（原始 ANSI 字节回放，xterm.js 直接消费）
    if !attach.replay.is_empty()
        && ws_tx.send(Message::Binary(attach.replay.clone().into())).await.is_err()
    {
        return;
    }

    // === WS binary → PTY stdin（专用写线程，写尽语义见 PtyAttach::write）===
    let (pty_in_tx, mut pty_in_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(256);
    let writer_attach = attach.clone();
    let resize_attach = attach.clone();
    let writer_key = key.clone();
    std::thread::spawn(move || {
        while let Some(data) = pty_in_rx.blocking_recv() {
            if let Err(e) = writer_attach.write(&data) {
                warn!("PTY write failed (pty session {writer_key}): {e}");
                return;
            }
        }
        debug!("PTY writer exited (pty session {writer_key})");
    });

    // === 输出订阅 → WS binary 帧 ===
    let mut rx = attach.rx;
    let mut forward_handle = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(data) => {
                    if ws_tx.send(Message::Binary(data.into())).await.is_err() {
                        break;
                    }
                }
                // 慢消费丢帧保连接；丢的屏面由下次补屏兜底（切片 B）
                Err(RecvError::Lagged(n)) => {
                    warn!("pty output lagged, dropped {n} frames");
                    continue;
                }
                // 会话进程退出、引擎注销 → 关闭本连接（前端重连会重建会话）
                Err(RecvError::Closed) => break,
            }
        }
    });

    // === WS 消息读循环（输入 + resize + ping）===
    let mut read_handle = tokio::spawn(async move {
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
                                if cols > 0 && cols <= 1000 && rows > 0 && rows <= 1000 {
                                    let new_size =
                                        PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };
                                    if let Err(e) = resize_attach.resize(new_size) {
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

    tokio::select! {
        _ = &mut forward_handle => {
            debug!("PTY→WS forward ended (pty): session={key}");
        }
        _ = &mut read_handle => {
            debug!("WS→PTY read ended (pty): session={key}");
        }
    }
    // 会话常驻：输出生流不会随连接结束，两个 task 都必须显式终止，
    // 否则败者会守着已死的 WS/通道泄漏（read 侧 drop in_tx 同时让写线程退出）。
    forward_handle.abort();
    read_handle.abort();

    // detach 语义：不杀会话进程，引擎常驻持有（D5/§1.2）
    info!("terminal WS disconnected (pty): session={session_id} — 会话进程保持常驻");
}
