use std::sync::Arc;

use agent_client_protocol::schema::v1::StopReason;
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
use crate::acp::turn_accumulator::TurnTiming;
use crate::acp::{AcpClient, FileInput, ImageInput, ResourceInput, TurnEndEvent, client};
use crate::api::agents::load_agent;

/// 单条客户端帧的体积上限。这是管道自身的口径，不是内容判断：tungstenite 默认
/// `max_frame_size` 为 16MiB，超限会直接关掉连接（不是报错），所以在入口显式拦
/// 一道并给出可读错误。图片与附件文件都 base64 内联在帧里，是把帧撑大的东西。
const MAX_PROMPT_FRAME_BYTES: usize = 12 * 1024 * 1024;

/// 字节数 → MiB，仅用于错误文案。
fn mib(bytes: usize) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}
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
        /// 普通文件附件（可选，旧前端不带此字段）。与 images 同为内联转发，
        /// 需 agent 声明 `promptCapabilities.embeddedContext`。
        #[serde(default)]
        files: Vec<FileInput>,
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
    PromptDone {
        stop_reason: &'a str,
        /// 刚结束 turn 的 DB 行 id。前端据此把 cooked `blocks` 精确回写到那一行
        /// （后端落的是原始帧，体积大两个数量级）。`None` = 本 turn 未折叠任何帧，
        /// 无行可回写。与 `turn_snapshot.row_id` 同一个值。
        #[serde(skip_serializing_if = "Option::is_none")]
        row_id: Option<&'a str>,
        /// 刚结束 turn 的时长（`{ work_ms, wait_ms }`，与 `TurnTiming` 的 serde 输出
        /// 一致；camel 映射在前端做）。前端据此立刻给该条回复标上耗时，
        /// 不必等下次 hydrate 读 DB。`None` = 该 turn 未经累积器定稿。
        #[serde(skip_serializing_if = "Option::is_none")]
        duration: Option<&'a TurnTiming>,
        /// 本轮是否为**非正常结束**（error 语义；`false` 时整个字段省略，故
        /// 「字段缺失」= 正常，旧前端无需改动即可兼容）。
        ///
        /// 判定口径（stopReason 白名单 + 未知值一律按非正常）只在后端做一次并
        /// 由此下发：同一判断散在前后两端必然漂移，而漏判的代价是「turn 静默定稿、
        /// 无任何失败痕迹」（AGENTS.md 工程准则 7①，本次事故的直接根因）。
        /// 注意 `cancelled` 亦是非正常，但它是用户主动行为、不算错误，故为
        /// `false`；其留痕走 system 消息的单独文案（`system.turnFailed.cancelled`）。
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        abnormal: bool,
    },
    #[serde(rename = "prompt_error")]
    PromptError { message: &'a str },
    /// 后端主动产生的系统通知（如权限超时回收告知）：在聊天流里以 system
    /// 消息显示，与 agent 崩溃（`prompt_error`）语义区分。`detail` 为可选
    /// 结构化详情（权限超时行动说明"错过了什么"，见 `SystemNotice`）。
    #[serde(rename = "system_message")]
    SystemMessage {
        label: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<&'a serde_json::Value>,
    },
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
    /// 连接时 pending 审批重放完毕的标记帧：前端据此对账——内存中不在重放集合
    /// 里的 banner 是断连窗口过期项（错过了 permission_resolved 广播），应清除。
    #[serde(rename = "permissions_synced")]
    PermissionsSynced,
    /// agent 能力声明（prompt 图片 / 嵌入上下文），client 就绪时推送，
    /// 前端据此显示/隐藏/置灰附件入口。`agent_name` 为当前会话所用 agent 的
    /// `display_name`，用于聊天气泡正确显示 agent 身份（而非硬编码 "agent"）。
    /// `embedded_context` = `promptCapabilities.embeddedContext`（文件附件与
    /// @path 引用共用此门控）。
    #[serde(rename = "capabilities")]
    Capabilities { image: bool, embedded_context: bool, agent_name: String },
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
    session_id: &str,
    mut rx: tokio::sync::broadcast::Receiver<crate::acp::handler::SeqNotification>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    let session_id = session_id.to_string();
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
                    tracing::debug!(
                        session_id = %session_id,
                        "ACP notify task: forwarding session_update seq={:?}",
                        seq_notif.seq
                    );
                    if notify_tx.send(Message::Text(msg.into())).await.is_err() {
                        tracing::warn!(session_id = %session_id, "ACP notify task: notify_tx closed (WS gone), exiting");
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::warn!(
                        session_id = %session_id,
                        "ACP notify task: session_update broadcast closed (client dropped), exiting"
                    );
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        session_id = %session_id,
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
    session_id: &str,
    mut rx: tokio::sync::broadcast::Receiver<TurnEndEvent>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let msg = match &event {
                        TurnEndEvent::Done { stop_reason, row_id, duration, abnormal } => {
                            serde_json::to_string(&AcpServerMessage::PromptDone {
                                stop_reason,
                                row_id: row_id.as_deref(),
                                duration: duration.as_ref(),
                                abnormal: *abnormal,
                            })
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
                        session_id = %session_id,
                        "ACP turn-end subscriber lagged by {} messages; dropped stale events",
                        n
                    );
                }
            }
        }
    });
}

/// 转发 agent 进程崩溃错误：收到即作为 `prompt_error` 帧推给前端，
/// 使用户能看到崩溃原因而非仅连接断开。
async fn spawn_crash_task(
    session_id: &str,
    mut rx: tokio::sync::broadcast::Receiver<String>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    let session_id = session_id.to_string();
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
                        session_id = %session_id,
                        "ACP crash-event subscriber lagged by {} messages; dropped stale events",
                        n
                    );
                }
            }
        }
    });
}

/// 转发后端主动产生的系统通知（权限超时回收告知等）：收到即作为
/// `system_message` 帧推给前端，在聊天流里显示（与崩溃的 `prompt_error` 区分）。
async fn spawn_system_notice_task(
    session_id: &str,
    mut rx: tokio::sync::broadcast::Receiver<crate::acp::client::SystemNotice>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    let session_id = session_id.to_string();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(notice) => {
                    let msg = serde_json::to_string(&AcpServerMessage::SystemMessage {
                        label: &notice.label,
                        detail: notice.detail.as_ref(),
                    })
                    .unwrap_or_default();
                    if notify_tx.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        session_id = %session_id,
                        "ACP system-notice subscriber lagged by {} messages; dropped stale notices",
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
    session_id: &str,
    mut rx: tokio::sync::broadcast::Receiver<TerminalActivity>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    let session_id = session_id.to_string();
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
                        session_id = %session_id,
                        "ACP terminal-event subscriber lagged by {} messages; dropped stale events",
                        n
                    );
                }
            }
        }
    });
}

async fn spawn_permission_task(
    session_id: &str,
    mut rx: tokio::sync::broadcast::Receiver<PermissionRequestEvent>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    let session_id = session_id.to_string();
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
                        session_id = %session_id,
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
    session_id: &str,
    mut rx: tokio::sync::broadcast::Receiver<String>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
) {
    let session_id = session_id.to_string();
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
                        session_id = %session_id,
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

/// D1 判定结果：turn 结束是否「正常」。
///
/// 与协议的 `StopReason` 不是一一对应：这里是**宿主对终态的语义判定**
/// （协议合法值 ≠ 成功语义，见计划 2026-09-19 D1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopEndClass {
    /// 白名单「正常值」：不留痕、不算错，前端按 done 处理。
    Normal,
    /// 用户主动取消：留痕（单独文案），但**不算错误**。
    Cancelled,
    /// 非正常结束（含一切未知值）：留痕 + error 语义。
    Abnormal,
}

/// D1：白名单「正常值」，其余（含未知）按非正常处理。
/// - `Normal`: EndTurn / MaxTokens / MaxTurnRequests → 不留痕
/// - `Cancelled`: Cancelled → 留痕（单独文案），不算错误
/// - `Abnormal`: Refusal / 未来新增变体（`_` 兜底臂）→ 留痕 + error 语义
///
/// 为什么按类型匹配而非按 wire 字符串：v1 schema 的 `StopReason` 是 `#[non_exhaustive]`
/// 闭枚举（无 `Other` 变体），未知值在反序列化阶段就失败并走 `TurnEndEvent::Error`；
/// 加 `_` 兜底臂是为 crate 升级到带 `Other(String)` 的 schema 预留（AGENTS.md §8：
/// 不得把单一实现的行为当作约定的全部事实）。
///
/// **覆盖面说明（诚实记录，勿伪造测试）**：截至 agent-client-protocol-schema 1.4.0
/// （本仓 `Cargo.toml` 锁定版本），`StopReason` 只有五个单位变体，**`_` 兜底臂
/// 今天不可达**——unknown/`_` 前缀值在 JSON 反序列化阶段即失败，直接走
/// `dispatch_prompt` 的 `Err` 分支（`TurnEndEvent::Error`），到不了本函数。
/// 故本仓的单测只能覆盖五个已存在变体；兜底臂的价值在于未来 crate 升级时
/// 「未知值仍然按非正常」这一不变式不丢失（升级后应为其补一条测试）。
fn classify_stop_reason(r: &StopReason) -> StopEndClass {
    match r {
        // 协议文档把 max_tokens / max_turn_requests 列为合法终态：内容可能被截断，
        // 但那不是「失败」，用户能自行判断（计划 D1 白名单 + 风险表：判定过宽会
        // 把 token 上限之类当失败，造成噪音）。
        StopReason::EndTurn | StopReason::MaxTokens | StopReason::MaxTurnRequests => {
            StopEndClass::Normal
        }
        // 用户点了取消：必须留痕（否则表现为「这一轮凭空消失」），但不是错误。
        StopReason::Cancelled => StopEndClass::Cancelled,
        // `Refusal` 是本次事故的现场形态：agent 侧工具批次异常 → 协议回 refusal，
        // 失败原因只存在于 agent 自己的日志里（协议参考 §6.8）。宿主若不在此留痕，
        // 聊天流里表现为「turn 静默定稿」。
        StopReason::Refusal => StopEndClass::Abnormal,
        // 兜底臂：未来 schema 新增的变体一律按非正常处理。把未知值当正常 = 静默
        // 失败（本次事故的判决），当异常 = 多一条提示但可发现、可修。
        _ => StopEndClass::Abnormal,
    }
}

/// 取协议 wire 形态（snake_case，如 `end_turn` / `_custom`），用于 system 消息的 detail
/// 与文案插值。与 `prompt_done.stop_reason` 的 Debug 形态刻意不同源、各司其职：
/// detail 面向人读（协议原文），stop_reason 面向既有前端 cancel 判定（勿改其格式）。
fn stop_reason_wire(r: &StopReason) -> String {
    // `serde_json` 对单位变体输出带引号的 snake_case 字符串，去引号即协议原文；
    // 序列化不可能失败（单位变体、无自定义 Serialize)，失败时退化 Debug 形态，
    // 保证任何情况下 detail 都有可读值（AGENTS.md §8 显式回退）。
    serde_json::to_string(r)
        .ok()
        .map(|s| s.trim_matches('"').to_string())
        .unwrap_or_else(|| format!("{:?}", r))
}

/// system 消息的 i18n key（label 列）：agent 拒绝继续。
///
/// 前端命中才翻译，未命中**原样显示** —— 2026-08-18 起的历史 system 行即靠该
/// 回退保持可读（见 reaper 的 `SYSTEM_LABEL_PERM_TIMEOUT_*` 同族约定）。
const SYSTEM_LABEL_TURN_FAILED_REFUSAL: &str = "system.turnFailed.refusal";

/// system 消息的 i18n key（label 列）：用户取消。
const SYSTEM_LABEL_TURN_FAILED_CANCELLED: &str = "system.turnFailed.cancelled";

/// system 消息的 i18n key（label 列）：其他非正常原因（含未来未知值）。
/// 文案经 `{{reason}}` 插值带出协议原文，未知值不吞（AGENTS.md §8）。
const SYSTEM_LABEL_TURN_FAILED_OTHER: &str = "system.turnFailed.other";

/// 非正常/取消结束的留痕文案。label 是 i18n key（前端命中才翻译，未命中原样显示），
/// text 是中文兜底（text 列语义与 2026-08-18 起的 system 行一致），detail 带协议原文。
struct TurnEndNotice {
    label: &'static str,
    text: String,
    detail: serde_json::Value,
}

/// 非正常/取消结束的留痕文案。`Normal` 返回 `None`（正常结束不留痕）。
///
/// 三条文案都写成一句话并带上 `stopReason=<协议原文>`：让用户在**不查日志**时
/// 就能判断这一轮失败还是被取消、失败在协议层是什么形态；未知值同样走
/// [`SYSTEM_LABEL_TURN_FAILED_OTHER`] + `{{reason}}` 插值，绝不吞成通用文案
/// （吞了就退回本次事故的「无任何痕迹」）。
///
/// 三条分支按**类型**而非 wire 字符串分流：字符串比对会在 `StopReason` 改名时
/// 静默失效（改 Debug/serde 形态，文案默默掉到 other 分支）。
fn build_turn_end_notice(r: &StopReason, class: StopEndClass) -> Option<TurnEndNotice> {
    let wire = stop_reason_wire(r);
    let (label, text) = match (class, r) {
        (StopEndClass::Normal, _) => return None,
        (StopEndClass::Cancelled, _) => {
            (SYSTEM_LABEL_TURN_FAILED_CANCELLED, format!("这一轮已被取消（stopReason={wire}）。"))
        }
        (StopEndClass::Abnormal, StopReason::Refusal) => (
            SYSTEM_LABEL_TURN_FAILED_REFUSAL,
            format!("这一轮未正常完成：agent 拒绝继续（stopReason={wire}）。"),
        ),
        // 其余的 Abnormal（当前不可达，见 classify_stop_reason 的覆盖面说明）：
        // 统一走 other 文案 + 原文插值，让未知原因至少可见、可追。
        (StopEndClass::Abnormal, _) => (
            SYSTEM_LABEL_TURN_FAILED_OTHER,
            format!("这一轮以非正常原因结束（stopReason={wire}）。"),
        ),
    };
    Some(TurnEndNotice {
        label,
        text,
        // `stop_reason` 恒存在：三类都要能让前端插值出 `{{reason}}`/做诊断，
        // 缺字段会让 other 文案退化成无原文的通用提示（这正是要避免的）。
        detail: serde_json::json!({ "stop_reason": wire }),
    })
}

/// 落库（刷新/切设备/弱网后 hydrate 仍可见——这正修 P0-2）+ 广播给在线连接。
///
/// 结构上与 reaper 的 `persist_and_broadcast` 完全一致（同一载荷形状：
/// system block 裹 label + detail → 写 `chat_messages` → 广播 `system_message` 帧）。
/// DB 写失败只 `warn` 不 abort：turn 结束路径还有 `prompt_done` 帧与前端兜底，
/// 为一条告知消息把整个收尾链路炸掉比丢一条消息更糟（reaper 同款容错）。
///
/// 顺序要求：`mark_prompt_idle()` 必须在调用方**先**执行（D3 注意点）——它已定稿
/// 累积器的 assistant 行，本函数只追加 system 行，`created_at` 因此严格晚于正文行，
/// 前端渲染顺序即「正文 → 失败提示」，不会出现提示跑到正文之前。
async fn persist_and_broadcast_turn_end_notice(
    db: &sqlx::SqlitePool,
    session_id: &str,
    client: &AcpClient,
    notice: &TurnEndNotice,
) {
    let blocks = serde_json::json!([
        { "type": "system", "label": notice.label, "detail": notice.detail }
    ])
    .to_string();
    if let Err(e) =
        chat_persistence::insert_message(db, session_id, "system", &notice.text, Some(&blocks))
            .await
    {
        tracing::warn!(
            session_id = %session_id,
            error = %e,
            "turn-end: failed to persist abnormal-end system message"
        );
    }
    client.notify_system_message(client::SystemNotice {
        label: notice.label.to_string(),
        detail: Some(notice.detail.clone()),
    });
}

/// D1 + D2 + 幂等的**单一切入点**：按 D1 判定 stopReason，非正常/取消则写一条
/// system 留痕（落库 + 广播）。返回判定结果，供调用方填 `prompt_done.abnormal`。
///
/// 为什么抽成函数：同一判定 + 写库 + 世代去重的序列只应有一处实现（工程准则 7①），
/// 且这样才能在测试里对**同一世代**连调两次来验证「只写一条」——若这段内联在
/// `dispatch_prompt` 里，每次调用都会先 `mark_prompt_active()` 推进世代，测不到
/// 双终结者（reaper prompt-stale 定稿 vs `send_prompt` 返回）的竞态。
async fn notice_turn_end_if_abnormal(
    c: &AcpClient,
    db: &sqlx::SqlitePool,
    session_id: &str,
    stop_reason: &StopReason,
) -> StopEndClass {
    let class = classify_stop_reason(stop_reason);
    let Some(notice) = build_turn_end_notice(stop_reason, class) else {
        // Normal（end_turn / max_tokens / max_turn_requests）：不留痕。
        return class;
    };
    // 世代幂等（只写一条）：同一 turn 的收尾可能被并发/重放触发两遍（reaper 的
    // prompt-stale 定稿与 `send_prompt` 返回是两个并存的收尾者，重连重放也可能让
    // 帧序重来）。重复执行会向用户展示两条相同的失败提示，故按世代去重；键取
    // prompt 世代而非 turn 行 id，覆盖「本 turn 未折叠任何帧」（row_id 为 None）。
    if !c.claim_turn_end_notice(c.prompt_generation()) {
        return class;
    }
    persist_and_broadcast_turn_end_notice(db, session_id, c, &notice).await;
    class
}

/// 向 agent 发送 prompt 并处理 turn 收尾（广播 prompt_done / prompt_error）。
/// 「连接存活即时发送」与「自动恢复后延迟发送」两条路径复用同一实现。
async fn dispatch_prompt(
    c: Arc<AcpClient>,
    db: sqlx::SqlitePool,
    session_id: String,
    text: String,
    images: Vec<ImageInput>,
    resources: Vec<ResourceInput>,
    files: Vec<FileInput>,
) {
    // 标记 prompt 进行中（活跃度守卫据此判断 agent 在工作中），并开启累积器
    // turn 门控；assistant 回复由累积器实时防抖落库（见 turn_accumulator）。
    c.mark_prompt_active();
    match c.send_prompt(&text, images, resources, files).await {
        Ok(resp) => {
            // mark_prompt_idle 内部定稿累积器进行中的 turn。
            c.mark_prompt_idle();
            // D1/D3：协议合法值 ≠ 成功语义。白名单外的终态（refusal / 取消 / 未知值）
            // 必须在聊天流留痕——否则表现为「turn 静默定稿、无任何失败痕迹」。
            // Normal（end_turn / max_tokens / max_turn_requests）什么都不写。
            // 必须先 mark_prompt_idle 再留痕（D3 注意点）：created_at 因此严格晚于
            // 正文行，前端渲染顺序即「正文 → 失败提示」。
            let class = notice_turn_end_if_abnormal(&c, &db, &session_id, &resp.stop_reason).await;
            // 经 broadcast 通知所有连接（发起连接可能已断开重连）。
            c.notify_turn_end(TurnEndEvent::Done {
                stop_reason: format!("{:?}", resp.stop_reason),
                // mark_prompt_idle 已定稿本 turn，但 row_id 要到下一次 begin_turn 才清 ——
                // 此处仍能读到本 turn 的行 id，交给前端做 cooked 回写。
                row_id: c.turn_row_id(),
                // 同理，定稿结算出的时长也在此刻读取，随帧下发使耗时立即显示。
                duration: c.turn_timing(),
                // 单一真源：白名单判定只在这里做一次，前端读这个字段走 error 语义，
                // 不得自行解析 stop_reason（AGENTS.md 工程准则 7①）。cancelled
                // 不算错误，故为 false（其留痕是上面的 cancelled 文案）。
                abnormal: class == StopEndClass::Abnormal,
            });
        }
        Err(e) => {
            c.mark_prompt_idle();
            // 连接已被主动释放（reaper 回收 / 手动 release）时，库错误
            // "connection is no longer running" 对用户无意义且误导（看似发送功能
            // 坏了，实为进程已回收）——改为可操作提示：重新发送即自动恢复。
            // 连接仍存活时的 agent 侧错误原样透传。
            let message = if c.is_alive() {
                format!("{}", e)
            } else {
                "会话进程已释放，请重新发送以自动恢复连接".to_string()
            };
            c.notify_turn_end(TurnEndEvent::Error { message });
        }
    }
}

/// 恢复 ACP 会话：spawn agent 子进程、注册 supervisor、挂接持久化与事件转发
/// 链路，并启动历史重放（session/load）。返回新 client 与重放任务句柄——
/// 重放任务负责转发 replay 帧、完成后发送 replay_end 并接管实时帧转发。
///
/// 供手动「恢复会话」（LoadSession 消息）与自动恢复（Prompt 到达时发现进程
/// 已释放 / 连接已死，F 方向）两条路径复用，避免复制粘贴。
/// 失败返回 Err(用户可读错误)。
async fn restore_acp_session(
    state: &AppState,
    db: &sqlx::SqlitePool,
    sid: &str,
    client: &mut Option<Arc<AcpClient>>,
    notify_tx: &tokio::sync::mpsc::Sender<Message>,
) -> Result<(Arc<AcpClient>, tokio::task::JoinHandle<Result<(), String>>), String> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT agent_id, acp_session_id, workspace_path FROM sessions WHERE id = ? AND runtime_kind = 'acp'",
    )
    .bind(sid)
    .fetch_optional(db)
    .await
    .ok()
    .flatten();
    let Some((agent_id, acp_sid, ws_path)) = row else {
        return Err("session row not found or not ACP".to_string());
    };
    let Some(agent) = load_agent(db, &agent_id).await else {
        return Err("agent config not found".to_string());
    };

    let cwd = std::path::PathBuf::from(&ws_path);
    let agent_display_name = agent.display_name.clone();
    let new_client =
        AcpClient::spawn_and_load(agent, cwd.clone(), acp_sid.clone(), &state.api_keys)
            .await
            .map_err(|e| format!("failed to spawn agent: {}", e))?;
    let new_client = Arc::new(new_client);

    if !new_client.supports_load_session() {
        new_client.shutdown().await;
        return Err("agent does not support session/load".to_string());
    }

    // 覆盖前先回收可能残留的旧 client，避免旧进程泄漏。用 shutdown（shared ref）
    // 而非 Arc::try_unwrap：同连接的 WS handler 持有旧 client 引用时 try_unwrap
    // 失败，旧进程会残留。
    if let Some(old) = state.acp_supervisor.dispose(sid).await {
        old.shutdown().await;
    }
    state.acp_supervisor.insert(sid.to_string(), new_client.clone()).await;
    // restore 出的新 client 绑定持久化：后续用户 prompt 的 assistant 回复由
    // 累积器实时防抖落库。
    new_client.attach_persistence(db.clone(), sid.to_string());
    new_client.attach_config_prefs(db.clone(), sid.to_string(), agent_id).await;

    let perm_rx = new_client.permission_subscribe();
    spawn_permission_task(sid, perm_rx, notify_tx.clone()).await;
    spawn_permission_resolved_task(
        sid,
        new_client.permission_resolved_subscribe(),
        notify_tx.clone(),
    )
    .await;
    // 新 client 无未决审批：发标记帧让前端清掉旧 client 遗留的陈旧 banner
    // （旧进程已回收，其审批随之失效，但前端可能错过了 resolved 广播）。
    let synced = serde_json::to_string(&AcpServerMessage::PermissionsSynced).unwrap_or_default();
    let _ = notify_tx.send(Message::Text(synced.into())).await;
    let crash_rx = new_client.crash_subscribe();
    spawn_crash_task(sid, crash_rx, notify_tx.clone()).await;
    let system_notice_rx = new_client.system_notice_subscribe();
    spawn_system_notice_task(sid, system_notice_rx, notify_tx.clone()).await;
    let turn_end_rx = new_client.turn_end_subscribe();
    spawn_turn_end_task(sid, turn_end_rx, notify_tx.clone()).await;
    let term_rx = new_client.terminal_event_subscribe();
    spawn_terminal_task(sid, term_rx, notify_tx.clone()).await;
    *client = Some(new_client.clone());

    let cap_msg = serde_json::to_string(&AcpServerMessage::Capabilities {
        image: new_client.supports_image(),
        embedded_context: new_client.supports_embedded_context(),
        agent_name: agent_display_name,
    })
    .unwrap_or_default();
    let _ = notify_tx.send(Message::Text(cap_msg.into())).await;

    let replay_msg = serde_json::to_string(&AcpServerMessage::ReplayStart).unwrap_or_default();
    let _ = notify_tx.send(Message::Text(replay_msg.into())).await;

    // 重放转发任务：与 load_session 并发转发重放帧，历史帧数可能远超 broadcast
    // 容量（256），若等 load 返回后再排空，缓冲溢出（Lagged）会静默丢帧（长会话
    // 恢复时曾导致一帧未发）。重放不经累积器落库（无 turn 门控，begin_turn 只由
    // 用户 prompt 触发）。完成后发送 replay_end 并复用 replay_rx 接管实时帧——
    // 避免重新订阅在排空与订阅之间产生丢帧窗口。
    // 任务返回 load 结果：Prompt 自动恢复路径据此决定是否发送（load 失败时不得
    // 向未加载/已死的会话发送，否则命中死连接报 connection is no longer running）。
    let task_client = new_client.clone();
    let tx = notify_tx.clone();
    let replay_sid = acp_sid.clone();
    let replay_cwd = cwd.clone();
    let restore_state = state.clone();
    let restore_sid = sid.to_string();
    let handle = tokio::spawn(async move {
        let mut replay_rx = task_client.session_update_subscribe();
        let load_fut = task_client.load_session(&replay_sid, replay_cwd);
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
                        tracing::warn!(session_id = %restore_sid, "ACP replay subscriber lagged by {} messages; dropped frames", n);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        break (&mut load_fut).await;
                    }
                },
            }
        };
        let load_err: Option<String> =
            result.as_ref().err().map(|e| format!("session/load failed: {}", e));
        tracing::info!(session_id = %restore_sid, "ACP replay task: load_session done, ok={}", load_err.is_none());
        // 恢复配置偏好：必须在 load_session 返回后（缓存已填充）、排空缓冲前调用。
        // restore 发出的 ConfigOptionUpdate 广播会进 replay_rx → 前端 staging，
        // ReplayEnd 的 commitReplay 时恢复值覆盖重放默认值，配置栏最终显示用户
        // 上次的设置。
        if load_err.is_none() {
            task_client.restore_config_prefs().await;
        }
        tracing::info!(session_id = %restore_sid, "ACP replay task: restore_config_prefs done");
        // load_session 返回即 agent 已推完全部历史。排空缓冲余量后经 notify_tx
        // 发 replay_end——notify_tx 为 FIFO，故 replay_end 必在最后一条重放帧之后
        // 到达前端（前端据此即时 sync 即可）。
        loop {
            match replay_rx.try_recv() {
                Ok(notif) => {
                    if !forward_session_update(&tx, &notif).await {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(n)) => {
                    // 不中断：后续 try_recv 仍能取到缓冲里保留的帧。
                    tracing::warn!(session_id = %restore_sid, "ACP replay drain lagged by {} messages; dropped frames", n);
                }
                Err(_) => break, // Empty / Closed
            }
        }
        let msg = match &load_err {
            None => serde_json::to_string(&AcpServerMessage::ReplayEnd).unwrap_or_default(),
            Some(e) => serde_json::to_string(&AcpServerMessage::Error {
                code: Some("load_failed"),
                message: e,
            })
            .unwrap_or_default(),
        };
        let _ = tx.send(Message::Text(msg.into())).await;
        tracing::info!(session_id = %restore_sid, "ACP replay task: replay_end sent, moving replay_rx into notify task");
        // 复用 replay_rx 接管实时帧，避免重新订阅在排空与订阅之间产生丢帧窗口。
        spawn_notify_task(&restore_sid, replay_rx, tx.clone()).await;
        tracing::info!(session_id = %restore_sid, "ACP replay task: notify task spawned, replay task finishing");
        match load_err {
            None => Ok(()),
            Some(e) => {
                // load 失败清理：supervisor 中若仍是本 client（未被并发恢复替换），
                // 移除并回收进程，让下次发送/恢复从干净状态重试。否则死 client
                // 滞留：agent 存活但会话未 load 时 is_alive() 仍为 true，后续
                // prompt 会直接发进未加载的会话；agent 已死则命中死连接。
                if let Some(cur) = restore_state.acp_supervisor.get(&restore_sid).await
                    && Arc::ptr_eq(&cur, &task_client)
                {
                    let _ = restore_state.acp_supervisor.dispose(&restore_sid).await;
                    task_client.shutdown().await;
                }
                Err(e)
            }
        }
    });

    Ok((new_client, handle))
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
            // turn_end 也须在快照前订阅：若 turn 在快照与订阅之间结束，旧代码会发出
            // 陈旧的 turn_state{active:true} 且 prompt_done 事件无订阅者而丢失，
            // 前端永久卡在 running 态。订阅先于快照后，重叠窗内至多收到一个幂等的
            // prompt_done（markDone 可重入），不会造成状态错乱。
            let turn_end_rx = c.turn_end_subscribe();
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
            spawn_notify_task(&session_id, rx, notify_tx.clone()).await;
            let perm_rx = c.permission_subscribe();
            spawn_permission_task(&session_id, perm_rx, notify_tx.clone()).await;
            spawn_permission_resolved_task(
                &session_id,
                c.permission_resolved_subscribe(),
                notify_tx.clone(),
            )
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
            // 重放完毕的标记帧：前端清掉不在重放集合里的陈旧 banner（断连窗口
            // 错过 permission_resolved 广播的过期审批）。
            let synced =
                serde_json::to_string(&AcpServerMessage::PermissionsSynced).unwrap_or_default();
            let _ = notify_tx.send(Message::Text(synced.into())).await;
            let crash_rx = c.crash_subscribe();
            spawn_crash_task(&session_id, crash_rx, notify_tx.clone()).await;
            let system_notice_rx = c.system_notice_subscribe();
            spawn_system_notice_task(&session_id, system_notice_rx, notify_tx.clone()).await;
            spawn_turn_end_task(&session_id, turn_end_rx, notify_tx.clone()).await;
            let term_rx = c.terminal_event_subscribe();
            spawn_terminal_task(&session_id, term_rx, notify_tx.clone()).await;
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
                embedded_context: c.supports_embedded_context(),
                agent_name,
            })
            .unwrap_or_default();
            let _ = notify_tx.send(Message::Text(msg.into())).await;
            Some(c)
        }
        None => {
            info!("ACP WS: session_id={} not in supervisor, keeping alive for restore", session_id);
            // 区分「已释放但可恢复」与「会话已删除」：
            // - DB 行仍存在（reaper 回收 / 手动 release / 后端重启）→ 不发送
            //   session_not_found，前端保持 released 态（随后的 process_alive:false
            //   帧驱动）。用户可直接发送消息触发自动恢复（发送即恢复），无需先
            //   手动点「恢复会话」。
            // - DB 行已删除 → 发 session_not_found，前端 markEnded。
            let row_exists: bool =
                sqlx::query_scalar("SELECT COUNT(*) > 0 FROM sessions WHERE id = ?")
                    .bind(&session_id)
                    .fetch_one(&state.db)
                    .await
                    .unwrap_or(true); // 查询失败时保守不标记 ended，避免误伤
            if !row_exists {
                let msg = serde_json::to_string(&AcpServerMessage::Error {
                    code: Some("session_not_found"),
                    message: "ACP session not found",
                })
                .unwrap();
                let _ = ws_tx.send(Message::Text(msg.into())).await;
            }
            None
        }
    };

    // 订阅进程存活事件，向本连接转发对应会话的 process_alive 帧（事件驱动地
    // 替代前端对 acp_process_alive 的轮询）。
    let mut proc_rx = state.acp_supervisor.process_event_subscribe();
    // 连接建立即发一帧初始存活状态，作初始同步（broadcast 无历史，防止错过连接前事件）。
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
                        // 管道口径：让 tungstenite 撞上它会直接关连接，先拦下来给可读错误。
                        if text.len() > MAX_PROMPT_FRAME_BYTES {
                            let msg = serde_json::to_string(&AcpServerMessage::Error {
                                code: Some("message_too_large"),
                                message: &format!(
                                    "message too large ({:.1} MiB); the WebSocket pipe holds {:.1} MiB",
                                    mib(text.len()),
                                    mib(MAX_PROMPT_FRAME_BYTES),
                                ),
                            })
                            .unwrap_or_default();
                            let _ = ws_tx.send(Message::Text(msg.into())).await;
                            continue;
                        }

                        match serde_json::from_str::<AcpClientMessage>(&text) {
                            Ok(AcpClientMessage::Prompt { text: prompt_text, images, files }) => {
                                // 带附件时把结构化 blocks 一并落库（text + image + file），
                                // 刷新后 hydrate 能还原缩略图/文件 chip；纯文本保持 NULL 现状。
                                let blocks_json = if images.is_empty() && files.is_empty() {
                                    None
                                } else {
                                    let mut arr = Vec::new();
                                    if !prompt_text.is_empty() {
                                        arr.push(serde_json::json!({
                                            "type": "text", "text": prompt_text,
                                        }));
                                    }
                                    for img in &images {
                                        // 只落缩略图：历史气泡的显示尺寸是 240×200，存原图会让
                                        // 分页预算和首屏为一张图付出上百倍体积（一页只翻得出
                                        // 一条消息）。无缩略图时回退原图（直连 WS 的客户端）。
                                        let (data, mime_type) = match &img.thumb {
                                            Some(t) => (t.data.as_str(), t.mime_type.as_str()),
                                            None => (img.data.as_str(), img.mime_type.as_str()),
                                        };
                                        arr.push(serde_json::json!({
                                            "type": "image",
                                            "mimeType": mime_type,
                                            "data": data,
                                        }));
                                    }
                                    for f in &files {
                                        // 文件只落元数据（名/mime/大小）：内容可达成百 MiB，
                                        // 历史气泡只需文件名 chip 定位「当时发了什么」。
                                        arr.push(serde_json::json!({
                                            "type": "file",
                                            "name": f.name,
                                            "mimeType": f.mime_type,
                                            "size": f.size,
                                        }));
                                    }
                                    serde_json::to_string(&arr).ok()
                                };
                                let _ = chat_persistence::insert_message(
                                    &db, &sid, "user", &prompt_text, blocks_json.as_deref(),
                                ).await;

                                // 解析 @path 文件引用（失败静默跳过，不阻塞发送）
                                let resources = resolve_at_references(&db, &sid, &prompt_text).await;

                                // 确保存在可用 client：进程已被释放（reaper 回收 / 手动
                                // release / 后端重启）或连接已死（崩溃）时，自动恢复进程
                                // 后再发送——用户无需手动点「恢复会话」，「发送」本身即恢复。
                                // replay_handle 仅在本次走自动恢复时存在；若连接本就可活，
                                // 直接即时发送。
                                let (live, replay_handle) =
                                    match client.as_ref().and_then(|c| c.is_alive().then(|| c.clone())) {
                                        Some(c) => (c, None),
                                        None => match restore_acp_session(
                                            &state, &db, &sid, &mut client, &notify_tx,
                                        )
                                        .await
                                        {
                                            Ok((c, handle)) => (c, Some(handle)),
                                            Err(e) => {
                                                let msg = serde_json::to_string(
                                                    &AcpServerMessage::Error {
                                                        code: Some("session_released"),
                                                        message: &e,
                                                    },
                                                )
                                                .unwrap_or_default();
                                                let _ = ws_tx.send(Message::Text(msg.into())).await;
                                                continue;
                                            }
                                        },
                                    };

                                if !images.is_empty() && !live.supports_image() {
                                    let msg = serde_json::to_string(&AcpServerMessage::PromptError {
                                        message: "agent does not support image input",
                                    }).unwrap_or_default();
                                    let _ = ws_tx.send(Message::Text(msg.into())).await;
                                    continue;
                                }

                                // 文件附件需 embeddedContext 能力（§8 多实现兼容：
                                // 未声明时前端已置灰入口，这里兜底拒绝直连 WS 的请求）。
                                if !files.is_empty() && !live.supports_embedded_context() {
                                    let msg = serde_json::to_string(&AcpServerMessage::PromptError {
                                        message: "agent does not support file attachments (embedded context)",
                                    }).unwrap_or_default();
                                    let _ = ws_tx.send(Message::Text(msg.into())).await;
                                    continue;
                                }

                                if let Some(handle) = replay_handle {
                                    // 自动恢复路径：历史重放尚未完成。等重放结束
                                    // （agent 就绪、前端对账完成）再发送 prompt，避免
                                    // 与 replay 帧交错。发起连接已在等待（前端 sending
                                    // 已置位），prompt_done 到达前前端不会重发。
                                    // load 失败时不得发送：replay 任务已发 load_failed
                                    // error 帧并清理了死 client，重发即可重试恢复。
                                    let c = live;
                                    let tx = notify_tx.clone();
                                    // db/sid 在此克隆进 spawn 的 closure：留痕写入需要
                                    // 它们，而两者都是廉价句柄/字符串（SqlitePool 是
                                    // Arc 句柄），不必把整个 AppState 捕获进来。
                                    let db = db.clone();
                                    let sid = sid.clone();
                                    tokio::spawn(async move {
                                        match handle.await {
                                            Ok(Ok(())) => {
                                                dispatch_prompt(
                                                    c,
                                                    db,
                                                    sid,
                                                    prompt_text,
                                                    images,
                                                    resources,
                                                    files,
                                                )
                                                .await;
                                            }
                                            Ok(Err(_)) => {} // load_failed 帧已由 replay 任务发送
                                            Err(e) => {
                                                let err_msg = format!("replay task failed: {}", e);
                                                let msg = serde_json::to_string(
                                                    &AcpServerMessage::Error {
                                                        code: Some("load_failed"),
                                                        message: &err_msg,
                                                    },
                                                )
                                                .unwrap_or_default();
                                                let _ = tx.send(Message::Text(msg.into())).await;
                                            }
                                        }
                                    });
                                } else {
                                    // 连接本就可活：即时发送。db/sid 移进 spawned
                                    // task（此处不再使用），避免克隆。
                                    tokio::spawn(dispatch_prompt(
                                        live,
                                        db.clone(),
                                        sid.clone(),
                                        prompt_text,
                                        images,
                                        resources,
                                        files,
                                    ));
                                }
                            }
                            Ok(AcpClientMessage::Cancel) => {
                                if let Some(ref c) = client {
                                    // 不立即 mark_prompt_idle：合作的 agent 会让 send_prompt
                                    // 以 Cancelled 返回并走正常定稿路径，取消后补发的尾部帧
                                    // 得以落库；无视 cancel 的实现由兜底定时器强制收尾。
                                    c.spawn_cancel_turn_fallback();
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
                                // 手动恢复会话：与 Prompt 的自动恢复共用 restore_acp_session
                                // （spawn agent + supervisor 注册 + 历史重放转发）。
                                if let Err(e) = restore_acp_session(
                                    &state, &db, &sid, &mut client, &notify_tx,
                                )
                                .await
                                {
                                    let msg = serde_json::to_string(&AcpServerMessage::Error {
                                        code: None,
                                        message: &e,
                                    })
                                    .unwrap_or_default();
                                    let _ = ws_tx.send(Message::Text(msg.into())).await;
                                }
                            }
                            Ok(AcpClientMessage::PermissionResponse { id, option_id }) => {
                                // resolve 成功时 resolved 广播已覆盖所有连接；失败（审批
                                // 已被其他连接应答 / cancel / 会话已释放）时向本连接回发
                                // permission_resolved，让陈旧 banner 收敛清除而非静默无响应。
                                let resolved = match client {
                                    Some(ref c) => c.resolve_permission(&id, &option_id).await,
                                    None => false,
                                };
                                if !resolved {
                                    let msg = serde_json::to_string(
                                        &AcpServerMessage::PermissionResolved { id: &id },
                                    )
                                    .unwrap_or_default();
                                    let _ = notify_tx.send(Message::Text(msg.into())).await;
                                }
                            }
                            Ok(AcpClientMessage::SetConfigOption { config_id, value }) => {
                                if let Some(ref c) = client
                                    && let Err(e) = c.set_config_option(&config_id, &value).await {
                                        let err_msg = format!("配置项 {} 设置失败: {}", config_id, e);
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
    use super::{
        AcpClientMessage, AcpServerMessage, SYSTEM_LABEL_TURN_FAILED_CANCELLED,
        SYSTEM_LABEL_TURN_FAILED_OTHER, SYSTEM_LABEL_TURN_FAILED_REFUSAL, StopEndClass,
        build_turn_end_notice, classify_stop_reason, extract_at_paths, stop_reason_wire,
    };
    // 判定口径钉在协议类型上（v1 schema），不构造 wire 字符串。
    use agent_client_protocol::schema::v1::StopReason;

    // ── AcpClientMessage::Prompt 反序列化（§8 向后兼容） ──────────────

    #[test]
    fn prompt_frame_without_files_deserializes_empty_files() {
        // 旧前端帧不带 images/files 字段：两者都应缺省为空，不报错。
        let msg: AcpClientMessage =
            serde_json::from_str(r#"{"type":"prompt","text":"hi"}"#).unwrap();
        let AcpClientMessage::Prompt { text, images, files } = msg else {
            panic!("expected prompt");
        };
        assert_eq!(text, "hi");
        assert!(images.is_empty());
        assert!(files.is_empty());
    }

    #[test]
    fn prompt_frame_with_files_parses_metadata() {
        let raw = r#"{"type":"prompt","text":"see","files":[{"name":"a.pdf","mime_type":"application/pdf","size":12,"data":"AAA"}]}"#;
        let msg: AcpClientMessage = serde_json::from_str(raw).unwrap();
        let AcpClientMessage::Prompt { files, .. } = msg else {
            panic!("expected prompt");
        };
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].name, "a.pdf");
        assert_eq!(files[0].mime_type, "application/pdf");
        assert_eq!(files[0].size, 12);
        assert_eq!(files[0].data, "AAA");
    }

    #[test]
    fn prompt_frame_file_size_and_data_default_gracefully() {
        // size 可选（直连 WS 的客户端可能不带）；空文件 payload 允许为空串。
        let raw = r#"{"type":"prompt","text":"","files":[{"name":"a.bin","mime_type":"application/octet-stream","data":""}]}"#;
        let msg: AcpClientMessage = serde_json::from_str(raw).unwrap();
        let AcpClientMessage::Prompt { files, .. } = msg else {
            panic!("expected prompt");
        };
        assert_eq!(files[0].size, 0);
        assert_eq!(files[0].data, "");
    }

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

    // ── D1：stopReason 白名单判定 ────────────────────────────────────────
    //
    // 判定口径见 `classify_stop_reason` 的文档：白名单正常值不留痕，其余（含
    // 未知）按非正常处理。这些用例钉住计划的 D1 决策与风险表（不得把
    // max_tokens 之类当失败 → 否则误报成灾）。

    /// 五个**今天可达**的协议变体在 D1 下的期望分类。
    ///
    /// 注意其中没有「未知值」项：v1 schema 的 `StopReason` 是闭枚举，unknown/
    /// `_` 前缀值在反序列化阶段就失败（走 `TurnEndEvent::Error`），到不了判定
    /// 函数。`_ =>` 兜底臂的覆盖面说明见 `classify_stop_reason` 的文档注释。
    #[test]
    fn stop_reason_whitelist_classification() {
        // 白名单「正常值」→ Normal（不留痕、不算错）。
        for r in [StopReason::EndTurn, StopReason::MaxTokens, StopReason::MaxTurnRequests] {
            assert_eq!(classify_stop_reason(&r), StopEndClass::Normal, "{r:?} 应判为正常");
        }
        // cancelled → 单独类目（留痕但不算错误）。
        assert_eq!(classify_stop_reason(&StopReason::Cancelled), StopEndClass::Cancelled);
        // refusal → 非正常（error 语义）。本次事故的现场形态。
        assert_eq!(classify_stop_reason(&StopReason::Refusal), StopEndClass::Abnormal);
    }

    /// `_` 兜底臂今天不可达（闭枚举，未知值在反序列化即失败），故无法对本 crate
    /// 版本构造一个未知变体来做真假测。这里只把不可达的原因钉成可读文档，
    /// 并断言「当前 schema 下 wire 形态就是五个 snake_case 值」这一前提没变 ——
    /// 若哪天 crate 升级到带 `Other(String)` 的 schema，本断言转为红就是提醒
    /// 补兜底臂测试的信号。
    #[test]
    fn unknown_variant_is_unreachable_today_documented() {
        let wires: Vec<String> = [
            StopReason::EndTurn,
            StopReason::MaxTokens,
            StopReason::MaxTurnRequests,
            StopReason::Refusal,
            StopReason::Cancelled,
        ]
        .iter()
        .map(stop_reason_wire)
        .collect();
        assert_eq!(wires, ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]);
    }

    /// wire 形态 = 协议原文（snake_case），与 `prompt_done.stop_reason` 的 Debug
    /// 形态（`EndTurn` / `MaxTokens`…）刻意不同源：detail 面向人读，stop_reason
    /// 面向既有前端 cancel 判定（不得改其格式）。
    #[test]
    fn stop_reason_wire_uses_protocol_snake_case() {
        assert_eq!(stop_reason_wire(&StopReason::EndTurn), "end_turn");
        assert_eq!(stop_reason_wire(&StopReason::MaxTokens), "max_tokens");
        assert_eq!(stop_reason_wire(&StopReason::Refusal), "refusal");
        assert_eq!(stop_reason_wire(&StopReason::Cancelled), "cancelled");
        // 不是 Debug 形态（前端既有 cancel 判定依赖 Debug 串）。
        assert_ne!(stop_reason_wire(&StopReason::EndTurn), "EndTurn");
    }

    // ── D2：留痕文案（label / text / detail 三要素） ─────────────────────

    /// 三个非正常/取消类目都要产出文案，且 `detail.stop_reason` 恒存在 ——
    /// 否则前端无法插值 `{{reason}}`（计划风险表：未知 stopReason 无 i18n key）。
    #[test]
    fn turn_end_notice_carries_i18n_key_text_and_wire_detail() {
        let cases = [
            (StopReason::Refusal, StopEndClass::Abnormal, SYSTEM_LABEL_TURN_FAILED_REFUSAL),
            (StopReason::Cancelled, StopEndClass::Cancelled, SYSTEM_LABEL_TURN_FAILED_CANCELLED),
        ];
        for (reason, class, label) in cases {
            let notice = build_turn_end_notice(&reason, class).expect("非正常/取消必须留痕");
            assert_eq!(notice.label, label);
            assert!(!notice.text.is_empty(), "text 是中文兜底，不能空");
            assert_eq!(notice.detail["stop_reason"], stop_reason_wire(&reason));
            // text 与 detail 一致提到协议原文：用户不查日志即可判断这一轮怎么结束的。
            assert!(notice.text.contains(stop_reason_wire(&reason).as_str()), "{}", notice.text);
        }
    }

    /// `Normal` 不留痕：正常结束（end_turn / token 上限之类）写 system 消息就是噪音，
    /// 计划风险表把「判定口径过宽导致噪音」列为要缓解的风险。
    #[test]
    fn normal_stop_reason_writes_no_notice() {
        for r in [StopReason::EndTurn, StopReason::MaxTokens, StopReason::MaxTurnRequests] {
            assert!(
                build_turn_end_notice(&r, StopEndClass::Normal).is_none(),
                "{r:?} 是白名单正常值，不得留痕"
            );
        }
    }

    /// cancelled 的文案与 refusal 区分开：取消是用户主动行为，不是错误。
    #[test]
    fn cancelled_notice_is_not_the_refusal_copy() {
        let cancelled =
            build_turn_end_notice(&StopReason::Cancelled, StopEndClass::Cancelled).unwrap();
        let refusal = build_turn_end_notice(&StopReason::Refusal, StopEndClass::Abnormal).unwrap();
        assert_ne!(cancelled.label, refusal.label);
        assert_ne!(cancelled.text, refusal.text);
        assert!(cancelled.text.contains("取消"), "{}", cancelled.text);
        assert!(refusal.text.contains("拒绝"), "{}", refusal.text);
    }

    /// i18n key 是与前端 agent 共用的常量契约，逐字钉住：改一个字符前端就命中不了
    /// 翻译、回退到把 key 原样显示给用户。
    #[test]
    fn turn_failed_i18n_keys_are_the_agreed_literals() {
        assert_eq!(SYSTEM_LABEL_TURN_FAILED_REFUSAL, "system.turnFailed.refusal");
        assert_eq!(SYSTEM_LABEL_TURN_FAILED_CANCELLED, "system.turnFailed.cancelled");
        assert_eq!(SYSTEM_LABEL_TURN_FAILED_OTHER, "system.turnFailed.other");
    }

    /// `Other` 分支（`Abnormal` 且非 `Refusal`）今天不可构造，故**不造假测**：
    /// 本测试只把「不可达」这一事实钉成可读文档，并断言文案构造器对
    /// `(Abnormal, Refusal)` 的组合走 refusal 文案、`(Cancelled, _)` 走取消文案 ——
    /// 也就是说 other 文案只能由未来 crate 升级引入的新变体触发。
    ///
    /// 若未来 schema 加上 `Other(String)` 变体，这里应改为真实构造该变体并断言
    /// 走 `SYSTEM_LABEL_TURN_FAILED_OTHER` + `{{reason}}` 插值出原文。
    #[test]
    fn other_notice_branch_is_unreachable_today_documented() {
        // 只有 refusal 这一种 Abnormal 今天可达。
        let refusal = build_turn_end_notice(&StopReason::Refusal, StopEndClass::Abnormal).unwrap();
        assert_eq!(refusal.label, SYSTEM_LABEL_TURN_FAILED_REFUSAL);
        // cancelled 不因 class 参数被误判成 Abnormal 文案。
        let cancelled =
            build_turn_end_notice(&StopReason::Cancelled, StopEndClass::Cancelled).unwrap();
        assert_eq!(cancelled.label, SYSTEM_LABEL_TURN_FAILED_CANCELLED);
        // 两个 Abnormal 文案 key 不同（other ≠ refusal），保证新变体落到的是另一条文案。
        assert_ne!(SYSTEM_LABEL_TURN_FAILED_OTHER, SYSTEM_LABEL_TURN_FAILED_REFUSAL);
    }

    // ── `prompt_done.abnormal` 前端契约 ─────────────────────────────────

    /// `abnormal` 的序列化形态是前端契约：`true` 时字段出现，`false` 时**整个字段
    /// 省略**（`skip_serializing_if`）——前端按 `frame.abnormal === true` 判定，
    /// 缺失即正常，旧前端不做任何改动即可兼容。
    #[test]
    fn prompt_done_frame_omits_abnormal_when_false() {
        let ok = serde_json::to_string(&AcpServerMessage::PromptDone {
            stop_reason: "EndTurn",
            row_id: None,
            duration: None,
            abnormal: false,
        })
        .unwrap();
        assert!(!ok.contains("abnormal"), "false 必须省略字段，得到: {ok}");

        let bad = serde_json::to_string(&AcpServerMessage::PromptDone {
            stop_reason: "Refusal",
            row_id: None,
            duration: None,
            abnormal: true,
        })
        .unwrap();
        assert!(bad.contains("\"abnormal\":true"), "true 必须显式下发，得到: {bad}");
        // stop_reason 仍是既有 Debug 形态（勿改其格式：前端 cancel 判定读它）。
        assert!(bad.contains("\"stop_reason\":\"Refusal\""), "得到: {bad}");
    }

    /// 类目 → `abnormal` 位的映射是前端 error 语义的唯一输入：`Abnormal` ⇒ true，
    /// `Cancelled` 与 `Normal` ⇒ false（cancelled 是用户主动行为，不算错误）。
    ///
    /// 复述 `dispatch_prompt` 里的 `abnormal: class == StopEndClass::Abnormal` ——
    /// 该式只出现一次，这里是它的护栏：把 true 放宽到 cancelled 会让前端把正常的
    /// 用户取消也标成错误态（红字 + attention error）。
    #[test]
    fn only_abnormal_class_maps_to_frame_abnormal() {
        for (class, expected) in [
            (StopEndClass::Normal, false),
            (StopEndClass::Cancelled, false),
            (StopEndClass::Abnormal, true),
        ] {
            assert_eq!(class == StopEndClass::Abnormal, expected, "{class:?} 的映射不符");
        }
    }
}

// ── D2 留痕的 DB 级行为（正常不留痕 / 只写一条 / 行内容与顺序） ──────────
//
// 这些用例需要真实的 `AcpClient`（广播 + 世代守卫都在它身上），故驱动真实 fake
// agent 子进程；沿 `acp::fake_agent_tests` 的先例，只在 Linux 上跑（依赖
// `/bin/sh` 脚本 + wrapper pid 自报）。`spawn_test_lock` 与本 crate 其他 agent
// spawn 用例互斥，避免 /proc diff 互相污染。
#[cfg(all(test, target_os = "linux"))]
mod notice_tests {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use agent_client_protocol::schema::v1::StopReason;
    use sqlx::sqlite::SqlitePoolOptions;

    use super::{StopEndClass, build_turn_end_notice, notice_turn_end_if_abnormal};
    use crate::acp::agent_proc::spawn_test_lock_async;
    use crate::acp::chat_persistence::{insert_message, list_messages_page};
    use crate::acp::client::AcpClient;
    use crate::models::agent::{Agent, AgentEnvVar};

    /// fake agent 只活一次握手 + 常驻：留痕测试不需要它真跑 turn，只需要一个
    /// 活的 `AcpClient`（广播通道 + 世代计数器），prompt 一个都不发。
    const SESSION: &str = "s-notice";
    const AGENT_ID: &str = "a-notice";

    const FAKE_AGENT_SCRIPT: &str = r#"#!/bin/sh
# test-only fake ACP agent：只响应 initialize + session/new 后常驻（stdin 保持
# 打开，`while read` 阻塞），让测试拿到一个活的 AcpClient 即可终止。
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([0-9a-f-][0-9a-f-]*\)".*/\1/p')
      printf '{"jsonrpc":"2.0","id":"%s","result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{}}}}\n' "$id"
      ;;
    *'"method":"session/new"'*)
      id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([0-9a-f-][0-9a-f-]*\)".*/\1/p')
      printf '{"jsonrpc":"2.0","id":"%s","result":{"sessionId":"notice-session"}}\n' "$id"
      ;;
  esac
done
exit 0
"#;

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omniterm-turn-end-notice-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    fn write_fake_agent(dir: &Path) -> PathBuf {
        let script = dir.join("fake-agent.sh");
        std::fs::write(&script, FAKE_AGENT_SCRIPT).expect("write fake agent script");
        script
    }

    fn agent_for(script: &Path) -> Agent {
        Agent {
            id: AGENT_ID.into(),
            display_name: "Fake Notice Agent".into(),
            command: "/bin/sh".into(),
            args: vec![script.to_string_lossy().to_string()],
            env: vec![AgentEnvVar { key: "PATH".into(), value: "/usr/bin:/bin".into() }],
            npm_package: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    /// 内存 sqlite + 全量迁移 + 父行（agents → projects → sessions，FK 依赖）。
    /// 与 `chat_persistence::tests::fresh_db` / `config_prefs::tests::test_pool`
    /// 同构；`max_connections(1)` 保证同一内存库不被多连接拆成两个库。
    async fn fresh_db() -> sqlx::SqlitePool {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite pool");
        sqlx::migrate!("./migrations").run(&db).await.expect("run migrations");
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO agents (id, display_name, command, args, env, created_at, updated_at) \
             VALUES (?, 'Fake', '/bin/sh', '[]', '[]', ?, ?)",
        )
        .bind(AGENT_ID)
        .bind(&now)
        .bind(&now)
        .execute(&db)
        .await
        .expect("seed agent");
        sqlx::query(
            "INSERT INTO projects (id, name, path, created_at) VALUES ('p-n', 'p', '/tmp', ?)",
        )
        .bind(&now)
        .execute(&db)
        .await
        .expect("seed project");
        sqlx::query(
            "INSERT INTO sessions (id, project_id, workspace_path, created_at, runtime_kind, agent_id) \
             VALUES (?, 'p-n', '/tmp', ?, 'acp', ?)",
        )
        .bind(SESSION)
        .bind(&now)
        .bind(AGENT_ID)
        .execute(&db)
        .await
        .expect("seed session");
        db
    }

    /// 会话的 (role, text, blocks) 行，按 `created_at` 升序（= 聊天流顺序）。
    async fn rows(db: &sqlx::SqlitePool) -> Vec<(String, String, Option<String>)> {
        let page = list_messages_page(db, SESSION, None, 100, usize::MAX)
            .await
            .expect("read back messages");
        page.rows.iter().map(|r| (r.role.clone(), r.text.clone(), r.blocks.clone())).collect()
    }

    async fn system_count(db: &sqlx::SqlitePool) -> usize {
        rows(db).await.iter().filter(|(role, _, _)| role == "system").count()
    }

    /// 起一个活的 fake client 并把持久化挂上（attach_persistence 是真实会话注册点
    /// 才调的，这里只为拿一个可广播、可计世代的 client）。
    async fn live_client(dir: &Path) -> AcpClient {
        let script = write_fake_agent(dir);
        let workspace = dir.join("ws");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        tokio::time::timeout(
            Duration::from_secs(15),
            AcpClient::spawn_and_connect(agent_for(&script), workspace, &HashMap::new()),
        )
        .await
        .expect("spawn 超时：fake agent 未响应握手")
        .expect("spawn_and_connect 失败")
    }

    /// `end_turn` / `max_tokens` / `max_turn_requests` → 一条 system 行都不写。
    ///
    /// 这是判定口径过宽的回归防线：误报会把正常结束也标成失败（计划风险表第一条）。
    #[tokio::test]
    async fn normal_stop_reasons_write_no_system_row() {
        let _guard = spawn_test_lock_async().await;
        let db = fresh_db().await;
        let dir = unique_dir("normal");
        let client = live_client(&dir).await;
        for reason in [StopReason::EndTurn, StopReason::MaxTokens, StopReason::MaxTurnRequests] {
            let class = notice_turn_end_if_abnormal(&client, &db, SESSION, &reason).await;
            assert_eq!(class, StopEndClass::Normal, "{reason:?} 应判为 Normal");
        }
        assert_eq!(system_count(&db).await, 0, "白名单正常值不得留 system 行");
        client.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `refusal` 写且**只写一条**：对同一世代连调两次（模拟 reaper prompt-stale
    /// 定稿与 `send_prompt` 返回两个终结者都走到这里），DB 里必须仍只有一行。
    #[tokio::test]
    async fn refusal_writes_exactly_one_row_even_when_repeated_for_same_turn() {
        let _guard = spawn_test_lock_async().await;
        let db = fresh_db().await;
        let dir = unique_dir("refusal");
        let client = live_client(&dir).await;

        // 用户 prompt → 世代递增（一次 prompt = 一个世代，守卫键即它）。
        client.mark_prompt_active();
        let generation = client.prompt_generation();
        assert_eq!(generation, 1, "首个 prompt 后世代应为 1（构造时为 0）");

        let class = notice_turn_end_if_abnormal(&client, &db, SESSION, &StopReason::Refusal).await;
        assert_eq!(class, StopEndClass::Abnormal, "refusal 必须是 error 语义");
        assert_eq!(system_count(&db).await, 1, "refusal 必须留一条痕");

        // 第二轮：同一世代重放（不 mark_prompt_active，世代不变）→ 必须被守卫拦下。
        notice_turn_end_if_abnormal(&client, &db, SESSION, &StopReason::Refusal).await;
        notice_turn_end_if_abnormal(&client, &db, SESSION, &StopReason::Refusal).await;
        assert_eq!(system_count(&db).await, 1, "重复定稿不得重复写（只写一条）");

        client.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `cancelled` 写一条，且是**取消文案**而非拒绝文案（单独文案是 D1 的分支之一）。
    #[tokio::test]
    async fn cancelled_writes_one_row_with_the_cancelled_copy() {
        let _guard = spawn_test_lock_async().await;
        let db = fresh_db().await;
        let dir = unique_dir("cancelled");
        let client = live_client(&dir).await;
        client.mark_prompt_active();

        let class =
            notice_turn_end_if_abnormal(&client, &db, SESSION, &StopReason::Cancelled).await;
        assert_eq!(class, StopEndClass::Cancelled, "cancelled 是单独类目");

        let rows = rows(&db).await;
        assert_eq!(rows.len(), 1, "只写一条");
        let (role, text, _blocks) = &rows[0];
        assert_eq!(role, "system", "必须是 role='system' 行（D2 载体）");
        assert!(text.contains("取消"), "取消文案，得到: {text}");
        let notice =
            build_turn_end_notice(&StopReason::Cancelled, StopEndClass::Cancelled).unwrap();
        assert_eq!(text, &notice.text, "落库 text 与文案构造器一致");

        client.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 落库那行的三要素：`role='system'` + i18n label 在 `blocks` + 协议原文在
    /// `detail.stop_reason`。这三者是前端 Phase 2 与 hydrate（P0-2：离线后仍可见）
    /// 的读取契约，缺一个前端就渲染不出可读文案。
    ///
    /// 顺带验顺序：正文行（这里用 user 行建模「`mark_prompt_idle()` 已先定稿的
    /// assistant 行」，因为定稿与留痕之间只隔着同步的 DB 写）必须先于 system 行 ——
    /// 否则前端会把失败提示渲染到正文之前（计划风险表第 2 条 + D3 注意点）。
    #[tokio::test]
    async fn persisted_row_carries_role_label_and_stop_reason_detail() {
        let _guard = spawn_test_lock_async().await;
        let db = fresh_db().await;
        let dir = unique_dir("rowshape");
        let client = live_client(&dir).await;
        client.mark_prompt_active();

        // 正文行先落（真实路径上它由 mark_prompt_idle() 的定稿写入，发生在本调用之前）。
        insert_message(&db, SESSION, "user", "帮我做件事", None).await.expect("seed user row");

        notice_turn_end_if_abnormal(&client, &db, SESSION, &StopReason::Refusal).await;

        let rows = rows(&db).await;
        assert_eq!(rows.len(), 2, "正文行 + 一条 system 留痕");
        assert_eq!(rows[0].0, "user", "正文行在前");
        assert_eq!(rows[1].0, "system", "失败提示在后（不得渲染到正文之前）");

        let (role, text, blocks) = &rows[1];
        assert_eq!(role, "system");
        assert!(text.contains("拒绝"), "refusal 文案，得到: {text}");
        let blocks = blocks.as_deref().expect("system 行必须带 blocks");
        let parsed: serde_json::Value = serde_json::from_str(blocks).expect("blocks 是 JSON 数组");
        let block = &parsed[0];
        assert_eq!(block["type"], "system", "前端按 type='system' 分发渲染");
        assert_eq!(block["label"], "system.turnFailed.refusal", "i18n key 必须在 blocks 里");
        assert_eq!(
            block["detail"]["stop_reason"], "refusal",
            "detail 带协议原文（{{reason}} 插值）"
        );
        assert_eq!(
            text,
            &build_turn_end_notice(&StopReason::Refusal, StopEndClass::Abnormal).unwrap().text
        );

        client.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 世代是滚动的：下一个 prompt 会重新赢得留痕权（否则第二个失败 turn 的提示
    /// 会被第一个 turn 的守卫永久吞掉）。
    #[tokio::test]
    async fn next_generation_gets_its_own_notice() {
        let _guard = spawn_test_lock_async().await;
        let db = fresh_db().await;
        let dir = unique_dir("generation");
        let client = live_client(&dir).await;

        client.mark_prompt_active();
        notice_turn_end_if_abnormal(&client, &db, SESSION, &StopReason::Refusal).await;
        assert_eq!(system_count(&db).await, 1);

        // 新 prompt = 新世代，守卫不该把这一轮的失败提示吞掉。
        client.mark_prompt_active();
        assert_eq!(client.prompt_generation(), 2, "世代应递增");
        notice_turn_end_if_abnormal(&client, &db, SESSION, &StopReason::Refusal).await;
        assert_eq!(system_count(&db).await, 2, "第二个失败 turn 必须也有提示");

        client.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
