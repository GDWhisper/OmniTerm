use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    BlobResourceContents, CancelNotification, ConfigOptionUpdate, ContentBlock,
    CreateTerminalRequest, EmbeddedResource, EmbeddedResourceResource, ImageContent,
    InitializeRequest, KillTerminalRequest, LoadSessionRequest, NewSessionRequest, PromptRequest,
    PromptResponse, ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest,
    RequestPermissionRequest, SessionConfigId, SessionConfigKind, SessionConfigOption,
    SessionConfigOptionValue, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, StopReason, TextContent, TextResourceContents,
    WaitForTerminalExitRequest, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::{AcpAgent, Agent as AcpAgentRole, ConnectionTo, Error as AcpError};
use serde::Deserialize;
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

use crate::acp::agent_proc;
use crate::acp::config_prefs;
use crate::acp::handler::{self, SeqNotification};
use crate::acp::permission::{PermissionManager, PermissionRequestEvent};
use crate::acp::terminal::{AcpTerminalManager, TerminalActivity};
use crate::acp::turn_accumulator::{TurnAccumulator, TurnSnapshot, TurnTiming};
use crate::acp::usage;
use crate::models::agent::Agent;

/// session_update broadcast 容量。重放/实时链路已边生产边消费，此容量仅作为
/// 慢消费者（如弱网 WS 客户端）的积压缓冲；超长历史 + 持续慢消费才会 Lagged 丢帧，
/// 每帧仅 Arc 克隆，放大容量的内存代价可忽略。
const SESSION_UPDATE_CHANNEL_CAPACITY: usize = 4096;

/// cancel 后等待 agent 自行结束 turn 的兜底秒数：合作的 agent 通常 1-2s 内让
/// send_prompt 以 Cancelled 返回；超时视为该实现无视 cancel，强制收尾
/// （见 [`AcpClient::spawn_cancel_turn_fallback`]）。
const CANCEL_TURN_FALLBACK_SECS: u64 = 15;

/// 「粘滞取消」重发前的等待毫秒数。部分实现（实测 codebuddy 2.161.4）处理
/// `session/cancel` 时异步清理取消状态，落在清理窗口内的**下一个** prompt 会被
/// 秒回 `cancelled`（复用上一轮的 requestId、不生成新 userMessageId），即用户
/// 刚排队的消息被静默吞掉。实测阈值：0ms 与 250ms 仍被吞，500ms 起正常。
/// 取 600ms 留余量；不做成「唯一正确延时」，靠 [`Self::STALE_CANCEL_MAX_RETRIES`]
/// 的次数上限兜底（延时随机器负载漂移）。
const STALE_CANCEL_RETRY_DELAY_MS: u64 = 600;

/// 粘滞取消的最大重发次数（见 [`STALE_CANCEL_RETRY_DELAY_MS`]）。有界是硬要求：
/// agent 若持续对这一轮回 `cancelled`，第 N+1 次就按真实终态留痕，不能无限重发。
const STALE_CANCEL_MAX_RETRIES: u32 = 2;

/// 前端随 prompt 附带的图片附件（base64 内联，映射为 `ContentBlock::Image`）。
#[derive(Debug, Clone, Deserialize)]
pub struct ImageInput {
    /// Base64 编码的图片数据（不含 data URI 前缀）。转发给 agent 的就是这份。
    pub data: String,
    pub mime_type: String,
    /// 同一张图的缩略图：只用于落库与历史渲染，不参与转发。
    /// 缺省（直连 WS 的客户端）时后端回退存原图。
    #[serde(default)]
    pub thumb: Option<ImageThumb>,
}

/// [`ImageInput`] 附带的缩略图。mime 由生成方决定（前端 canvas 编码为 JPEG），
/// 接收方不做假设。
#[derive(Debug, Clone, Deserialize)]
pub struct ImageThumb {
    pub data: String,
    pub mime_type: String,
}

/// 前端随 prompt 附带的普通文件附件（base64 内联，映射为
/// `ContentBlock::Resource(BlobResourceContents)`）。
///
/// 与图片同款的管道原则：不做张数/体积/MIME 白名单，唯一门禁是 WS 帧口径；
/// 落库只存元数据（name/mime/size），内容不落盘——历史气泡只需文件名 chip。
#[derive(Debug, Clone, Deserialize)]
pub struct FileInput {
    /// 文件名（前端 `File.name`，仅 basename）。
    pub name: String,
    pub mime_type: String,
    /// 原始字节数（前端 `File.size`）；仅用于落库元数据展示。
    #[serde(default)]
    pub size: u64,
    /// Base64 编码的文件内容（不含 data URI 前缀）。转发给 agent 的就是这份。
    pub data: String,
}

/// `@path` 引用解析出的文件内容（映射为 `ContentBlock::Resource`，
/// agent 不支持 embeddedContext 时降级内联进 text block）。
#[derive(Debug, Clone)]
pub struct ResourceInput {
    /// `file://` 绝对路径 URI。
    pub uri: String,
    /// 用户输入的原始 `@` 相对路径（内联降级时的标题）。
    pub label: String,
    pub text: String,
}

/// 组装 prompt 的 content blocks。顺序：Text → Image → Resource(Text, @path)
/// → Resource(Blob, 附件文件)。
///
/// 无正文且无附件时不塞空 Text block（部分实现可能拒绝空文本，§8 保守处理）。
/// `inline_resources` 为真表示 agent 不支持 embeddedContext，@path 文本资源已被
/// 内联进 `text`，不再产出 Resource 块；附件 blob 不走此降级（调用前已按能力拒绝）。
fn build_prompt_blocks(
    text: &str,
    images: Vec<ImageInput>,
    resources: Vec<ResourceInput>,
    files: Vec<FileInput>,
    inline_resources: bool,
) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    if !text.is_empty() || (images.is_empty() && files.is_empty()) {
        blocks.push(ContentBlock::Text(TextContent::new(text)));
    }
    for img in images {
        blocks.push(ContentBlock::Image(ImageContent::new(img.data, img.mime_type)));
    }
    if !inline_resources {
        for r in resources {
            blocks.push(ContentBlock::Resource(EmbeddedResource::new(
                EmbeddedResourceResource::TextResourceContents(TextResourceContents::new(
                    r.text, r.uri,
                )),
            )));
        }
    }
    for f in files {
        blocks.push(ContentBlock::Resource(EmbeddedResource::new(
            EmbeddedResourceResource::BlobResourceContents(
                BlobResourceContents::new(f.data, file_uri(&f.name)).mime_type(f.mime_type),
            ),
        )));
    }
    blocks
}

/// 附件文件的名义 URI：系统 picker 不提供真实路径，blob 已自包含内容，URI 仅作
/// 展示/标识（agent 应消费内联 blob，不应按 URI 读盘）。做最小 percent-encode
/// 保证 URI 结构合法——这几个字符会破坏 URI 语法，其余（含非 ASCII）原样保留。
fn file_uri(name: &str) -> String {
    let mut encoded = String::with_capacity(name.len());
    for ch in name.chars() {
        match ch {
            ' ' => encoded.push_str("%20"),
            '%' => encoded.push_str("%25"),
            '#' => encoded.push_str("%23"),
            '?' => encoded.push_str("%3F"),
            _ => encoded.push(ch),
        }
    }
    format!("file:///{}", encoded)
}

/// turn 结束事件（正常完成 / 出错）。经 broadcast 发给所有 WS 连接：
/// prompt task 完成时发起 prompt 的连接可能已断开重连，per-connection
/// 通道会把结束帧发进死连接被静默丢弃，新连接则永远收不到结束信号。
#[derive(Debug, Clone)]
pub enum TurnEndEvent {
    Done {
        stop_reason: String,
        /// 刚结束的 turn 的 DB 行 id（`None` 表示本 turn 未折叠任何帧）。前端据此
        /// 把 cooked `blocks` 精确回写到那一行（见 `chat_persistence::sync_messages`）：
        /// 后端落的是原始帧，体积比 cooked 大两个数量级。
        row_id: Option<String>,
        /// 本 turn 定稿结算出的时长（工作 / 等真人审批）。`None` = 该 turn 未经
        /// 累积器定稿（兜底路径），前端不更新耗时。随帧下发使耗时在定稿那一刻就出现，
        /// 不必等下一次 hydrate。
        duration: Option<TurnTiming>,
        /// 非正常结束（error 语义；cancelled 不算错误故为 false）。
        ///
        /// 计划 `2026-09-19-acp-failure-visibility` D1：协议合法值 ≠ 成功语义。
        /// stopReason 的白名单判定（`end_turn`/`max_tokens`/`max_turn_requests` 为
        /// 正常，其余含未知值一律非正常）**只在后端做一次**并在此字段下发，前端
        /// 不得读 `stop_reason` 自行分类（AGENTS.md 工程准则 7①：同一判断出现在
        /// 两处必然漂移，漏掉 `_` 前缀自定义值即本次事故的静默失败）。
        ///
        /// `true` = error 语义（refusal / 未知值），前端据此走错误态；`cancelled` 是
        /// 用户主动行为，单独文案、不算错误，故为 `false`。
        abnormal: bool,
    },
    Error {
        message: String,
    },
}

/// 后端主动产生的系统通知载荷（当前唯一产生者是 reaper 的权限超时行动）。
///
/// `label` 是 i18n key（前端命中才翻译，未命中原样显示——2026-08-18 起的
/// 历史数据是中文原文，靠该回退保持可读）；`detail` 是可选结构化详情，
/// 让前端能本地化地渲染"错过了什么"（请求工具/内容预览/可选项/实际动作）。
#[derive(Debug, Clone)]
pub struct SystemNotice {
    pub label: String,
    pub detail: Option<serde_json::Value>,
}

/// 后端可观测的 agent 活跃度状态（对所有 ACP agent 通用，与具体 agent 实现无关）。
///
/// ACP v1 协议（所有当前对接的 agent 均协商 protocolVersion:1）没有官方
/// `state_update`（`running`/`idle`/`requires_action`）状态机，agent 也不会
/// 发送 v2 状态帧。因此只能用后端可观测信号推断 agent 是否"在干活"：
/// - `active_prompt`：有进行中的 prompt（由 WS handler 在 Prompt/PromptDone/Err 时标记）
/// - `last_activity`：最近一次收到 agent 任意 `session/update` 通知的时间（任意 v1 agent 干活时都会持续发送）
/// - 未决权限数见 [`PermissionManager::pending_count`]（任意 agent 的 `request_permission` 均走此处）
///   三者共同决定 idle / requires_action 语义（详见 `reaper` 模块）。
struct ActivityState {
    active_prompt: bool,
    /// prompt 世代计数：每次 `mark_prompt_active` 递增。cancel 兜底定时器
    /// 据此识别自己要收尾的那个 turn，避免误杀取消后新发起的 turn。
    prompt_generation: u64,
    /// 最近一次 `session/cancel` **针对**的 prompt 世代（[`AcpClient::cancel`] 记录）。
    /// 与 `prompt_generation` 相等 ⇒ 当前这一轮是用户自己取消的；不等 ⇒ 这一轮的
    /// `cancelled` 不是用户要的（粘滞取消，见 [`STALE_CANCEL_RETRY_DELAY_MS`]）。
    /// `None` = 本连接从未取消过。
    cancel_requested_generation: Option<u64>,
    last_activity: Instant,
}

impl ActivityState {
    fn new() -> Self {
        Self {
            active_prompt: false,
            prompt_generation: 0,
            cancel_requested_generation: None,
            last_activity: Instant::now(),
        }
    }
}

/// 「按世代领取留痕权」的单一实现（[`AcpClient::claim_turn_end_notice`] 与
/// [`AcpClient::claim_turn_end_notice_for_current_turn`] 共用，工程准则 7①：同一判定
/// 只应有一处实现）。
///
/// 判定 = **比较 + 赋值在同一把锁内完成**，这才是幂等的来源。调用方若把「取世代」与
/// 「调用本函数」拆成两步（旧写法），两步之间就留下 TOCTOU 窗口：另一个连接在间隙里
/// `mark_prompt_active()` 推进世代，旧调用方便拿着**新**世代来 claim，把新一轮的留痕
/// 权消耗掉 → 那一轮失败无任何提示。
///
/// ## 中毒语义：取回数据继续判定（宁重复，不吞）
///
/// `into_inner()` 不 panic：poison 只标记「曾有持有者 panic」，数据本身仍一致。取舍：
/// 留痕承载「这一轮为什么失败」，吞掉它等于重演本家族要修的事故形态（turn 静默结束、
/// 无任何提示）；而放行的代价只是可能重复写一条相同的失败提示（可发现、可删会话），
/// 与「全量无 id 写回」同属可恢复污染。**宁要可恢复的重复，不要不可见的沉默。**
fn claim_notice_for_generation(noticed: &Mutex<Option<u64>>, generation: u64) -> bool {
    let mut noticed = match noticed.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if *noticed == Some(generation) {
        return false;
    }
    *noticed = Some(generation);
    true
}

pub struct AcpClient {
    connection: ConnectionTo<AcpAgentRole>,
    session_id: SessionId,
    session_update_tx: broadcast::Sender<SeqNotification>,
    _shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    /// agent 连接任务崩溃时广播错误原因，供 WS 层即时透传给前端。
    /// 取代原先 `disconnect` 中 `let _ = connection_task.await` 被静默丢弃的错误。
    crash_tx: broadcast::Sender<String>,
    /// 后端主动产生的系统通知（如权限超时回收告知），广播给所有 WS 连接，
    /// 由 WS 层转成 `system_message` 帧显示在聊天流里。
    system_notice_tx: broadcast::Sender<SystemNotice>,
    /// agent 终端命令生命周期事件（创建/退出），供 WS 层透传让前端感知后台命令。
    terminal_event_tx: broadcast::Sender<TerminalActivity>,
    /// turn 结束事件（prompt_done / prompt_error），广播给所有 WS 连接
    /// （断线重连后的新连接也必须收到，见 [`TurnEndEvent`]）。
    turn_end_tx: broadcast::Sender<TurnEndEvent>,
    terminal_manager: Arc<AcpTerminalManager>,
    permission_manager: Arc<PermissionManager>,
    supports_load_session: bool,
    /// initialize 时 agent 通过 `promptCapabilities.image` 声明是否接受图片
    /// content block（§8 多实现兼容：未声明的 agent 不硬塞图片）。
    supports_image: bool,
    /// `promptCapabilities.embeddedContext`：是否接受 `ContentBlock::Resource`；
    /// 不支持时 @ 引用降级为内联 text（§8 多实现兼容）。
    supports_embedded_context: bool,
    initial_config_options: Arc<Mutex<Vec<SessionConfigOption>>>,
    available_commands_notif: Arc<Mutex<Option<SessionNotification>>>,
    /// 配置偏好持久化句柄（`attach_config_prefs` 绑定）。仅在实际会话注册点
    /// （create-session / load restore）设置；能力探针不绑定 → 写入与恢复 no-op。
    /// `Arc` 包裹是让 agent 通知闭包（构造早于本 struct）也能对 §12.5 的
    /// `ConfigOptionUpdate` 推送落快照。用 `std::sync::Mutex<Option<_>>`：
    /// 使用时 lock 克隆 handle、立即 drop guard 再 await，避免跨 await 持 std
    /// MutexGuard 破坏 Send（replay task 是 tokio::spawn）。
    config_prefs: Arc<Mutex<Option<config_prefs::ConfigPrefsHandle>>>,
    /// 活跃度跟踪，供空闲回收看护任务（reaper）读取。
    activity: Arc<Mutex<ActivityState>>,
    /// turn 非正常结束留痕的世代守卫（计划 2026-09-19 D1/D2「只写一条」）。
    ///
    /// turn 结束路径上有两个可能同时作用于同一 turn 的收尾者：reaper 的
    /// `is_prompt_stale` 强制定稿（`run_reaper` → `mark_prompt_idle` + 广播结束帧）
    /// 与 `dispatch_prompt` 里 `send_prompt` 的正常返回。后者会写留痕，而前者
    /// 可能已经把同一 turn 定稿过；更实际的重复来源是**收尾被重放/并发触发两次**
    /// （同一 prompt 的 `Ok(resp)` 分支被走到两遍、或调用方重试）。留痕是
    /// **写库 + 广播**的副作用，重复执行会向用户展示两条相同的失败提示，故需与
    /// `accumulator::finalize_turn` 同样幂等。
    ///
    /// 键取 [`ActivityState::prompt_generation`] 而非 turn 行 id：一次 prompt 即
    /// 一个世代（`mark_prompt_active` 递增），而**没有折叠任何帧**的 turn（row_id
    /// 为 `None`，如 agent 一声不响就 refusal）同样需要去重，用行 id 会漏掉这类。
    ///
    /// `Option<u64>`：`None` = 迄今未写过任何留痕。不用 `AtomicU64` + 0 初值，是
    /// 因为世代 0 是合法值（首个 prompt 前），无法与「未写过」区分。
    ///
    /// **锁中毒语义（2026-09 评审后改）**：读侧（[`AcpClient::claim_turn_end_notice`] /
    /// [`AcpClient::claim_turn_end_notice_for_current_turn`）在锁中毒时**取回数据继续
    /// 判定**，而不是按「不写」处理。理由：留痕承载「这一轮为什么失败」，吞掉它等于
    /// 重演本次要修的事故形态（turn 静默结束、无任何提示）；中毒只说明某处曾 panic，
    /// 数据本身仍一致。放行的代价是**可能重复写一条相同提示**（可发现、可删会话），
    /// 与「全量无 id 写回」同属可恢复污染 —— 宁要可恢复的重复，不要不可见的沉默。
    /// 唯一的中毒风险是数据错乱时的误放行，而判定键是单调递增的世代，重复也局限于
    /// 同一世代的一条。
    last_noticed_generation: Mutex<Option<u64>>,
    /// 后端权威的进行中 turn 累积器：把流式 session/update 帧防抖落库，
    /// 使刷新/切设备/弱网不再丢失进行中的 assistant 回复（见 turn_accumulator）。
    accumulator: Arc<TurnAccumulator>,
    /// agent 子进程 pid（D1 捕获，见 [`agent_proc`]）。`None` = 捕获失败
    /// （降级路径，已 WARN 留痕），释放时退化为仅优雅信号（修复前现状）。
    /// killpg 前仍校验 pid 归属（防 pid 复用误杀），见
    /// [`agent_proc::kill_agent_process_group`]。
    agent_pid: Mutex<Option<u32>>,
    /// 连接任务 abort 指令（D4）：shutdown/disconnect 时 send，crash watcher
    /// 收到后 abort 句柄并静默返回。只发送不读取，故 `_` 前缀（同 `_shutdown_tx`）。
    /// 注意 abort 杀不了 agent 进程——`ChildGuard` 归 crate 内部 task_actor
    /// 所有，abort 外层 connection task 不会 drop 它；abort 仅本地资源清理，
    /// 杀进程靠 `agent_pid` 的 killpg（D2）。
    _abort_tx: Mutex<Option<oneshot::Sender<()>>>,
    /// 显式存活标志：`shutdown()` / `disconnect()` 时置 false。
    ///
    /// **不能用 `is_incoming_closed()` 单测判定死连接**：reaper 主动 `shutdown`
    /// 是让连接任务退出（`shutdown_rx.await` 返回），incoming 传输不读 EOF，
    /// `is_incoming_closed()` 保持 false，但 `send_request` 已报 "connection is
    /// no longer running"。`is_alive()` 因此必须组合本标志 + incoming-closed。
    ///
    /// `Arc` 包裹是为了让 `spawn_crash_watcher`（构造早于本 struct）也能读：
    /// 主动关闭期间的连接任务结束（D2 killpg 使 crate 的 `finish_child_exit`
    /// 返回 "exited with signal 9" 类 Err）是**预期行为**，据此与真崩溃区分，
    /// 不向前端误广播 `prompt_error`。
    alive: Arc<AtomicBool>,
}

/// 看护 agent 连接任务：若其因 agent 进程崩溃/异常退出而返回 `Err`，
/// 通过 `crash_tx` 广播错误原因，供 WS 层即时透传给前端（否则该错误仅被
/// `disconnect` 中的 `let _ =` 丢弃，用户看不到崩溃原因）。
///
/// `abort_rx` 收到 shutdown/disconnect 的指令时 abort 连接任务并**静默返回**：
/// 取消是主动行为，不是崩溃——不广播、不定稿。`JoinError` 的 `Cancelled` 与
/// panic/真错误同走 `Err` 分支，不区分就会 100% 误报（2026-09-21 评审核实，
/// 见计划 D4），故无条件过滤。
///
/// abort 只做本地资源清理：`ChildGuard` 归 crate 内部 task_actor 所有，abort
/// 外层 connection task 不会 drop 它、杀不了 agent 进程（杀进程靠 D2 killpg）。
///
/// `alive` 为 false 说明关闭流程已启动（shutdown/disconnect 置位）：此时
/// 连接任务无论以何姿势结束都是预期——尤其 D2 killpg 会让 crate 的
/// `finish_child_exit` 返回 "exited with signal 9" 类 Err——静默处理，
/// 不广播、不定稿（`mark_prompt_idle` 已定稿）。
fn spawn_crash_watcher(
    connection_task: JoinHandle<Result<(), AcpError>>,
    abort_rx: oneshot::Receiver<()>,
    crash_tx: broadcast::Sender<String>,
    accumulator: Arc<TurnAccumulator>,
    alive: Arc<AtomicBool>,
) {
    tokio::spawn(async move {
        // Pin 住以便 select! 内按引用 poll，abort 分支仍能拿回句柄。
        let mut connection_task = Box::pin(connection_task);
        tokio::select! {
            joined = connection_task.as_mut() => {
                // Cancelled = 别处 abort 了本任务（当前无此路径，防御性保留）；
                // alive=false = 主动关闭期间，Err 是预期收尾（D2 killpg 的
                // signal 9 即走此路）；两者都静默。
                if let Err(e) = joined
                    && !e.is_cancelled()
                    && alive.load(Ordering::Acquire)
                {
                    // 进程崩溃也算 turn 结束：定稿进行中的 assistant 行（幂等），
                    // 使已折叠的部分内容不丢，且不会永远停留在 streaming 状态。
                    accumulator.finalize_turn();
                    let _ = crash_tx.send(format!("{}", e));
                }
            }
            _ = abort_rx => {
                // shutdown 指令：signal 之后置的兜底。正常路径连接任务多已
                // 自行结束，abort 为 no-op；卡死路径下 killpg 已先打破循环，
                // 这里负责让 omniterm 侧 future 不再悬挂。
                connection_task.abort();
            }
        }
    });
}

/// 将 agent 请求的文件路径解析为 workspace 内的安全绝对路径，防止越界读写。
/// 越界或解析失败返回 Err(消息)，由调用方转成内部错误回报 agent。
fn resolve_fs_path(base: &Path, requested: &Path) -> Result<PathBuf, String> {
    let candidate =
        if requested.is_absolute() { requested.to_path_buf() } else { base.join(requested) };

    let canon_base =
        base.canonicalize().map_err(|e| format!("workspace root unresolvable: {}", e))?;

    // 目标存在则直接 canonicalize；不存在（写入新文件）则 canonicalize 父目录后拼接文件名。
    let canon = if candidate.exists() {
        candidate.canonicalize().map_err(|e| format!("path resolution failed: {}", e))?
    } else if let Some(parent) = candidate.parent() {
        let canon_parent =
            parent.canonicalize().map_err(|e| format!("parent dir unresolvable: {}", e))?;
        canon_parent.join(candidate.file_name().unwrap_or_default())
    } else {
        candidate
    };

    if !canon.starts_with(&canon_base) {
        return Err("access denied: path escapes workspace root".to_string());
    }
    Ok(canon)
}

// ---------------------------------------------------------------------------
// POSIX cwd 修复 + agent pid 自报：见 `acp::agent_proc`（wrap_agent_with_cwd）
// ---------------------------------------------------------------------------

/// 两个构造器（session/new 与 spawn_and_load）共用的 agent 通知处理：活动刷新、
/// turn 累积、命令通知缓存、配置快照落库、广播。提取自两份逐行相同的闭包体——
/// 新增跨构造器的通知行为时只改这里，勿再复制。
async fn on_agent_notification(
    activity: &Arc<Mutex<ActivityState>>,
    accumulator: &Arc<TurnAccumulator>,
    commands_notif: &Arc<Mutex<Option<SessionNotification>>>,
    config_prefs_slot: &Arc<Mutex<Option<config_prefs::ConfigPrefsHandle>>>,
    tx: &broadcast::Sender<SeqNotification>,
    notification: SessionNotification,
) -> Result<(), agent_client_protocol::Error> {
    // 收到任意 agent 通知即视为有活动，刷新最后活动时间
    if let Ok(mut st) = activity.lock() {
        st.last_activity = Instant::now();
    }
    // 后端权威累积：把进行中 turn 的原始帧防抖落库（仅在 turn active 时生效，
    // 重放帧无 turn 门控故自动忽略）。运行在 ACP 连接任务上，与 WS 存活无关。
    // fold 返回该帧的 seq（turn 内单调，非 turn 帧为 None），随广播下发供重连对账。
    let seq = accumulator.fold(&notification);
    if matches!(notification.update, SessionUpdate::AvailableCommandsUpdate(_))
        && let Ok(mut guard) = commands_notif.lock()
    {
        *guard = Some(notification.clone());
    }
    // §12.5：agent 主动推送的完整配置状态同步落快照（如 rate limit 降级模型），
    // 否则已结束会话的只读展示会停在旧值。探针会话未绑定句柄 → no-op。
    if let SessionUpdate::ConfigOptionUpdate(u) = &notification.update
        && let Some(handle) = config_prefs_slot.lock().ok().and_then(|g| g.clone())
    {
        config_prefs::persist_config_snapshot(&handle, &u.config_options).await;
    }
    // 上下文用量同理由推送落快照：该通知不随 session/load 重放、广播无补发，
    // 不落库则刷新页面 / 换设备后用量徽章丢失（前端由 GET /messages hydrate
    // 恢复最后已知值，实时值仍走本通知透传覆盖）。探针会话未绑定句柄 → no-op。
    if let SessionUpdate::UsageUpdate(u) = &notification.update
        && let Some(handle) = config_prefs_slot.lock().ok().and_then(|g| g.clone())
    {
        usage::persist_usage_snapshot(&handle.db, &handle.db_session_id, u).await;
    }
    handler::handle_session_update(tx, SeqNotification { seq, notification })
}

/// 两个构造器的会话建立差异：create 走 `session/new`（响应带 config_options），
/// restore 复用既有 `acp_session_id`（不发起新会话）。见
/// [`AcpClient::spawn_with_session`]。
enum SessionMode {
    New,
    Load(String),
}

impl AcpClient {
    pub async fn spawn_and_connect(
        agent: Agent,
        cwd: PathBuf,
        api_keys: &std::collections::HashMap<String, String>,
    ) -> Result<Self, AcpError> {
        Self::spawn_with_session(agent, cwd, api_keys, SessionMode::New).await
    }

    /// 两个构造器（session/new 与 restore）共用的 agent 连接建立骨架：命令解析、
    /// env 注入、cwd/pid wrapper、builder 组装、spawn、crash watcher、
    /// `conn_rx` 汇聚、D1 pid 捕获。
    ///
    /// 提取自 272 行逐字重复（仅 `SessionMode` 之差，2026-09-21 评审实测
    /// diff）——新增跨构造器行为只改这里，勿再复制（工程准则 6）。
    async fn spawn_with_session(
        agent: Agent,
        cwd: PathBuf,
        api_keys: &std::collections::HashMap<String, String>,
        mode: SessionMode,
    ) -> Result<Self, AcpError> {
        let resolved_cmd = match agent.npm_package.as_deref() {
            Some(_) => {
                crate::acp::resolve::resolve_command(&agent.command, agent.npm_package.as_deref())
                    .await
                    .map_err(|e| AcpError::internal_error().data(e))?
                    .to_string_lossy()
                    .to_string()
            }
            None => agent.command.clone(),
        };

        let mut all_args: Vec<String> = Vec::new();

        // agent.env（DB 配置）显式指定
        for env_var in &agent.env {
            all_args.push(format!("{}={}", env_var.key, env_var.value));
        }
        // 注入全局 API key（~/.omniterm/api_keys.toml / 环境变量配置的模型 key）
        // agent.env 中显式配置的 key 优先，不覆盖
        for (key, value) in api_keys {
            if !agent.env.iter().any(|e| e.key == *key) {
                all_args.push(format!("{}={}", key, value));
            }
        }
        // 包装 agent 命令为 `sh -c "cd <workspace> && echo $$ > <pid 文件> && exec <cmd> <args>"`：
        // cd 让 agent 子进程的 OS cwd 落在 session workspace（AcpAgent::spawn_process
        // 不设 current_dir），pid 自报供释放时 killpg（D1）。详见 agent_proc。
        // POSIX-only 路径。
        #[cfg(unix)]
        let pid_file = agent_proc::new_pid_file();
        #[cfg(unix)]
        let (cmd, args) = (
            "/bin/sh".to_string(),
            agent_proc::wrap_agent_with_cwd(&resolved_cmd, &agent.args, &cwd, Some(&pid_file)),
        );
        #[cfg(not(unix))]
        let (cmd, args) = (resolved_cmd, agent.args.clone());

        all_args.push(cmd);
        all_args.extend(args);

        let transport = AcpAgent::from_args(all_args)?;

        let (session_update_tx, _) = broadcast::channel(SESSION_UPDATE_CHANNEL_CAPACITY);
        let (crash_tx, _) = broadcast::channel::<String>(16);
        let (system_notice_tx, _) = broadcast::channel::<SystemNotice>(8);
        let (terminal_event_tx, _) = broadcast::channel::<TerminalActivity>(64);
        let (turn_end_tx, _) = broadcast::channel::<TurnEndEvent>(16);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        // D4：连接任务 abort 指令（shutdown/disconnect → crash watcher）。
        let (abort_tx, abort_rx) = oneshot::channel::<()>();
        let (conn_tx, conn_rx) = oneshot::channel::<(
            ConnectionTo<AcpAgentRole>,
            SessionId,
            bool,
            bool,
            bool,
            Vec<SessionConfigOption>,
        )>();

        let notif_tx = session_update_tx.clone();
        let terminal_manager = Arc::new(AcpTerminalManager::new(terminal_event_tx.clone()));
        let tm = terminal_manager.clone();
        let permission_manager = Arc::new(PermissionManager::new());
        let pm = permission_manager.clone();
        let activity = Arc::new(Mutex::new(ActivityState::new()));
        let commands_notif: Arc<Mutex<Option<SessionNotification>>> = Arc::new(Mutex::new(None));
        let accumulator = Arc::new(TurnAccumulator::new());
        let config_prefs_slot: Arc<Mutex<Option<config_prefs::ConfigPrefsHandle>>> =
            Arc::new(Mutex::new(None));
        // crash watcher 需要读存活标志以区分「主动关闭期间的预期结束」与真崩溃
        // （D2 killpg 让 crate 的 finish_child_exit 返回 signal 9 Err，见
        // spawn_crash_watcher）。
        let alive = Arc::new(AtomicBool::new(true));

        let builder = agent_client_protocol::Client
            .builder()
            .name("omniterm")
            .on_receive_notification(
                {
                    let tx = notif_tx.clone();
                    let activity = activity.clone();
                    let commands_notif = commands_notif.clone();
                    let accumulator = accumulator.clone();
                    let config_prefs_slot = config_prefs_slot.clone();
                    async move |notification: SessionNotification, _cx| {
                        on_agent_notification(
                            &activity,
                            &accumulator,
                            &commands_notif,
                            &config_prefs_slot,
                            &tx,
                            notification,
                        )
                        .await
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let pm = pm.clone();
                    let accumulator = accumulator.clone();
                    async move |request: RequestPermissionRequest, responder, _cx| {
                        // 登记成功即进入未决态 → 起算「等真人审批」区间（无活跃 turn 时
                        // begin_wait 自行 no-op，见 TurnAccumulator）。
                        pm.handle_request(request, responder).await?;
                        accumulator.begin_wait();
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let read_cwd = cwd.clone();
                    async move |request: ReadTextFileRequest, responder, _cx| {
                        let path = match resolve_fs_path(&read_cwd, &request.path) {
                            Ok(p) => p,
                            Err(e) => {
                                let _ = responder.respond_with_internal_error(e);
                                return Ok(());
                            }
                        };
                        match tokio::fs::read_to_string(&path).await {
                            Ok(content) => {
                                let _ = responder.respond(ReadTextFileResponse::new(content));
                            }
                            Err(e) => {
                                let _ = responder
                                    .respond_with_internal_error(format!("read failed: {}", e));
                            }
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let write_cwd = cwd.clone();
                    async move |request: WriteTextFileRequest, responder, _cx| {
                        let path = match resolve_fs_path(&write_cwd, &request.path) {
                            Ok(p) => p,
                            Err(e) => {
                                let _ = responder.respond_with_internal_error(e);
                                return Ok(());
                            }
                        };
                        if let Some(parent) = path.parent() {
                            let _ = tokio::fs::create_dir_all(parent).await;
                        }
                        match tokio::fs::write(&path, &request.content).await {
                            Ok(()) => {
                                let _ = responder.respond(WriteTextFileResponse::new());
                            }
                            Err(e) => {
                                let _ = responder
                                    .respond_with_internal_error(format!("write failed: {}", e));
                            }
                        }
                        Ok(())
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let tm = tm.clone();
                    async move |request: CreateTerminalRequest, responder, _cx| {
                        tm.handle_create(request, responder).await
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let tm = tm.clone();
                    async move |request: agent_client_protocol::schema::v1::TerminalOutputRequest, responder, _cx| {
                        tm.handle_output(request, responder).await
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let tm = tm.clone();
                    async move |request: KillTerminalRequest, responder, _cx| {
                        tm.handle_kill(request, responder).await
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let tm = tm.clone();
                    async move |request: ReleaseTerminalRequest, responder, _cx| {
                        tm.handle_release(request, responder).await
                    }
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                {
                    let tm = tm.clone();
                    async move |request: WaitForTerminalExitRequest, responder, _cx| {
                        tm.handle_wait_for_exit(request, responder).await
                    }
                },
                agent_client_protocol::on_receive_request!(),
            );

        // D1 兜底扫描的 workspace 匹配基准（cwd 随后被移进连接闭包，这里留一份）
        #[cfg(unix)]
        let scan_workspace = cwd.clone();
        // D1 兜底扫描基线：crate 在 connect_with 内部才 spawn 子进程，快照紧贴
        // spawn 点取；diff 出的新 pid 在并发 spawn 时按 cwd 消歧（见 agent_proc）。
        // /proc 快照是 Linux 专属——此前门控写成 `#[cfg(unix)]` 而实现是
        // `unix && linux`，macOS（unix 非 linux）直接 E0425 编不过（v0.2.24
        // 发版 macOS job 实测）。非 Linux Unix 无扫描兜底，传空基线仅供
        // capture_agent_pid 签名（其 pid 自报主路径不受影响）。
        #[cfg(target_os = "linux")]
        let children_before = agent_proc::snapshot_direct_children();
        #[cfg(all(unix, not(target_os = "linux")))]
        let children_before = std::collections::HashSet::new();

        // P2-3：pid 自报文件的 RAII 清理守卫（随任务终结删除，幂等）。覆盖外层
        // future 被 drop 的路径——探针 15s 超时时 abort_tx 随之释放，crash
        // watcher abort 连接任务（Phase 1 D4 兜底），crate 的 ChildGuard::drop
        // killpg 进程组，闭包侧代码来不及清理 pid 文件；由本守卫在任务结束
        // （返回/abort/panic）时统一删除，避免 /tmp 累积。成功路径
        // capture_agent_pid 读后即删，Drop 为 no-op。
        #[cfg(unix)]
        let pid_file_cleanup = agent_proc::PidFileCleanup::new(pid_file.clone());

        let connection_task = tokio::spawn(async move {
            // 守卫绑定是 cfg(unix) 的，此引用必须同门控（Windows 上绑定不存在）。
            #[cfg(unix)]
            let _pid_file_cleanup = pid_file_cleanup;
            builder
                .connect_with(transport, move |cx: ConnectionTo<AcpAgentRole>| async move {
                    let init_resp = cx
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task()
                        .await?;
                    let supports_load = init_resp.agent_capabilities.load_session;
                    let supports_image = init_resp.agent_capabilities.prompt_capabilities.image;
                    let supports_embedded =
                        init_resp.agent_capabilities.prompt_capabilities.embedded_context;

                    // 两个构造器的唯一差异：create 走 session/new（响应带
                    // config_options），restore 复用既有 acp_session_id。
                    let (session_id, config_options) = match mode {
                        SessionMode::New => {
                            let session_resp =
                                cx.send_request(NewSessionRequest::new(cwd)).block_task().await?;
                            (
                                session_resp.session_id,
                                session_resp.config_options.clone().unwrap_or_default(),
                            )
                        }
                        SessionMode::Load(acp_session_id) => {
                            (SessionId::new(acp_session_id.as_str()), Vec::new())
                        }
                    };
                    let _ = conn_tx.send((
                        cx.clone(),
                        session_id,
                        supports_load,
                        supports_image,
                        supports_embedded,
                        config_options,
                    ));

                    let _ = shutdown_rx.await;
                    Ok(())
                })
                .await
        });

        spawn_crash_watcher(
            connection_task,
            abort_rx,
            crash_tx.clone(),
            accumulator.clone(),
            alive.clone(),
        );

        let (
            connection,
            session_id,
            supports_load_session,
            supports_image,
            supports_embedded_context,
            initial_config_options,
        ) = match conn_rx.await {
            Ok(parts) => parts,
            Err(_) => {
                // agent 已 spawn 但连接未建成（initialize 失败/超时）：清理 pid
                // 自报文件避免 /tmp 累积；进程由 crate 侧 teardown 回收。
                #[cfg(unix)]
                agent_proc::remove_pid_file(&pid_file);
                return Err(AcpError::internal_error());
            }
        };

        // D1：捕获 agent pid（wrapper 自报为主，/proc diff 兜底）。None = 降级
        // 路径，失败原因已在 agent_proc 内 WARN；释放时退化为仅 signal。
        #[cfg(unix)]
        let agent_pid = agent_proc::capture_agent_pid(&pid_file, &children_before, &scan_workspace);
        #[cfg(not(unix))]
        let agent_pid: Option<u32> = {
            tracing::warn!(
                "非 Unix 平台：ACP agent pid 不可得（无 wrapper 自报与 /proc 扫描），释放时仅发优雅关闭信号"
            );
            None
        };

        Ok(AcpClient {
            connection,
            session_id,
            session_update_tx,
            _shutdown_tx: Mutex::new(Some(shutdown_tx)),
            _abort_tx: Mutex::new(Some(abort_tx)),
            crash_tx,
            system_notice_tx,
            terminal_event_tx,
            turn_end_tx,
            terminal_manager,
            permission_manager,
            supports_load_session,
            supports_image,
            supports_embedded_context,
            initial_config_options: Arc::new(Mutex::new(initial_config_options)),
            available_commands_notif: commands_notif,
            activity,
            last_noticed_generation: Mutex::new(None),
            accumulator,
            config_prefs: config_prefs_slot,
            alive,
            agent_pid: Mutex::new(agent_pid),
        })
    }

    pub fn session_update_subscribe(&self) -> broadcast::Receiver<SeqNotification> {
        self.session_update_tx.subscribe()
    }

    /// 订阅 agent 进程崩溃错误（仅在连接任务非正常退出时收到）。
    pub fn crash_subscribe(&self) -> broadcast::Receiver<String> {
        self.crash_tx.subscribe()
    }

    /// 订阅后端主动产生的系统通知（权限超时回收等，与 agent 崩溃无关）。
    pub fn system_notice_subscribe(&self) -> broadcast::Receiver<SystemNotice> {
        self.system_notice_tx.subscribe()
    }

    /// 订阅 agent 终端命令生命周期事件（创建/退出）。
    pub fn terminal_event_subscribe(&self) -> broadcast::Receiver<TerminalActivity> {
        self.terminal_event_tx.subscribe()
    }

    /// 订阅 turn 结束事件（所有 WS 连接都应订阅，见 [`TurnEndEvent`]）。
    pub fn turn_end_subscribe(&self) -> broadcast::Receiver<TurnEndEvent> {
        self.turn_end_tx.subscribe()
    }

    /// 当前（或刚结束的）turn 的 DB 行 id。专用轻量访问器：`turn_snapshot()`
    /// 会克隆全量 `text` 并序列化整个帧窗口（可达 128KB），为拿一个 id 不值得。
    pub fn turn_row_id(&self) -> Option<String> {
        self.accumulator.turn_row_id()
    }

    /// agent 子进程 pid（D1 捕获）。`None` = 捕获失败（降级路径，agent_proc 内
    /// 已 WARN）。供诊断与回归测试观测（如断言 shutdown 后进程组无残留）。
    pub fn agent_pid(&self) -> Option<u32> {
        *self.agent_pid.lock().unwrap()
    }

    /// 上一次定稿结算出的 turn 时长（工作 / 等真人审批）。`mark_prompt_idle()` 之后
    /// 立刻读仍能拿到本 turn 的值（累积器把它留到下一次 `begin_turn`）。
    pub fn turn_timing(&self) -> Option<TurnTiming> {
        self.accumulator.turn_timing()
    }

    /// 当前进行中的 prompt 世代。每次 `mark_prompt_active` 递增，故「一次 prompt =
    /// 一个世代」，可作为 turn 的稳定标识（见 `last_noticed_generation`）。
    ///
    /// **不要与 [`Self::claim_turn_end_notice_for_current_turn`] 拆成两步调用**：
    /// 「读世代」与「按世代 claim」之间不持同一把锁时是 TOCTOU —— 另一个连接在此
    /// 间隙 `mark_prompt_active()` 推进世代，本调用方就会拿**新**世代去 claim，而
    /// 新世代对应的留痕权可能已被消耗/即将被消耗 → 本轮的留痕被永久吞掉（正是
    /// 「这一轮失败无任何提示」的事故形态）。要「对当前 turn 留痕」就一次调用到位。
    pub fn prompt_generation(&self) -> u64 {
        // 锁中毒时退化为 0 而非 panic：本值只用于去重键，中毒说明其他地方已 panic，
        // 为一个只读访问器再崩一次没有收益。
        self.activity.lock().map(|st| st.prompt_generation).unwrap_or(0)
    }

    /// **当前**进行中的这一轮 prompt 是否是用户主动 cancel 的。
    ///
    /// 用途：区分「真取消」与「粘滞取消」。ACP 的 `session/cancel` 语义只作用于
    /// 发出时那一个在途请求，但部分实现（实测 codebuddy，见
    /// [`STALE_CANCEL_RETRY_DELAY_MS`]）清理取消状态是异步的，紧随其后的下一个
    /// prompt 会被秒回 `cancelled`——那一轮用户并没要求取消，消息等于被静默吞掉。
    /// 协议层判据即「本世代没有对应的 cancel 请求」，与具体实现的时序无关。
    ///
    /// 锁中毒时按 `true`（视为用户自己取消）处理：宁可不做重发、保持既有行为，
    /// 也不要在状态错乱时对同一 prompt 重发两次（重发是**外部可见的重复副作用**，
    /// 与留痕去重的「宁重复不吞」取舍方向相反——那边多一条提示无害，这边可能让
    /// agent 把同一句话做两遍）。
    pub fn cancel_requested_for_current_turn(&self) -> bool {
        match self.activity.lock() {
            Ok(st) => st.cancel_requested_generation == Some(st.prompt_generation),
            Err(poisoned) => {
                let st = poisoned.into_inner();
                st.cancel_requested_generation == Some(st.prompt_generation)
            }
        }
    }

    /// 领取**当前世代**的留痕权：同一世代只允许一个调用方通过（幂等「只写一条」）。
    ///
    /// 等价于 `claim_turn_end_notice(prompt_generation())`，但**取世代 + 比较 + 赋值
    /// 在同一次持锁中完成**，消除了两步调用之间的 TOCTOU 窗口（见
    /// [`Self::prompt_generation`] 的警告与下方锁顺序说明）。这是生产路径应当使用的
    /// 入口；[`Self::claim_turn_end_notice`] 保留给「世代由调用方自己掌握」的场景
    /// （测试、以及将来需要按历史世代补留痕的调用方）。
    ///
    /// 返回 `true` = 本次调用方赢得了留痕权，应继续写库 + 广播；`false` = 本世代
    /// 已留过痕（或锁中毒），调用方必须跳过。
    ///
    /// ## 锁顺序（防死锁）
    ///
    /// 临界区内要碰两把不同的锁：`activity`（取世代）与 `last_noticed_generation`
    /// （比较 + 写入去重键）。全仓固定顺序为 **`activity` → `last_noticed_generation`**，
    /// 即先取 `activity` 的世代值，再按序加第二把锁。死锁需要「两个线程以相反顺序
    /// 各持一把锁并等待对方」；既然本方法是仓库内**唯一**同时握持这两把锁的地方，
    /// 且顺序固定，第二把锁的等待不可能形成环。
    ///
    /// 之所以不采用「只锁 `last_noticed_generation`、另用原子量读世代」：世代由
    /// `mark_prompt_active` 在 `activity` 临界区内 `wrapping_add(1)` 维护，把它拆成
    /// 第二份状态就要同时改两处写入点，反而制造新的不一致面。
    ///
    /// **持锁期间不 await**：临界区只做一次读、一次比较与一次赋值，调用方在拿到结果
    /// 后才去写库。std Mutex 的 guard 跨 await 会破坏 `Send`（所有调用方都在
    /// `tokio::spawn` 的任务里），并让一个慢 DB 阻塞所有读活跃度的路径。
    pub fn claim_turn_end_notice_for_current_turn(&self) -> bool {
        // 第一步：在 `activity` 锁内取世代。锁 poisoning 时取回数据继续（见
        // `claim_notice_for_generation` 的中毒语义说明），与 `prompt_generation()`
        // 的「不 panic」口径一致。
        let generation = match self.activity.lock() {
            Ok(st) => st.prompt_generation,
            Err(poisoned) => poisoned.into_inner().prompt_generation,
        };
        // 第二步：**`activity` 锁已在此释放**，再按固定顺序取第二把锁并完成比较 +
        // 赋值。之所以可以先放掉第一把：上面拿到的是世代的值拷贝，此后
        // `mark_prompt_active` 再递增也改不到它；而「本世代是否已留痕」只依赖这个
        // 拷贝与 `last_noticed_generation`，两者在第二步里被同一把锁覆盖，故
        // 判定 + 写入依然原子。gap 里发生的新 prompt 属于**新世代**，由它自己的
        // 调用方去 claim —— 这正是消除 TOCTOU 的关键：旧写法让旧调用方拿到新世代，
        // 于是新旧两轮抢同一个留痕权。
        claim_notice_for_generation(&self.last_noticed_generation, generation)
    }

    /// 广播 turn 结束事件（无订阅者时静默丢弃）。
    pub fn notify_turn_end(&self, event: TurnEndEvent) {
        let _ = self.turn_end_tx.send(event);
    }

    /// 广播后端主动产生的系统通知（权限超时回收告知等；无订阅者时静默丢弃）。
    pub fn notify_system_message(&self, notice: SystemNotice) {
        let _ = self.system_notice_tx.send(notice);
    }

    pub fn permission_subscribe(&self) -> broadcast::Receiver<PermissionRequestEvent> {
        self.permission_manager.subscribe()
    }

    /// 订阅审批解决事件（载荷为审批 id），供 WS 层广播 `permission_resolved` 帧。
    pub fn permission_resolved_subscribe(&self) -> broadcast::Receiver<String> {
        self.permission_manager.resolved_subscribe()
    }

    pub async fn resolve_permission(&self, id: &str, option_id: &str) -> bool {
        let resolved = self.permission_manager.resolve(id, option_id).await;
        // 只在本次调用真正消费掉未决审批时才结束一段等待计时：`false` 意味着该 id 已被
        // 其他连接应答过，重复 end_wait 会让等待计数向下漂移（计划 D4）。
        if resolved {
            self.accumulator.end_wait();
        }
        resolved
    }

    pub async fn set_config_option(&self, config_id: &str, value: &str) -> Result<(), AcpError> {
        let config_id: Arc<str> = config_id.into();
        let value: Arc<str> = value.into();

        let is_boolean = self
            .initial_config_options
            .lock()
            .ok()
            .map(|opts| {
                opts.iter()
                    .any(|o| o.id.0 == config_id && matches!(o.kind, SessionConfigKind::Boolean(_)))
            })
            .unwrap_or(false);

        let option_value = if is_boolean {
            SessionConfigOptionValue::boolean(value.as_ref() == "true")
        } else {
            SessionConfigOptionValue::from(value.as_ref())
        };

        let resp = self
            .connection
            .send_request(SetSessionConfigOptionRequest::new(
                self.session_id.clone(),
                SessionConfigId::new(config_id.clone()),
                option_value,
            ))
            .block_task()
            .await?;

        // Agents return the updated option set in the response; not all of
        // them also push a ConfigOptionUpdate notification (codebuddy does,
        // ccb/opencode don't), so synthesize one to keep the UI in sync.
        let new_opts = resp.config_options;
        if !new_opts.is_empty() {
            if let Ok(mut guard) = self.initial_config_options.lock() {
                *guard = new_opts.clone();
            }
            let notification = SessionNotification::new(
                self.session_id.clone(),
                SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(new_opts.clone())),
            );
            // 合成的 config 更新不属于任何 turn，seq 为 None（前端无条件应用）。
            let _ = self.session_update_tx.send(SeqNotification { seq: None, notification });
        }
        // 快照落库：已结束会话的配置栏按此只读展示（restore_config_prefs 复用本
        // 方法逐项写回偏好值，快照随之收敛到用户上次所见）。空集合在
        // persist_config_snapshot 内跳过，缓存与快照均保持原值。
        if let Some(handle) = self.config_prefs.lock().ok().and_then(|g| g.clone()) {
            config_prefs::persist_config_snapshot(&handle, &new_opts).await;
        }
        // 配置变更持久化：只记用户主动 set（restore 路径调用本方法写回相同值，幂等）。
        // 失败仅 warn，不阻断 agent 配置生效。
        if let Some(handle) = self.config_prefs.lock().ok().and_then(|g| g.clone()) {
            if let Err(e) = config_prefs::save_session_config(
                &handle.db,
                &handle.db_session_id,
                &config_id,
                &value,
            )
            .await
            {
                tracing::warn!(config_id = %config_id, "save session config failed: {}", e);
            }
            if let Err(e) =
                config_prefs::save_agent_pref(&handle.db, &handle.agent_id, &config_id, &value)
                    .await
            {
                tracing::warn!(config_id = %config_id, "save agent config pref failed: {}", e);
            }
        }
        Ok(())
    }

    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    pub async fn send_prompt(
        &self,
        text: &str,
        images: Vec<ImageInput>,
        resources: Vec<ResourceInput>,
        files: Vec<FileInput>,
    ) -> Result<PromptResponse, AcpError> {
        // 不支持 embeddedContext 的 agent：@ 引用文件内容内联进 text（§8 多实现兼容）。
        // 附件文件不参与此降级：WS 层已按能力拒绝带 files 的 prompt，能走到这里
        // 就说明 agent 声明了 embeddedContext。
        let inline_resources = !self.supports_embedded_context && !resources.is_empty();
        let text = if inline_resources {
            let mut t = text.to_string();
            for r in &resources {
                t.push_str(&format!("\n\n--- @{} ---\n```\n{}\n```", r.label, r.text));
            }
            t
        } else {
            text.to_string()
        };

        let mut attempt: u32 = 0;
        loop {
            // 每次尝试都从原始附件重建 blocks（重发是低频兜底路径，克隆一份 base64
            // 的代价相对一次模型往返可忽略）。
            let blocks = build_prompt_blocks(
                &text,
                images.clone(),
                resources.clone(),
                files.clone(),
                inline_resources,
            );
            let resp = self
                .connection
                .send_request(PromptRequest::new(self.session_id.clone(), blocks))
                .block_task()
                .await?;

            // 粘滞取消兜底（§8 多实现兼容）：本世代用户并没请求 cancel，agent 却回了
            // `cancelled` —— 实测 codebuddy 清理上一轮 cancel 状态是异步的，紧随其后的
            // prompt（聊天队列的 drain 正是这个时序）会被秒回 cancelled 且**不生成
            // userMessageId**，即这条用户消息被静默吞掉。等一小会儿原样重发。
            // 判据用「有没有对应的 cancel 请求」而不是量延时：延时随机器负载漂移，
            // 250ms 实测仍会被吞。有界：超限后按真实终态返回，交调用方留痕。
            if resp.stop_reason == StopReason::Cancelled
                && attempt < STALE_CANCEL_MAX_RETRIES
                && !self.cancel_requested_for_current_turn()
            {
                attempt += 1;
                tracing::warn!(
                    session_id = %self.session_id,
                    attempt,
                    "agent 对未被 cancel 的 prompt 返回 cancelled（疑似上一轮 cancel 的粘滞窗口），{}ms 后重发",
                    STALE_CANCEL_RETRY_DELAY_MS
                );
                tokio::time::sleep(Duration::from_millis(STALE_CANCEL_RETRY_DELAY_MS)).await;
                continue;
            }
            return Ok(resp);
        }
    }

    pub fn cancel(&self) -> Result<(), AcpError> {
        // 先记录「用户取消的是哪一轮」再发通知：`send_prompt` 的粘滞取消判定
        // （[`Self::cancel_requested_for_current_turn`]）可能在通知往返期间就读这个状态，
        // 顺序反过来会把自己刚发出的 cancel 判成「不是用户要的」。
        if let Ok(mut st) = self.activity.lock() {
            st.cancel_requested_generation = Some(st.prompt_generation);
        }
        self.connection.send_notification(CancelNotification::new(self.session_id.clone()))?;
        // ACP 规范：session/cancel 后 MUST 以 Cancelled 应答所有未决权限请求。
        let pm = self.permission_manager.clone();
        tokio::spawn(async move { pm.cancel_all().await });
        // 未决审批就地全部结束 → 等待区间到此为止。不结的话若 agent 无视 cancel 继续
        // 干活，那段收尾时间会被算成「等真人」（会话累计虚高、work 虚低）。
        self.accumulator.end_all_waits();
        let tm = self.terminal_manager.clone();
        tokio::spawn(async move { tm.kill_all().await });
        Ok(())
    }

    pub fn supports_load_session(&self) -> bool {
        self.supports_load_session
    }

    pub fn supports_image(&self) -> bool {
        self.supports_image
    }

    /// `promptCapabilities.embeddedContext`：是否接受 `ContentBlock::Resource`
    /// （@path 文本引用与文件附件的 blob 形态共用此门控）。
    pub fn supports_embedded_context(&self) -> bool {
        self.supports_embedded_context
    }

    /// ACP 连接是否仍可发送请求（agent 子进程存活且未被释放）。
    /// 供 WS 层在 prompt 到达时判断是否需要自动恢复：reaper 空闲回收 / 手动
    /// release / 后端重启 / agent 崩溃后返回 false。
    ///
    /// **判定依据**：`alive` 显式标志（`shutdown`/`disconnect` 置 false）+ 库的
    /// `is_incoming_closed()`（agent 崩溃等异常退出走 EOF）。两者缺一不可——
    /// 主动 shutdown 不会触发 incoming EOF，仅靠 `is_incoming_closed()` 会误判
    /// 已释放的连接为存活，导致发送即报 "connection is no longer running"。
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire) && !self.connection.is_incoming_closed()
    }

    // ---- 活跃度跟踪（供空闲回收看护任务 reaper 使用）----

    /// 收到任意 agent 通知时刷新最后活动时间。
    pub fn mark_activity(&self) {
        if let Ok(mut st) = self.activity.lock() {
            st.last_activity = Instant::now();
        }
    }

    /// 标记有进行中的 prompt（由 WS handler 在收到用户 prompt 时调用）。
    pub fn mark_prompt_active(&self) {
        if let Ok(mut st) = self.activity.lock() {
            st.active_prompt = true;
            st.prompt_generation = st.prompt_generation.wrapping_add(1);
            st.last_activity = Instant::now();
        }
        // 用户 prompt 是唯一的 turn 起点：开启累积器 turn 门控。load_session 重放
        // 从不走此路径，故重放帧不会被折叠进 streaming 行（结构性排除）。
        self.accumulator.begin_turn();
    }

    /// 标记 prompt 已结束（由 prompt 任务在 send_prompt 返回时调用，
    /// cancel 路径经 [`Self::spawn_cancel_turn_fallback`] 超时兜底调用）。
    pub fn mark_prompt_idle(&self) {
        if let Ok(mut st) = self.activity.lock() {
            st.active_prompt = false;
        }
        // turn 结束（正常完成 / 出错 / 取消）统一定稿进行中的 assistant 行（幂等）。
        self.accumulator.finalize_turn();
    }

    /// cancel 的 turn 收尾兜底。
    ///
    /// 正常路径：合作的 agent 收到 `session/cancel` 后让 `send_prompt` 以
    /// `Cancelled` 返回，prompt 任务照常定稿 turn 并广播结束——取消后 agent
    /// 补发的尾部帧（收尾文本等）得以落库。但无视 cancel 的实现可能永不
    /// 返回（§8 多实现兼容），超时后若同一 turn 仍在进行则强制定稿 + 广播
    /// 结束，防止会话永久卡在运行中。世代守卫避免误杀取消后新发起的 turn。
    pub fn spawn_cancel_turn_fallback(self: &Arc<Self>) {
        let generation = {
            let Ok(st) = self.activity.lock() else { return };
            if !st.active_prompt {
                return;
            }
            st.prompt_generation
        };
        let client = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(CANCEL_TURN_FALLBACK_SECS)).await;
            let same_turn_still_active = {
                let Ok(st) = client.activity.lock() else { return };
                st.active_prompt && st.prompt_generation == generation
            };
            if same_turn_still_active {
                tracing::warn!(
                    "agent 未在 {}s 内响应 session/cancel，强制定稿进行中 turn（兜底）",
                    CANCEL_TURN_FALLBACK_SECS
                );
                client.mark_prompt_idle();
                // `abnormal: false`：本路径是**合成的非协议原因**（agent 无视 cancel
                // 时的兜底定稿），并不是协议回了非正常 stopReason；且此处不写留痕
                // system 消息（计划 D3 之外），若报 error 语义就会出现「有错误提示、
                // 无任何解释文案」。保持既有行为：前端只按 `stop_reason == Cancelled`
                // 走取消文案。
                client.notify_turn_end(TurnEndEvent::Done {
                    stop_reason: "Cancelled".into(),
                    row_id: client.turn_row_id(),
                    duration: client.turn_timing(),
                    abnormal: false,
                });
            }
        });
    }

    /// 绑定持久化并启动防抖 writer。仅在真实会话注册点调用（create-session /
    /// load_session restore）；能力探针不调用 → 折叠为内存 no-op（见 turn_accumulator）。
    pub fn attach_persistence(&self, db: sqlx::SqlitePool, db_session_id: String) {
        self.accumulator.attach_persistence(db, db_session_id);
    }

    /// 绑定配置偏好持久化句柄。仅在真实会话注册点调用（create-session /
    /// load_session restore）；能力探针不调用 → 写入与恢复均为 no-op。
    /// 绑定后立即把当前 `initial_config_options` 落快照：create 路径在 attach 前
    /// session/new 响应里的配置无处落库；load 路径此时缓存恒空（跳过），由
    /// `load_session` / `set_config_option` / agent 推送后续覆盖。
    pub async fn attach_config_prefs(
        &self,
        db: sqlx::SqlitePool,
        db_session_id: String,
        agent_id: String,
    ) {
        if let Ok(mut guard) = self.config_prefs.lock() {
            *guard = Some(config_prefs::ConfigPrefsHandle { db, db_session_id, agent_id });
        }
        let opts = self.initial_config_options.lock().ok().map(|g| g.clone()).unwrap_or_default();
        if let Some(handle) = self.config_prefs.lock().ok().and_then(|g| g.clone()) {
            config_prefs::persist_config_snapshot(&handle, &opts).await;
        }
    }

    /// 恢复持久化的配置偏好（agent 级偏好 + 会话级覆盖，会话级优先）。
    ///
    /// **必须在 `initial_config_options` 缓存已填充后调用**：
    /// - create 路径：`spawn_and_connect` 已走 `NewSession`，缓存已填充（新建会话后即可调用）；
    /// - load 路径：`spawn_and_load` 的缓存恒为空（不发送 NewSession），必须等
    ///   `load_session` 返回（缓存被 `LoadSessionResponse.config_options` 回填）后再调用。
    ///
    /// 过滤规则（§8 多实现兼容）：`config_id` 不在 agent 当前配置集合中 → 跳过
    /// （agent 已移除该项）；`config_prefs::validate_config_value` 不过 → 跳过。
    /// 单项目失败静默跳过 + warn；整体 10s 超时，防止拖慢会话建立/恢复。
    pub async fn restore_config_prefs(&self) {
        let Some(handle) = self.config_prefs.lock().ok().and_then(|g| g.clone()) else {
            return;
        };
        // 会话级覆盖 agent 级（restore 同一 session 时用户上次的会话内设置优先）。
        let agent =
            config_prefs::list_agent_prefs(&handle.db, &handle.agent_id).await.unwrap_or_default();
        let session = config_prefs::list_session_configs(&handle.db, &handle.db_session_id)
            .await
            .unwrap_or_default();
        let merged = config_prefs::merge_prefs(agent, session);
        if merged.is_empty() {
            return;
        }

        let opts = self.initial_config_options.lock().ok().map(|g| g.clone()).unwrap_or_default();
        let client = self;
        let applied = async move {
            for (config_id, value) in merged {
                // config_id 已不在 agent 当前集合 → 跳过（残留行下次恢复仍被过滤）。
                let Some(opt) = opts.iter().find(|o| o.id.0.as_ref() == config_id) else {
                    continue;
                };
                if !config_prefs::validate_config_value(opt, &value) {
                    tracing::warn!(
                        config_id = %config_id,
                        value = %value,
                        "restore config value rejected (not in agent options); skipping"
                    );
                    continue;
                }
                if let Err(e) = client.set_config_option(&config_id, &value).await {
                    tracing::warn!(config_id = %config_id, "restore config option failed: {}", e);
                }
            }
        };
        match tokio::time::timeout(Duration::from_secs(10), applied).await {
            Ok(()) => {}
            Err(_) => tracing::warn!("restore_config_prefs timed out after 10s"),
        }
    }

    /// 连接时的进行中 turn 快照，供 WS 层下发 turn_state / turn_snapshot 帧，
    /// 让重连客户端无缝续接（见 turn_accumulator / WS turn_snapshot 帧）。
    pub fn turn_snapshot(&self) -> TurnSnapshot {
        self.accumulator.turn_snapshot()
    }

    /// 当前未决权限请求数（requires_action 语义）。
    pub async fn pending_permissions(&self) -> usize {
        self.permission_manager.pending_count().await
    }

    /// 未决审批事件快照（WS 连接/重连时重放，恢复前端 banner）。
    pub async fn pending_permission_events(&self) -> Vec<PermissionRequestEvent> {
        self.permission_manager.pending_events().await
    }

    /// 是否静默待命超时：无进行中 prompt、无未决权限、且距最后活动已满 idle_secs。
    pub async fn is_idle_stale(&self, idle_secs: u64) -> bool {
        let (active_prompt, last_activity) = {
            let st = self.activity.lock().unwrap();
            (st.active_prompt, st.last_activity)
        };
        let pending = self.permission_manager.pending_count().await;
        !active_prompt && pending == 0 && last_activity.elapsed().as_secs() >= idle_secs
    }

    /// 是否权限请求超时无响应：有未决权限但久无活动（agent 等用户却无人应答）。
    pub async fn is_permission_stale(&self, perm_secs: u64) -> bool {
        let last_activity = {
            let st = self.activity.lock().unwrap();
            st.last_activity
        };
        let pending = self.permission_manager.pending_count().await;
        pending > 0 && last_activity.elapsed().as_secs() >= perm_secs
    }

    /// 是否 prompt 疑似卡死：有进行中 prompt 但久无 agent 通知（agent 可能从未
    /// 发送 PromptResponse，§8 多实现兼容兜底）。reaper 据此强制定稿 turn，
    /// 避免前端永久卡在 running 态。
    pub fn is_prompt_stale(&self, stale_secs: u64) -> bool {
        let Ok(st) = self.activity.lock() else { return false };
        st.active_prompt && st.last_activity.elapsed().as_secs() >= stale_secs
    }

    pub async fn load_session(&self, acp_session_id: &str, cwd: PathBuf) -> Result<(), AcpError> {
        let resp = self
            .connection
            .send_request(LoadSessionRequest::new(SessionId::new(acp_session_id), cwd))
            .block_task()
            .await?;

        // 优先用 load 响应里的 config；opencode 等 agent 不在 session/load 响应里
        // 返回 config_options，回退到创建会话时缓存的 initial_config_options（与
        // set_config_option 的兜底逻辑一致），保证恢复后配置栏仍有数据可显示。
        let opts: Option<Vec<SessionConfigOption>> =
            resp.config_options.filter(|o| !o.is_empty()).or_else(|| {
                self.initial_config_options.lock().ok().map(|g| g.clone()).filter(|g| !g.is_empty())
            });
        if let Some(opts) = opts {
            if let Ok(mut guard) = self.initial_config_options.lock() {
                *guard = opts.clone();
            }
            if let Some(handle) = self.config_prefs.lock().ok().and_then(|g| g.clone()) {
                config_prefs::persist_config_snapshot(&handle, &opts).await;
            }
            let notification = SessionNotification::new(
                self.session_id.clone(),
                SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(opts)),
            );
            // 合成的 config 更新不属于任何 turn，seq 为 None（前端无条件应用）。
            let _ = self.session_update_tx.send(SeqNotification { seq: None, notification });
        }
        Ok(())
    }

    /// Builds a `ConfigOptionUpdate` notification from the config options the
    /// agent returned at session creation, if any. Sent to the WS on connect so
    /// the toolbar has data before the first prompt turn.
    pub fn initial_config_notification(&self) -> Option<SessionNotification> {
        let opts = self.initial_config_options.lock().ok()?.clone();
        if opts.is_empty() {
            return None;
        }
        Some(SessionNotification::new(
            self.session_id.clone(),
            SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(opts)),
        ))
    }

    /// Returns the cached `AvailableCommandsUpdate` notification, if the agent
    /// already pushed one. Sent to the WS on connect so the slash-command
    /// autocomplete has data even though the notification predates the WS.
    pub fn initial_commands_notification(&self) -> Option<SessionNotification> {
        self.available_commands_notif.lock().ok()?.clone()
    }

    pub async fn spawn_and_load(
        agent: Agent,
        cwd: PathBuf,
        acp_session_id: String,
        api_keys: &std::collections::HashMap<String, String>,
    ) -> Result<Self, AcpError> {
        Self::spawn_with_session(agent, cwd, api_keys, SessionMode::Load(acp_session_id)).await
    }

    /// 通过 shared reference 回收所有子进程并通知连接任务退出。
    /// 供 [`AcpSupervisor::shutdown_all`] 在持有 `Arc<AcpClient>` 时调用
    /// （`disconnect` 消费 self，无法在 Arc 上使用）。
    pub async fn shutdown(&self) {
        // 先置存活标志 false：即使 teardown 尚未完成，prompt 到达时也应走自动恢复。
        self.alive.store(false, Ordering::Release);
        // 定稿进行中的 turn：优雅关闭让连接任务以 Ok 返回，crash watcher 的兜底（只在
        // Err 时定稿）不会触发。不补这一刀，那段时间既不进会话累计、消息行也永远停在
        // streaming 态（幂等，已在别处定稿时这里是 no-op）。
        self.mark_prompt_idle();
        self.terminal_manager.kill_all().await;
        // D3 顺序链：killpg 插在优雅收尾之后、signal 之前。kill 让 crate 内部
        // pidfd 等待路径的 try_wait 立即返回退出状态，从根上打破连接 poll 空转
        // （2026-09-21 CPU 尖峰止血，见 agent_proc 模块文档）；正常路径 agent
        // 本就在 signal 后退出，kill 为 no-op（ESRCH 忽略 → 幂等），不破坏上面
        // 的优雅收尾。注意 kill 会让 crate 的 finish_child_exit 返回
        // "exited with signal 9" Err——连接任务随之以 Err 结束，但 alive 已置
        // false，crash watcher 据此判定为主动关闭、静默不广播（见 spawn_crash_watcher）。
        let pid = self.agent_pid();
        tracing::debug!(?pid, "ACP shutdown: kill agent 进程组（D2），随后发优雅关闭信号");
        agent_proc::kill_agent_process_group(pid);
        // 取出并 drop shutdown_tx → 连接任务的 shutdown_rx 收到 RecvError 后退出。
        // lock().await 安全：shutdown_tx 仅在此处和 disconnect 中被 take，
        // 且调用方不会跨 await 持有此锁。
        let _ = self._shutdown_tx.lock().unwrap().take();
        // D4：signal 之后置的 abort 兜底。abort 只做本地资源清理（杀不了 agent
        // 进程，ChildGuard 归 crate 内部 task_actor 所有），正常路径下连接任务
        // 多已自行结束、abort_rx 随 watcher 退出被 drop，send 失败静默。
        if let Ok(mut guard) = self._abort_tx.lock()
            && let Some(tx) = guard.take()
        {
            let _ = tx.send(());
        }
    }

    pub async fn disconnect(self) {
        self.alive.store(false, Ordering::Release);
        // 同 shutdown：优雅断开路径不经过 crash watcher，须自行定稿进行中 turn。
        self.mark_prompt_idle();
        // 回收本会话可能创建的终端子进程（kill_on_drop 依赖 TerminalProcess 被 drop，
        // 但 spawned 的 wait task 持有 Child 句柄，需显式 kill_all 通知其退出）。
        self.terminal_manager.kill_all().await;
        // D2/D3：与 shutdown 同口径——先 killpg 再 signal（探针与 WS 层的释放
        // 路径，语义一致，差异仅在 self 被消费）。
        let pid = self.agent_pid();
        tracing::debug!(?pid, "ACP disconnect: kill agent 进程组（D2），随后发优雅关闭信号");
        agent_proc::kill_agent_process_group(pid);
        if let Ok(mut guard) = self._shutdown_tx.try_lock() {
            let _ = guard.take();
        }
        if let Ok(mut guard) = self._abort_tx.try_lock()
            && let Some(tx) = guard.take()
        {
            let _ = tx.send(());
        }
        // 注意：agent 连接任务句柄已移交给 `spawn_crash_watcher`，由其负责在
        // 连接异常退出时广播错误；此处不再 `await`，仅触发优雅关闭。
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    // ── build_prompt_blocks / file_uri：prompt 内容块组装 ──────────────

    fn img(data: &str) -> ImageInput {
        ImageInput { data: data.into(), mime_type: "image/png".into(), thumb: None }
    }

    fn file(name: &str, data: &str) -> FileInput {
        FileInput {
            name: name.into(),
            mime_type: "application/pdf".into(),
            size: 3,
            data: data.into(),
        }
    }

    fn at_resource(label: &str) -> ResourceInput {
        ResourceInput {
            uri: format!("file:///w/{}", label),
            label: label.into(),
            text: "fn main() {}".into(),
        }
    }

    #[test]
    fn prompt_blocks_text_only_has_single_text_block() {
        let blocks = build_prompt_blocks("hi", vec![], vec![], vec![], false);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0], ContentBlock::Text(_)));
    }

    #[test]
    fn prompt_blocks_empty_prompt_without_attachments_keeps_empty_text_block() {
        // 历史行为不变：无任何附件时始终有 Text block（哪怕空文本）
        let blocks = build_prompt_blocks("", vec![], vec![], vec![], false);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0], ContentBlock::Text(_)));
    }

    #[test]
    fn prompt_blocks_image_only_omits_empty_text_block() {
        let blocks = build_prompt_blocks("", vec![img("AAA")], vec![], vec![], false);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0], ContentBlock::Image(_)));
    }

    #[test]
    fn prompt_blocks_file_only_omits_empty_text_block() {
        let blocks = build_prompt_blocks("", vec![], vec![], vec![file("a.pdf", "AAA")], false);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0], ContentBlock::Resource(_)));
    }

    #[test]
    fn prompt_blocks_order_text_image_text_resource_blob() {
        let blocks = build_prompt_blocks(
            "hi",
            vec![img("IMG")],
            vec![at_resource("a.rs")],
            vec![file("d.pdf", "PDF")],
            false,
        );
        assert_eq!(blocks.len(), 4);
        assert!(matches!(blocks[0], ContentBlock::Text(_)));
        assert!(matches!(blocks[1], ContentBlock::Image(_)));
        assert!(matches!(blocks[2], ContentBlock::Resource(_)));
        assert!(matches!(blocks[3], ContentBlock::Resource(_)));
    }

    #[test]
    fn prompt_blocks_file_maps_to_blob_resource_with_mime_and_uri() {
        let blocks =
            build_prompt_blocks("", vec![], vec![], vec![file("my file.pdf", "PDFDATA")], false);
        let blob = match &blocks[0] {
            ContentBlock::Resource(res) => match &res.resource {
                EmbeddedResourceResource::BlobResourceContents(b) => b,
                _ => panic!("expected blob resource contents"),
            },
            _ => panic!("expected resource block"),
        };
        assert_eq!(blob.blob, "PDFDATA");
        assert_eq!(blob.mime_type.as_deref(), Some("application/pdf"));
        assert_eq!(blob.uri, "file:///my%20file.pdf");
    }

    #[test]
    fn prompt_blocks_inlines_at_resources_when_embedded_unsupported() {
        // 回归保护：不支持 embeddedContext 时 @path 文本资源内联进 text 且不产出
        // Resource 块；附件文件不走此降级（WS 层已按能力拒绝，不会传到这里）。
        let inlined = "see\n\n--- @a.rs ---\n```\nfn main() {}\n```";
        let blocks = build_prompt_blocks(inlined, vec![], vec![at_resource("a.rs")], vec![], true);
        assert_eq!(blocks.len(), 1);
        let ContentBlock::Text(t) = &blocks[0] else {
            panic!("expected text block");
        };
        assert!(t.text.contains("@a.rs"));
    }

    #[test]
    fn file_uri_percent_encodes_uri_breakers() {
        assert_eq!(file_uri("a b#c?d%e.pdf"), "file:///a%20b%23c%3Fd%25e.pdf");
        // 非 ASCII 原样保留：名义 URI 仅供标识，agent 应消费内联 blob
        assert_eq!(file_uri("报告.pdf"), "file:///报告.pdf");
    }

    // ── claim_notice_for_generation：留痕权的世代去重（2026-09 TOCTOU 修复）──
    //
    // 直接测抽出来的自由函数而不是 `AcpClient` 方法：构造一个 `AcpClient` 需要 spawn
    // 真 agent 子进程（见 `acp::fake_agent_tests`），而这里要守的纯粹是「比较 + 赋值
    // 在同一把锁内」这条不变式 —— 与连接、DB、广播都无关。
    //
    // 为什么值得单测：这是「只写一条」的唯一实现，两个公开方法都走它。它的回归形态
    // 是把比较与赋值拆开（或丢掉 `Some(generation)` 里的世代），后果是同一轮失败向用户
    // 展示两条相同提示，或新一轮的提示被上一轮的守卫吞掉。

    #[test]
    fn claim_notice_first_call_for_a_generation_wins() {
        let noticed = Mutex::new(None);
        assert!(claim_notice_for_generation(&noticed, 1), "首个世代必然赢得留痕权");
    }

    #[test]
    fn claim_notice_same_generation_is_deduplicated() {
        // 「只写一条」的核心：同一世代重复 claim 必须被拦下。
        let noticed = Mutex::new(None);
        assert!(claim_notice_for_generation(&noticed, 7));
        assert!(!claim_notice_for_generation(&noticed, 7), "同世代第二次必须被拦");
        assert!(!claim_notice_for_generation(&noticed, 7), "第三次同样被拦");
        assert_eq!(*noticed.lock().unwrap(), Some(7));
    }

    #[test]
    fn claim_notice_next_generation_gets_its_own_slot() {
        // 世代是滚动的：新 prompt = 新世代，守卫不得把新一轮的失败提示吞掉。
        let noticed = Mutex::new(None);
        assert!(claim_notice_for_generation(&noticed, 1));
        assert!(!claim_notice_for_generation(&noticed, 1));
        assert!(claim_notice_for_generation(&noticed, 2), "新世代必须重新赢得留痕权");
        assert!(!claim_notice_for_generation(&noticed, 2));
        assert_eq!(*noticed.lock().unwrap(), Some(2));
    }

    #[test]
    fn claim_notice_generation_zero_is_a_real_generation_not_sentinel() {
        // 世代 0 是合法值（首个 prompt 之前）——`Option` 的存在意义就是把「未写过」
        // 与「写过世代 0」区分开。若实现退化成 `0 = 未写过`，这条会红。
        let noticed = Mutex::new(None);
        assert!(claim_notice_for_generation(&noticed, 0), "世代 0 也应当赢得留痕权");
        assert!(!claim_notice_for_generation(&noticed, 0), "世代 0 的重复 claim 同样被拦");
        assert_eq!(*noticed.lock().unwrap(), Some(0));
    }

    #[test]
    fn claim_notice_poisoned_lock_still_grants_rather_than_silently_dropping() {
        // 中毒语义（2026-09 改）：取回数据继续判定，而不是「宁缺勿滥」地 return false。
        // 留痕是「这一轮为什么失败」的唯一载体，吞掉它等于重演事故形态（turn 静默结束、
        // 无任何提示）；放行的代价只是可能重复一条相同提示（可发现、可删会话）。
        let noticed = Mutex::new(None);
        // 制造 poison：持锁期间 panic。
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = noticed.lock().unwrap();
            panic!("poison the lock on purpose");
        }));
        assert!(noticed.is_poisoned(), "前提：锁已被毒化");
        assert!(claim_notice_for_generation(&noticed, 3), "中毒也必须继续判定（宁重复，不吞）");
        assert!(!claim_notice_for_generation(&noticed, 3), "中毒下去重仍然有效");
    }

    #[test]
    fn claim_notice_concurrent_callers_yield_exactly_one_winner_per_generation() {
        // 并发下的「只写一条」：同一世代 N 个线程同时 claim，赢家必须恰好一个。
        // 这守的是「比较 + 赋值在同一把锁内」——拆成两步就会出现两个赢家。
        use std::sync::Barrier;
        const CALLERS: usize = 32;
        let noticed = std::sync::Arc::new(Mutex::new(None));
        let barrier = std::sync::Arc::new(Barrier::new(CALLERS));
        let winners = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut handles = Vec::with_capacity(CALLERS);
        for _ in 0..CALLERS {
            let noticed = std::sync::Arc::clone(&noticed);
            let barrier = std::sync::Arc::clone(&barrier);
            let winners = std::sync::Arc::clone(&winners);
            handles.push(std::thread::spawn(move || {
                // 全部线程在屏障前集结，尽量同时进入临界区。
                barrier.wait();
                if claim_notice_for_generation(&noticed, 42) {
                    winners.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }));
        }
        for h in handles {
            h.join().expect("worker thread must not panic");
        }
        assert_eq!(
            winners.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "同一世代的并发 claim 必须恰好一个赢家"
        );
        assert_eq!(*noticed.lock().unwrap(), Some(42));
    }

    #[test]
    fn claim_for_current_turn_lock_order_is_deadlock_free_under_contention() {
        // 新方法 `claim_turn_end_notice_for_current_turn` 的锁顺序：
        // activity（取世代，取完即放）→ last_noticed_generation（比较 + 赋值）。
        // 这条测试用线程并发复现该顺序，证明它不会死锁（成环需要相反顺序的握持）。
        //
        // 为什么在纯函数侧测：`AcpClient` 要 spawn 真 agent 才能构造，而这里守的
        // 是「两把锁的获取顺序」这一结构性质，与连接无关。
        use std::sync::Barrier;
        const THREADS: usize = 16;
        let activity = std::sync::Arc::new(Mutex::new(ActivityState::new()));
        let noticed = std::sync::Arc::new(Mutex::new(None));
        let barrier = std::sync::Arc::new(Barrier::new(THREADS));
        let winners = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut handles = Vec::with_capacity(THREADS);
        for i in 0..THREADS {
            let activity = std::sync::Arc::clone(&activity);
            let noticed = std::sync::Arc::clone(&noticed);
            let barrier = std::sync::Arc::clone(&barrier);
            let winners = std::sync::Arc::clone(&winners);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                // 与生产方法同构：先锁 activity 读世代，**放掉之后**再锁第二把。
                let generation = {
                    let st = activity.lock().unwrap();
                    st.prompt_generation + i as u64
                };
                if claim_notice_for_generation(&noticed, generation) {
                    winners.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            }));
        }
        // 若锁顺序成环，这里会永久挂起而不是失败 —— 用 try_join 兜底转成失败，
        // 避免 CI 挂死（AGENTS.md：坏输入不得让 CI 挂死）。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        for (idx, h) in handles.into_iter().enumerate() {
            while !h.is_finished() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "线程 {idx} 超过 30s 未结束 —— 锁顺序疑似成环（死锁）"
                );
                std::thread::yield_now();
            }
            h.join().expect("worker thread must not panic");
        }
        // 每个线程用互不相同的世代，故人人都是赢家（本测试断言的是不死锁，不是去重）。
        assert_eq!(
            winners.load(std::sync::atomic::Ordering::SeqCst),
            THREADS,
            "不同世代各自赢得留痕权（顺序正确时无一被吞）"
        );
    }
}
