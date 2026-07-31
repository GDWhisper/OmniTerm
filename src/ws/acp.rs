use std::sync::Arc;

use axum::{
    extract::{
        Path, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tracing::{debug, info};

use crate::AppState;
use crate::acp::chat_persistence;
use crate::acp::permission::PermissionRequestEvent;
use crate::acp::terminal::TerminalActivity;
use crate::acp::{AcpClient, ImageInput, ResourceInput, TurnEndEvent};
use crate::api::agents::load_agent;

/// 单次 prompt 图片附件上限（与前端 ChatInput 的限制一致，防止 WS 帧过大）。
const MAX_PROMPT_IMAGES: usize = 3;
/// 单次 prompt 的 `@` 文件引用上限。
const MAX_AT_REFERENCES: usize = 8;
/// 单个 `@` 引用文件注入内容上限（超出截断）。
const MAX_AT_FILE_BYTES: usize = 64 * 1024;

/// 从 prompt 文本提取 `@path` 引用。`@` 前必须是行首或空白（排除 email 等误报），
/// 去重保序，上限 [`MAX_AT_REFERENCES`]。
fn extract_at_paths(text: &str) -> Vec<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?:^|\s)@([^\s@]+)").unwrap());
    let mut out: Vec<String> = Vec::new();
    for cap in re.captures_iter(text) {
        let p = &cap[1];
        if !out.iter().any(|e| e == p) {
            out.push(p.to_string());
            if out.len() >= MAX_AT_REFERENCES {
                break;
            }
        }
    }
    out
}

/// 解析 `@path` 引用为文件内容资源：workspace 内 sanitize + 读取（≤64KB 截断）。
/// 任何失败（越界/不存在/目录/非 UTF-8）静默跳过该引用 —— 引用是增强不是硬依赖。
async fn resolve_at_references(
    db: &sqlx::SqlitePool,
    session_id: &str,
    text: &str,
) -> Vec<ResourceInput> {
    let paths = extract_at_paths(text);
    if paths.is_empty() {
        return Vec::new();
    }
    let row: Option<(String,)> = sqlx::query_as("SELECT workspace_path FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    let Some((ws_path,)) = row else {
        return Vec::new();
    };
    let base = std::path::PathBuf::from(ws_path);
    let mut out = Vec::new();
    for rel in paths {
        let abs = match crate::fs::sanitize_path(&base, &rel) {
            Ok(p) => p,
            Err(e) => {
                debug!("@ 引用跳过（路径无效）: {}: {}", rel, e);
                continue;
            }
        };
        if abs.is_dir() {
            debug!("@ 引用跳过（是目录）: {}", rel);
            continue;
        }
        let content = match tokio::fs::read_to_string(&abs).await {
            Ok(c) => c,
            Err(e) => {
                debug!("@ 引用跳过（读取失败）: {}: {}", rel, e);
                continue;
            }
        };
        let text = if content.len() > MAX_AT_FILE_BYTES {
            let mut end = MAX_AT_FILE_BYTES;
            while !content.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}\n… [content truncated at 64KB]", &content[..end])
        } else {
            content
        };
        out.push(ResourceInput { uri: format!("file://{}", abs.display()), label: rel, text });
    }
    out
}

pub async fn ws_acp_handler(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    info!("ACP WS upgrade request: session_id={}", session_id);
    ws.on_upgrade(move |socket| handle_acp_ws(socket, session_id, state))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum AcpClientMessage {
    #[serde(rename = "prompt")]
    Prompt {
        text: String,
        /// 图片附件（可选，旧前端不带此字段）。
        #[serde(default)]
        images: Vec<ImageInput>,
    },
    #[serde(rename = "cancel")]
    Cancel,
    #[serde(rename = "load_session")]
    LoadSession,
    #[serde(rename = "permission_response")]
    PermissionResponse { id: String, option_id: String },
    #[serde(rename = "set_config_option")]
    SetConfigOption { config_id: String, value: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum AcpServerMessage<'a> {
    #[serde(rename = "error")]
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<&'a str>,
        message: &'a str,
    },
    #[serde(rename = "session_update")]
    SessionUpdate {
        data: serde_json::Value,
        /// accumulator 赋予该帧的 turn 内单调 seq；非 turn 帧（config/commands/重放）为 None。
        /// 前端据此对进行中 turn 的 live 帧去重（见 turn_snapshot 帧与 useAcpChat 对账）。
        #[serde(skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
    },
    #[serde(rename = "prompt_done")]
    PromptDone { stop_reason: &'a str },
    #[serde(rename = "prompt_error")]
    PromptError { message: &'a str },
    #[serde(rename = "terminal_activity")]
    TerminalActivity {
        id: String,
        command: String,
        args: Vec<String>,
        status: String,
        exit_code: Option<u32>,
    },
    #[serde(rename = "replay_start")]
    ReplayStart,
    #[serde(rename = "replay_end")]
    ReplayEnd,
    #[serde(rename = "process_alive")]
    ProcessAlive { alive: bool },
    #[serde(rename = "permission_request")]
    PermissionRequest { id: &'a str, request: &'a serde_json::Value },
    /// 审批已解决（用户在任一连接应答 / session cancel 批量取消）：所有连接
    /// 据此清除对应 banner（审批可能由其他标签页/设备应答）。
    #[serde(rename = "permission_resolved")]
    PermissionResolved { id: &'a str },
    /// agent 能力声明（当前仅 prompt 图片能力），client 就绪时推送，
    /// 前端据此显示/隐藏附件入口。`agent_name` 为当前会话所用 agent 的
    /// `display_name`，用于聊天气泡正确显示 agent 身份（而非硬编码 "agent"）。
    #[serde(rename = "capabilities")]
    Capabilities { image: bool, agent_name: String },
    /// 连接时下发当前是否有进行中的 assistant turn。`active:false` 时前端定稿
    /// 任何残留的 streaming 消息（turn 在 WS 断开期间已结束的兜底）。
    #[serde(rename = "turn_state")]
    TurnState { active: bool },
    /// 连接时下发进行中 turn 的快照，供重连客户端无缝续接（仅 active 且已折叠过帧时）。
    /// `blocks` 是 `{"v":1,"frames":[...]}` 原始帧包裹；`seq` 为已折叠进该行的最高水位，
    /// 后续 live 帧 seq 大于它才应用（见 useAcpChat 对账）。
    #[serde(rename = "turn_snapshot")]
    TurnSnapshot { row_id: String, text: String, blocks: String, seq: u64 },
}

/// 把一条 session_update 通知序列化为 WS 帧并经 notify_tx 发出。
/// 返回 false 表示通道已关闭（WS 断开），调用方可据此提前退出。
async fn forward_session_update(
    tx: &tokio::sync::mpsc::Sender<Message>,
    notif: &crate::acp::handler::SeqNotification,
) -> bool {
    let data = serde_json::to_value(&notif.notification).unwrap_or_default();
    let frame = serde_json::to_string(&AcpServerMessage::SessionUpdate { data, seq: notif.seq })
        .unwrap_or_default();
    tx.send(Message::Text(frame.into())).await.is_ok()
}

async fn spawn_notify_task(
    mut rx: tokio::sync::broadcast::Receiver<crate::acp::handler::SeqNotification>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(seq_notif) => {
                    let data = serde_json::to_value(&seq_notif.notification).unwrap_or_default();
                    let msg = serde_json::to_string(&AcpServerMessage::SessionUpdate {
                        data,
                        seq: seq_notif.seq,
                    })
                    .unwrap_or_default();
                    if notify_tx.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        "ACP WS subscriber lagged by {} messages; dropped stale updates",
                        n
                    );
                }
            }
        }
    });
}

/// 转发 turn 结束事件为 `prompt_done` / `prompt_error` 帧。经 broadcast
/// 使所有连接（含 prompt 进行中断线重连的新连接）都能收到结束信号；
/// 旧实现只发给发起 prompt 的连接，重连后前端永远停留在 running 态。
async fn spawn_turn_end_task(
    mut rx: tokio::sync::broadcast::Receiver<TurnEndEvent>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let msg = match &event {
                        TurnEndEvent::Done { stop_reason } => {
                            serde_json::to_string(&AcpServerMessage::PromptDone { stop_reason })
                        }
                        TurnEndEvent::Error { message } => {
                            serde_json::to_string(&AcpServerMessage::PromptError { message })
                        }
                    }
                    .unwrap_or_default();
                    if notify_tx.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        "ACP turn-end subscriber lagged by {} messages; dropped stale events",
                        n
                    );
                }
            }
        }
    });
}

/// 转发 agent 进程崩溃错误：收到即作为 `prompt_error` 帧推给前端，
/// 使用户能看到崩溃原因而非仅连接断开�?
async fn spawn_crash_task(
    mut rx: tokio::sync::broadcast::Receiver<String>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(reason) => {
                    let msg =
                        serde_json::to_string(&AcpServerMessage::PromptError { message: &reason })
                            .unwrap_or_default();
                    if notify_tx.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        "ACP crash-event subscriber lagged by {} messages; dropped stale events",
                        n
                    );
                }
            }
        }
    });
}

/// 转发 agent 终端命令生命周期事件：创建/退出转为 `terminal_activity` 帧，
/// 使前端能感知 agent 在后台执行的命令（否则完全不可见）。
async fn spawn_terminal_task(
    mut rx: tokio::sync::broadcast::Receiver<TerminalActivity>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    let (id, command, args, status, exit_code) = match ev {
                        TerminalActivity::Created { id, command, args } => {
                            (id, command, args, "created".to_string(), None)
                        }
                        TerminalActivity::Exited { id, exit_code } => {
                            (id, String::new(), Vec::new(), "exited".to_string(), exit_code)
                        }
                    };
                    let msg = serde_json::to_string(&AcpServerMessage::TerminalActivity {
                        id,
                        command,
                        args,
                        status,
                        exit_code,
                    })
                    .unwrap_or_default();
                    if notify_tx.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        "ACP terminal-event subscriber lagged by {} messages; dropped stale events",
                        n
                    );
                }
            }
        }
    });
}

async fn spawn_permission_task(
    mut rx: tokio::sync::broadcast::Receiver<PermissionRequestEvent>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let msg = serde_json::to_string(&AcpServerMessage::PermissionRequest {
                        id: &event.id,
                        request: &event.request,
                    })
                    .unwrap_or_default();
                    if notify_tx.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        "ACP permission-event subscriber lagged by {} messages; dropped stale events",
                        n
                    );
                }
            }
        }
    });
}

/// 转发审批解决事件为 `permission_resolved` 帧：审批可能由其他标签页/设备
/// 应答（resolve）或经 session cancel 批量取消，所有连接都要即时清除 banner。
async fn spawn_permission_resolved_task(
    mut rx: tokio::sync::broadcast::Receiver<String>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(id) => {
                    let msg =
                        serde_json::to_string(&AcpServerMessage::PermissionResolved { id: &id })
                            .unwrap_or_default();
                    if notify_tx.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        "ACP permission-resolved subscriber lagged by {} messages; dropped stale events",
                        n
                    );
                }
            }
        }
    });
}

/// 查询 ACP 会话所用 agent 的 `display_name`（用于聊天气泡身份显示）。
/// 查不到（非 ACP 会话 / agent 缺失）时返回空串，前端回退到 "agent"。
async fn query_agent_name(db: &sqlx::SqlitePool, session_id: &str) -> String {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT a.display_name FROM sessions s JOIN agents a ON a.id = s.agent_id WHERE s.id = ? AND s.runtime_kind = 'acp'")
            .bind(session_id)
            .fetch_optional(db)
            .await
            .ok()
            .flatten();
    row.map(|(name,)| name).unwrap_or_default()
}

async fn handle_acp_ws(socket: WebSocket, session_id: String, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::channel::<Message>(64);

    let mut client: Option<Arc<AcpClient>> = match state.acp_supervisor.get(&session_id).await {
        Some(c) => {
            info!("ACP WS connected: session_id={} (supervisor hit)", session_id);
            // subscribe-before-snapshot：先订阅再取快照，消除两者之间的丢帧 gap，
            // 把重叠窗退化为 seq 可解的重复窗（前端按 seq 去重，见 turn_snapshot 帧）。
            let rx = c.session_update_subscribe();
            // 快照与 turn 帧必须先经 notify_tx 入队，再 spawn_notify_task 转发 live 帧；
            // notify_tx 为 FIFO 单消费者，故快照帧保证先于任何 live 帧到达前端。
            let snap = c.turn_snapshot();
            let ts_msg =
                serde_json::to_string(&AcpServerMessage::TurnState { active: snap.active })
                    .unwrap_or_default();
            let _ = notify_tx.send(Message::Text(ts_msg.into())).await;
            if snap.active
                && let Some(row_id) = snap.row_id
            {
                let snap_msg = serde_json::to_string(&AcpServerMessage::TurnSnapshot {
                    row_id,
                    text: snap.text,
                    blocks: snap.blocks,
                    seq: snap.seq,
                })
                .unwrap_or_default();
                let _ = notify_tx.send(Message::Text(snap_msg.into())).await;
            }
            spawn_notify_task(rx, notify_tx.clone()).await;
            let perm_rx = c.permission_subscribe();
            spawn_permission_task(perm_rx, notify_tx.clone()).await;
            spawn_permission_resolved_task(c.permission_resolved_subscribe(), notify_tx.clone())
                .await;
            // broadcast 无历史：重放连接前已挂起的审批请求，恢复前端 banner
            // （审批不再超时自动应答，可能跨 WS 重连长期未决）。
            for event in c.pending_permission_events().await {
                let msg = serde_json::to_string(&AcpServerMessage::PermissionRequest {
                    id: &event.id,
                    request: &event.request,
                })
                .unwrap_or_default();
                let _ = notify_tx.send(Message::Text(msg.into())).await;
            }
            let crash_rx = c.crash_subscribe();
            spawn_crash_task(crash_rx, notify_tx.clone()).await;
            let turn_end_rx = c.turn_end_subscribe();
            spawn_turn_end_task(turn_end_rx, notify_tx.clone()).await;
            let term_rx = c.terminal_event_subscribe();
            spawn_terminal_task(term_rx, notify_tx.clone()).await;
            if let Some(notif) = c.initial_config_notification() {
                let data = serde_json::to_value(&notif).unwrap_or_default();
                let msg =
                    serde_json::to_string(&AcpServerMessage::SessionUpdate { data, seq: None })
                        .unwrap_or_default();
                let _ = notify_tx.send(Message::Text(msg.into())).await;
            }
            if let Some(notif) = c.initial_commands_notification() {
                let data = serde_json::to_value(&notif).unwrap_or_default();
                let msg =
                    serde_json::to_string(&AcpServerMessage::SessionUpdate { data, seq: None })
                        .unwrap_or_default();
                let _ = notify_tx.send(Message::Text(msg.into())).await;
            }
            let agent_name = query_agent_name(&state.db, &session_id).await;
            let msg = serde_json::to_string(&AcpServerMessage::Capabilities {
                image: c.supports_image(),
                agent_name,
            })
            .unwrap_or_default();
            let _ = notify_tx.send(Message::Text(msg.into())).await;
            Some(c)
        }
        None => {
            info!("ACP WS: session_id={} not in supervisor, keeping alive for restore", session_id);
            let msg = serde_json::to_string(&AcpServerMessage::Error {
                code: Some("session_not_found"),
                message: "ACP session not found",
            })
            .unwrap();
            let _ = ws_tx.send(Message::Text(msg.into())).await;
            None
        }
    };

    // 订阅进程存活事件，向本连接转发对应会话的 process_alive 帧（事件驱动�?
    // 替代前端�? acp_process_alive 的轮询）�?
    let mut proc_rx = state.acp_supervisor.process_event_subscribe();
    // 连接建立即发一帧初始存活状态，作初始同步（broadcast 无历史，防止错过连接前事件）�?
    let _ = notify_tx
        .send(Message::Text(
            serde_json::to_string(&AcpServerMessage::ProcessAlive { alive: client.is_some() })
                .unwrap_or_default()
                .into(),
        ))
        .await;

    let db = state.db.clone();
    let sid = session_id.clone();

    loop {
        tokio::select! {
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<AcpClientMessage>(&text) {
                            Ok(AcpClientMessage::Prompt { text: prompt_text, images }) => {
                                let Some(ref c) = client else {
                                    let msg = serde_json::to_string(&AcpServerMessage::Error {
                                        code: Some("session_not_found"),
                                        message: "no active ACP session",
                                    }).unwrap_or_default();
                                    let _ = ws_tx.send(Message::Text(msg.into())).await;
                                    continue;
                                };

                                // 附件校验：前端已限制，这里兜底（直连 WS 的客户端）。
                                if images.len() > MAX_PROMPT_IMAGES {
                                    let msg = serde_json::to_string(&AcpServerMessage::PromptError {
                                        message: &format!("too many images (max {})", MAX_PROMPT_IMAGES),
                                    }).unwrap_or_default();
                                    let _ = ws_tx.send(Message::Text(msg.into())).await;
                                    continue;
                                }
                                if !images.is_empty() && !c.supports_image() {
                                    let msg = serde_json::to_string(&AcpServerMessage::PromptError {
                                        message: "agent does not support image input",
                                    }).unwrap_or_default();
                                    let _ = ws_tx.send(Message::Text(msg.into())).await;
                                    continue;
                                }

                                // 有图时把结构化 blocks 一并落库（text + image），
                                // 刷新后 hydrate 能还原缩略图；纯文本保持 NULL 现状。
                                let blocks_json = if images.is_empty() {
                                    None
                                } else {
                                    let mut arr = Vec::new();
                                    if !prompt_text.is_empty() {
                                        arr.push(serde_json::json!({
                                            "type": "text", "text": prompt_text,
                                        }));
                                    }
                                    for img in &images {
                                        arr.push(serde_json::json!({
                                            "type": "image",
                                            "mimeType": img.mime_type,
                                            "data": img.data,
                                        }));
                                    }
                                    serde_json::to_string(&arr).ok()
                                };
                                let _ = chat_persistence::insert_message(
                                    &db, &sid, "user", &prompt_text, blocks_json.as_deref(),
                                ).await;

                                let c = c.clone();
                                // 解析 @path 文件引用（失败静默跳过，不阻塞发送）
                                let resources = resolve_at_references(&db, &sid, &prompt_text).await;
                                // 标记 prompt 进行中（活跃度守卫据此判断 agent 在工作中）。
                                // 同时开启累积器 turn 门控；assistant 回复由累积器实时
                                // 防抖落库（见 turn_accumulator），不再依赖 WS 任务收尾累积。
                                c.mark_prompt_active();
                                tokio::spawn(async move {
                                    match c.send_prompt(&prompt_text, images, resources).await {
                                        Ok(resp) => {
                                            // mark_prompt_idle 内部定稿累积器进行中的 turn。
                                            c.mark_prompt_idle();
                                            // 经 broadcast 通知所有连接（发起连接可能已断开重连）。
                                            c.notify_turn_end(TurnEndEvent::Done {
                                                stop_reason: format!("{:?}", resp.stop_reason),
                                            });
                                        }
                                        Err(e) => {
                                            c.mark_prompt_idle();
                                            c.notify_turn_end(TurnEndEvent::Error {
                                                message: format!("{}", e),
                                            });
                                        }
                                    }
                                });
                            }
                            Ok(AcpClientMessage::Cancel) => {
                                if let Some(ref c) = client {
                                    // 取消也视�? prompt 结束
                                    c.mark_prompt_idle();
                                    if let Err(e) = c.cancel() {
                                        let err_msg = format!("取消 agent 失败: {}", e);
                                        let msg = serde_json::to_string(&AcpServerMessage::Error {
                                            code: Some("cancel_failed"),
                                            message: &err_msg,
                                        })
                                        .unwrap_or_default();
                                        let _ = notify_tx.send(Message::Text(msg.into())).await;
                                    }
                                }
                            }
                            Ok(AcpClientMessage::LoadSession) => {
                                let row: Option<(String, String, String)> = sqlx::query_as(
                                    "SELECT agent_id, acp_session_id, workspace_path FROM sessions WHERE id = ? AND runtime_kind = 'acp'",
                                )
                                .bind(&sid)
                                .fetch_optional(&db)
                                .await
                                .ok()
                                .flatten();

                                let Some((agent_id, acp_sid, ws_path)) = row else {
                                    let msg = serde_json::to_string(&AcpServerMessage::Error {
                                        code: None,
                                        message: "session row not found or not ACP",
                                    }).unwrap_or_default();
                                    let _ = ws_tx.send(Message::Text(msg.into())).await;
                                    continue;
                                };

                                let Some(agent) = load_agent(&db, &agent_id).await else {
                                    let msg = serde_json::to_string(&AcpServerMessage::Error {
                                        code: None,
                                        message: "agent config not found",
                                    }).unwrap_or_default();
                                    let _ = ws_tx.send(Message::Text(msg.into())).await;
                                    continue;
                                };

                                let cwd = std::path::PathBuf::from(&ws_path);
                                let agent_display_name = agent.display_name.clone();
                                match AcpClient::spawn_and_load(agent, cwd.clone(), acp_sid.clone()).await {
                                    Ok(new_client) => {
                                        let new_client = Arc::new(new_client);

                                        if !new_client.supports_load_session() {
                                            let msg = serde_json::to_string(&AcpServerMessage::Error {
                                                code: Some("load_not_supported"),
                                                message: "agent does not support session/load",
                                            }).unwrap_or_default();
                                            let _ = ws_tx.send(Message::Text(msg.into())).await;
                                            let c = Arc::try_unwrap(new_client).ok();
                                            if let Some(c) = c { c.disconnect().await; }
                                            continue;
                                        }

                                        // 覆盖前先回收可能残留的旧 client，避免旧进程泄漏
                                        if let Some(old) = state.acp_supervisor.dispose(&sid).await
                                            && let Ok(c) = Arc::try_unwrap(old) {
                                                c.disconnect().await;
                                            }
                                        state.acp_supervisor.insert(sid.clone(), new_client.clone()).await;
                                        // restore 出的新 client 绑定持久化：后续用户 prompt 的
                                        // assistant 回复由累积器实时防抖落库。
                                        new_client.attach_persistence(db.clone(), sid.clone());

                                        let perm_rx = new_client.permission_subscribe();
                                        spawn_permission_task(perm_rx, notify_tx.clone()).await;
                                        spawn_permission_resolved_task(
                                            new_client.permission_resolved_subscribe(),
                                            notify_tx.clone(),
                                        )
                                        .await;
                                        let crash_rx = new_client.crash_subscribe();
                                        spawn_crash_task(crash_rx, notify_tx.clone()).await;
                                        let turn_end_rx = new_client.turn_end_subscribe();
                                        spawn_turn_end_task(turn_end_rx, notify_tx.clone()).await;
                                        let term_rx = new_client.terminal_event_subscribe();
                                        spawn_terminal_task(term_rx, notify_tx.clone()).await;
                                        client = Some(new_client.clone());

                                        let cap_msg = serde_json::to_string(&AcpServerMessage::Capabilities {
                                            image: new_client.supports_image(),
                                            agent_name: agent_display_name,
                                        }).unwrap_or_default();
                                        let _ = notify_tx.send(Message::Text(cap_msg.into())).await;

                                        let replay_msg = serde_json::to_string(&AcpServerMessage::ReplayStart).unwrap_or_default();
                                        let _ = ws_tx.send(Message::Text(replay_msg.into())).await;

                                        let tx = notify_tx.clone();
                                        tokio::spawn(async move {
                                            // 在 load_session 之前订阅，确保重放期间 agent 推来的
                                            // 历史 session_update 全部可见。
                                            let mut replay_rx = new_client.session_update_subscribe();
                                            // 与 load_session 并发转发重放帧：历史帧数可能远超
                                            // broadcast 容量（256），若等 load 返回后再排空，缓冲溢出
                                            // （Lagged）会静默丢帧，长会话恢复时曾导致一帧未发。
                                            // 注意：重放不经累积器落库——重放帧无 turn 门控（begin_turn
                                            // 只由用户 prompt 触发），故不会与后续实时落库重复。
                                            let load_fut = new_client.load_session(&acp_sid, cwd);
                                            tokio::pin!(load_fut);
                                            let result = loop {
                                                tokio::select! {
                                                    r = &mut load_fut => break r,
                                                    recved = replay_rx.recv() => match recved {
                                                        Ok(notif) => {
                                                            // 发送失败说明 WS 已断：继续等 load 结束即可退出。
                                                            let _ = forward_session_update(&tx, &notif).await;
                                                        }
                                                        Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                                            tracing::warn!("ACP replay subscriber lagged by {} messages; dropped frames", n);
                                                        }
                                                        Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                                            break (&mut load_fut).await;
                                                        }
                                                    },
                                                }
                                            };
                                            // load_session 返回即 agent 已推完全部历史。排空缓冲余量后
                                            // 经 notify_tx 发 replay_end——notify_tx 为 FIFO，故 replay_end
                                            // 必在最后一条重放帧之后到达前端（前端据此即时 sync 即可）。
                                            loop {
                                                match replay_rx.try_recv() {
                                                    Ok(notif) => {
                                                        if !forward_session_update(&tx, &notif).await {
                                                            break;
                                                        }
                                                    }
                                                    Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => {
                                                        // 不中断：后续 try_recv 仍能取到缓冲里保留的帧。
                                                        tracing::warn!("ACP replay drain lagged by {} messages; dropped frames", n);
                                                    }
                                                    Err(_) => break, // Empty / Closed
                                                }
                                            }
                                            let msg = match result {
                                                Ok(()) => serde_json::to_string(&AcpServerMessage::ReplayEnd).unwrap_or_default(),
                                                Err(e) => serde_json::to_string(&AcpServerMessage::Error {
                                                    code: Some("load_failed"),
                                                    message: &format!("session/load failed: {}", e),
                                                }).unwrap_or_default(),
                                            };
                                            let _ = tx.send(Message::Text(msg.into())).await;
                                            // 复用 replay_rx 接管实时帧：避免重新订阅在排空与订阅
                                            // 之间产生丢帧窗口，且保证恢复完成前的帧已全部按序送达。
                                            spawn_notify_task(replay_rx, tx.clone()).await;
                                        });
                                    }
                                    Err(e) => {
                                        let err_msg = format!("failed to spawn agent: {}", e);
                                        let msg = serde_json::to_string(&AcpServerMessage::Error {
                                            code: Some("spawn_failed"),
                                            message: &err_msg,
                                        }).unwrap_or_default();
                                        let _ = ws_tx.send(Message::Text(msg.into())).await;
                                    }
                                }
                            }
                            Ok(AcpClientMessage::PermissionResponse { id, option_id }) => {
                                if let Some(ref c) = client {
                                    c.resolve_permission(&id, &option_id).await;
                                }
                            }
                            Ok(AcpClientMessage::SetConfigOption { config_id, value }) => {
                                if let Some(ref c) = client
                                    && let Err(e) = c.set_config_option(&config_id, &value).await {
                                        let err_msg = format!("配置�? {} 设置失败: {}", config_id, e);
                                        let msg = serde_json::to_string(&AcpServerMessage::Error {
                                            code: Some("config_option_failed"),
                                            message: &err_msg,
                                        })
                                        .unwrap_or_default();
                                        let _ = notify_tx.send(Message::Text(msg.into())).await;
                                    }
                            }
                            Err(e) => {
                                let err_msg = format!("invalid message: {}", e);
                                let msg = serde_json::to_string(&AcpServerMessage::Error {
                                    code: None,
                                    message: &err_msg,
                                })
                                .unwrap_or_default();
                                if ws_tx.send(Message::Text(msg.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    // 非文本、非 Close 的帧（如二进制帧）：当前协议不支持，记录以便发现
                    // 客户端/代理私自扩展或版本漂移，但不阻断连接。
                    other => {
                        tracing::warn!(
                            session_id = %session_id,
                            ?other,
                            "received unsupported websocket frame (non-text/non-close); ignoring"
                        );
                    }
                }
            }
            msg = notify_rx.recv() => {
                match msg {
                    Some(ws_msg) => {
                        if ws_tx.send(ws_msg).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            msg = proc_rx.recv() => {
                match msg {
                    Ok(evt) if evt.session_id == session_id => {
                        let frame = serde_json::to_string(&AcpServerMessage::ProcessAlive {
                            alive: evt.alive,
                        })
                        .unwrap_or_default();
                        if notify_tx.send(Message::Text(frame.into())).await.is_err() {
                            break;
                        }
                    }
                    // Lagged / Closed：订阅落后于发布端或通道已关闭，记录（但不阻断连接）。
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(
                            session_id = %session_id,
                            skipped = n,
                            "process-alive channel lagged; process events may be stale"
                        );
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        tracing::debug!(session_id = %session_id, "process-alive channel closed");
                    }
                    // 其他 Ok 事件（非本会话）直接忽略。
                    Ok(_) => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::extract_at_paths;

    #[test]
    fn extracts_basic_paths() {
        assert_eq!(
            extract_at_paths("看看 @src/main.rs 和 @README.md 的内容"),
            vec!["src/main.rs", "README.md"]
        );
    }

    #[test]
    fn extracts_at_start_and_after_newline() {
        assert_eq!(extract_at_paths("@a.txt first"), vec!["a.txt"]);
        assert_eq!(extract_at_paths("line1\n@b.txt"), vec!["b.txt"]);
    }

    #[test]
    fn dedupes_preserving_order() {
        assert_eq!(extract_at_paths("@a.rs @b.rs @a.rs"), vec!["a.rs", "b.rs"]);
    }

    #[test]
    fn caps_at_max_references() {
        let text = (1..=10).map(|i| format!("@f{}.rs", i)).collect::<Vec<_>>().join(" ");
        assert_eq!(extract_at_paths(&text).len(), super::MAX_AT_REFERENCES);
    }

    #[test]
    fn ignores_email_like_tokens() {
        assert_eq!(extract_at_paths("联系 user@example.com 谢谢"), Vec::<String>::new());
    }

    #[test]
    fn ignores_bare_at() {
        assert_eq!(extract_at_paths("@ 后面是空格"), Vec::<String>::new());
        assert_eq!(extract_at_paths("no refs here"), Vec::<String>::new());
    }
}
