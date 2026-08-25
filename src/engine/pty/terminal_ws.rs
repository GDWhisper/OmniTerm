//! 自管 pty 引擎的终端 WS 链路（Phase 2 切片 A：常驻会话）。
//!
//! 生命周期：WS 只是会话的一个「视图」——attach 时订阅输出 + 收补屏，
//! 断开只解绑订阅，会话进程由 [`super::PtyEngine`] 常驻持有；会话自身
//! 退出后引擎自动注销，下次 attach 重建（D5 过渡形态）。

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use portable_pty::PtySize;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::broadcast::error::RecvError;
use tracing::{debug, error, info, warn};

use crate::AppState;
use crate::engine::pty::events::SemanticEvent;
use crate::ws::terminal::{ClientControl, ServerControl, TerminalQuery};

use serde::Deserialize;

/// Cell-frame capability handshake from frontend (§4.2 hello frame).
#[derive(Debug, Deserialize)]
struct ClientHello {
    t: String,
    supports_cell_frame: bool,
}

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

    // === 输出转发（cell_frame / raw binary fallback + hook agent_state 帧）===
    let cell_frame_enabled = Arc::new(AtomicBool::new(false));
    // forward handle 专用克隆（避免 session_id 被 move）
    let fwd_cfe = cell_frame_enabled.clone();
    let session_id_for_frame = session_id.clone();
    let encode_attach = attach.clone();

    let mut rx = attach.rx;
    let mut event_rx = attach.event_rx;
    let mut forward_handle = tokio::spawn(async move {
        // Cell-frame 模式：30fps 定时器（懒初始化，hello 握手激活）
        let mut ticker: Option<tokio::time::Interval> = None;

        // 编码当前 grid 为 cell_frame JSON。读循环先 feed grid 再广播
        // （out/vt 同锁原子），故收到 raw bytes 时 grid 已是最新，可立即编码。
        let encode_now = || {
            let mut vt_guard = encode_attach.state.vt.lock().unwrap();
            vt_guard.encode_cell_frame(&session_id_for_frame)
        };

        loop {
            // 懒初始化：前端 hello 握手激活 cell_frame 模式时启动编码定时器
            if fwd_cfe.load(Ordering::Relaxed) && ticker.is_none() {
                ticker = Some(tokio::time::interval(std::time::Duration::from_millis(33)));
                info!("cell_frame encoder started: session={session_id_for_frame}");
            }

            if let Some(ref mut tick) = ticker {
                // ── Cell-frame 模式：定时器驱动 VT grid 编码 ──
                tokio::select! {
                    biased;
                    // agent_state 帧优先级最高
                    agent_msg = agent_rx.recv() => {
                        let Some(msg) = agent_msg else { break };
                        if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                    // Phase 2: semantic 事件 → overlay cell_frame
                    event = event_rx.recv() => {
                        if let Ok(ev) = event {
                            // alt-screen 切换需要前端清屏重绘
                            let needs_overlay = matches!(ev, SemanticEvent::AltScreenEnter | SemanticEvent::AltScreenExit);
                            if needs_overlay {
                                // Encode overlay + invalidate diff inside the lock (mut borrow),
                                // then drop the guard before the await point to keep the
                                // spawned future Send.
                                let json = {
                                    let mut vt_guard = encode_attach.state.vt.lock().unwrap();
                                    let json = vt_guard.encode_overlay_frame(&session_id_for_frame);
                                    vt_guard.invalidate_diff();
                                    json
                                };
                                if ws_tx.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    // 排干 raw bytes + 立即编码推送：消除最长 33ms 的 tick
                    // 盲区（连按回车时行「攒一批突然出现」的根因）
                    _ = rx.recv() => {
                        let json = encode_now();
                        if ws_tx.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                    // 30fps tick：兜底（无变化时是空 diff 帧，前端无副作用）
                    _ = tick.tick() => {
                        let json = encode_now();
                        if ws_tx.send(Message::Text(json.into())).await.is_err() {
                            break;
                        }
                    }
                }
            } else {
                // ── Raw binary 模式（legacy，不变）──
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
                        // 会话进程退出、引擎注销 → 关闭本连接
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
        }
    });

    // === WS 消息读循环（输入 + resize + ping）===
    let read_cfe = cell_frame_enabled.clone();
    let read_session_id = session_id.clone();
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
                    // Phase 1: cell_frame 能力握手
                    if let Ok(hello) = serde_json::from_str::<ClientHello>(&text) {
                        if hello.t == "hello" && hello.supports_cell_frame {
                            read_cfe.store(true, Ordering::Relaxed);
                            info!("cell_frame enabled: session={}", read_session_id);
                        }
                        continue;
                    }
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
                            ClientControl::Resync => {
                                // 前端丢帧后重同步：作废 diff 基线，下一帧发全帧。
                                // vt 为会话共享，全帧对其他连接同样安全。
                                resize_attach.state.vt.lock().unwrap().invalidate_diff();
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
