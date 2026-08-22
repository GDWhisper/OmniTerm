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
    let row: Option<(String, Option<String>, Option<String>, bool)> = sqlx::query_as(
        "SELECT workspace_path, tmux_session_name, last_cwd, hook_enabled FROM sessions WHERE id = ?",
    )
    .bind(&session_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    let Some((workspace, engine_key, last_cwd, hook_enabled)) = row else {
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

    // 视口尺寸已在 engine::attach 内于补屏快照前同步（单视图模型：最后
    // attach 者决定尺寸），此处无需再 resize。
    // 注意：不再做重连 resize nudge（rows-1 → 30ms → rows）。该技巧服务于
    // 「补屏=原始字节回放」时代的全量重绘型 TUI；grid 整帧重渲染落地后，
    // 同尺寸重连的补屏帧已精确，而实测 alacritty 对 shrink→expand 并非
    // 内容中性——nudge 会把屏幕上滚一行并在顶部混入历史残片，恰好污染
    // 补屏帧赖以生成的真相源。变尺寸重连由真实 resize 触发内核 SIGWINCH，
    // 全量重绘型程序自然重绘（2026-08-22 实测翻盘，见计划文档切片 B 勘误）。

    let (mut ws_tx, mut ws_rx) = ws.split();

    let attached_msg = serde_json::to_string(&ServerControl::Attached { session: &key }).unwrap();
    if ws_tx.send(Message::Text(attached_msg.into())).await.is_err() {
        return;
    }

    // 补屏：attach 时刻的补屏帧（原始字节尾 + 清可见屏 + grid 重渲染当前
    // 屏，见 engine::attach / vt.rs 补屏说明），xterm.js 直接消费
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

    // === hook 信道推送（D7）：门铃唤醒 → 回读本会话最新上报 → agent_state 帧。
    // 仅 hook 注入过的会话启用；nonce 去重与复用器轮询路径语义一致。
    let (agent_tx, mut agent_rx) = tokio::sync::mpsc::channel::<String>(16);
    let agent_handle: Option<tokio::task::JoinHandle<()>> = if hook_enabled {
        let store = state.engines.pty_agent_events();
        let push_key = key.clone();
        Some(tokio::spawn(async move {
            let mut rx = store.subscribe();
            let mut last_nonce: Option<String> = None;
            // 连接即推一次当前态（如有），与复用器轮询的首轮语义对齐
            if let Some(snap) = store.fresh_snapshot(&push_key)
                && let Some(msg) = agent_state_frame(&snap, &mut last_nonce)
                && agent_tx.send(msg).await.is_err()
            {
                return;
            }
            loop {
                if rx.changed().await.is_err() {
                    break;
                }
                let Some(snap) = store.fresh_snapshot(&push_key) else { continue };
                if let Some(msg) = agent_state_frame(&snap, &mut last_nonce)
                    && agent_tx.send(msg).await.is_err()
                {
                    break;
                }
            }
        }))
    } else {
        None
    };

    // === 输出订阅 → WS binary 帧（select 合流 hook agent_state 帧）===
    let mut rx = attach.rx;
    let mut forward_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                out = rx.recv() => match out {
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
                },
                agent_msg = agent_rx.recv() => {
                    let Some(msg) = agent_msg else { break };
                    if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
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
    if let Some(h) = agent_handle {
        h.abort();
    }

    // detach 语义：不杀会话进程，引擎常驻持有（D5/§1.2）
    info!("terminal WS disconnected (pty): session={session_id} — 会话进程保持常驻");
}

/// hook 上报 → `agent_state` WS 帧；nonce 与上次相同视为重复，返回 `None`
/// （与复用器轮询推送的 nonce 去重语义一致）。
fn agent_state_frame(
    snap: &crate::agent::state::AgentSnapshot,
    last_nonce: &mut Option<String>,
) -> Option<String> {
    if snap.agent_nonce.is_some() && snap.agent_nonce == *last_nonce {
        return None;
    }
    *last_nonce = snap.agent_nonce.clone();
    serde_json::to_string(&ServerControl::AgentState {
        agent_kind: Some(snap.agent_kind.as_str()),
        state: snap.agent_state.as_str(),
        attention_reason: snap.attention_reason.map(|r| r.as_str()),
        agent_event: snap.agent_event.as_deref(),
        agent_nonce: snap.agent_nonce.as_deref(),
    })
    .ok()
}
