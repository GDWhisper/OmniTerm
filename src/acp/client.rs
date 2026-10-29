use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    BlobResourceContents, CancelNotification, ClientCapabilities, ConfigOptionUpdate, ContentBlock,
    CreateTerminalRequest, DeleteSessionRequest, EmbeddedResource, EmbeddedResourceResource,
    ImageContent, InitializeRequest, KillTerminalRequest, ListSessionsRequest, LoadSessionRequest,
    NewSessionRequest, PromptRequest, PromptResponse, ReadTextFileRequest, ReadTextFileResponse,
    ReleaseTerminalRequest, RequestPermissionRequest, SessionConfigId, SessionConfigKind,
    SessionConfigOption, SessionConfigOptionValue, SessionId, SessionInfo, SessionInfoUpdate,
    SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, StopReason, TextContent,
    TextResourceContents, WaitForTerminalExitRequest, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::{AcpAgent, Agent as AcpAgentRole, ConnectionTo, Error as AcpError};
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

use crate::acp::agent_proc;
use crate::acp::async_tasks::{
    AsyncTaskEvent, AsyncTaskRegistry, AsyncTaskUpdate, SYSTEM_LABEL_ASYNC_TASK_FINISHED,
    SYSTEM_LABEL_ASYNC_TASK_STARTED,
};
use crate::acp::chat_persistence;
use crate::acp::config_prefs;
use crate::acp::handler::{self, SeqNotification};
use crate::acp::permission::{PermissionManager, PermissionRequestEvent};
use crate::acp::reaper::PermissionTimeoutConfig;
use crate::acp::terminal::{AcpTerminalManager, TerminalActivity};
use crate::acp::title;
use crate::acp::turn_accumulator::{TurnAccumulator, TurnSnapshot, TurnStats, TurnTiming};
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

/// `session/list` 翻页的**条目数**上限（§P1：一切 collect 必须有显式上限 +
/// 超限策略 + 单测）。200 条覆盖任何真实项目的 agent 历史；超限即停并把
/// `truncated` 上报给调用方，由 UI 明示「看到的是截断后的列表」。
pub const ACP_LIST_MAX_SESSIONS: usize = 200;

/// `session/list` 翻页的**页数**上限。与条目数上限同属必需而非保险：单页条目数
/// 由 agent 决定（opencode 实测固定 limit=100），只限总条数时一个每页只回 1 条
/// 的实现就能把请求轮次放大到 200 次。
pub const ACP_LIST_MAX_PAGES: usize = 10;

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

/// turn 生命周期事件（开始 / 结束）。经 broadcast 发给所有 WS 连接：
/// prompt task 完成时发起 prompt 的连接可能已断开重连，per-connection
/// 通道会把结束帧发进死连接被静默丢弃，新连接则永远收不到结束信号。
///
/// `Started`（[`AcpClient::mark_prompt_active`] 发出）让**所有**连接——不只发
/// prompt 的那个——把 turn 置为活跃：多标签页里非发起页据此恢复计时/思考指示，
/// 迟到帧的收敛判定（前端 settled 模式以 sending 为输入）也有了可靠真值。
#[derive(Debug, Clone)]
pub enum TurnEvent {
    Started,
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
    /// 内联告知的去重 id：mid-turn 告知同时写入 assistant 行的有序帧窗口，WS 帧
    /// 携带同一 id；前端在 turn_snapshot / 聚焦补拉时据此去掉重复的独立 system
    /// 消息。`None` = 非内联告知（turn 失败等，只落独立 system 行）。
    pub notice_id: Option<String>,
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
    /// prompt 世代计数：每次 `mark_prompt_active` 递增。cancel 兜底定时器与
    /// prompt 任务的收尾守卫（`mark_prompt_idle_for_generation`）据此识别自己
    /// 要收尾的那个 turn，避免陈旧终结者误杀新发起的 turn。
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
    /// turn 生命周期事件（开始 / 结束），广播给所有 WS 连接
    /// （断线重连后的新连接也必须收到，见 [`TurnEvent`]）。
    turn_event_tx: broadcast::Sender<TurnEvent>,
    terminal_manager: Arc<AcpTerminalManager>,
    permission_manager: Arc<PermissionManager>,
    supports_load_session: bool,
    /// initialize 时 agent 通过 `promptCapabilities.image` 声明是否接受图片
    /// content block（§8 多实现兼容：未声明的 agent 不硬塞图片）。
    supports_image: bool,
    /// `promptCapabilities.embeddedContext`：是否接受 `ContentBlock::Resource`；
    /// 不支持时 @ 引用降级为内联 text（§8 多实现兼容）。
    supports_embedded_context: bool,
    /// `sessionCapabilities.delete`（marker 空结构，存在即支持）：
    /// 删除 omniterm 会话时能否顺带发 `session/delete` 抹掉 agent 侧记录。
    /// 未声明的 agent（实测 codebuddy）不发——盲发会把 method-not-found
    /// 与真失败混为一谈（计划 D3）。
    supports_delete_session: bool,
    /// `sessionCapabilities.list`（marker 空结构，存在即支持）：agent 是否声明
    /// 能枚举自己的会话历史。**只用于 turn 结束时的自动标题反查门控**——未声明
    /// 就连问都不问（实测 codebuddy 未声明且方法 `-32601`，盲问等于每轮 turn
    /// 一次无效往返 + 一条 WARN）。与 `list_sessions` 内部「不做能力 gate」是
    /// 有意的分歧：那条路径是用户显式打开面板，必须把「不支持」如实呈现；
    /// 这条是后台自动的，跳过即最优解，用户仍可用面板拿到真相。
    supports_list_session: bool,
    initial_config_options: Arc<Mutex<Vec<SessionConfigOption>>>,
    available_commands_notif: Arc<Mutex<Option<SessionNotification>>>,
    /// 配置偏好持久化句柄（`attach_config_prefs` 绑定）。仅在实际会话注册点
    /// （create-session / load restore）设置；能力探针不绑定 → 写入与恢复 no-op。
    /// `Arc` 包裹是让 agent 通知闭包（构造早于本 struct）也能对 §12.5 的
    /// `ConfigOptionUpdate` 推送落快照。用 `std::sync::Mutex<Option<_>>`：
    /// 使用时 lock 克隆 handle、立即 drop guard 再 await，避免跨 await 持 std
    /// MutexGuard 破坏 Send（replay task 是 tokio::spawn）。
    config_prefs: Arc<Mutex<Option<config_prefs::ConfigPrefsHandle>>>,
    /// 权限超时配置（`attach_perm_timeout` 绑定，main.rs 注入的共享实例）：
    /// 权限请求登记后经它唤醒 reaper 立刻检查——「总是」档（auto + 0 秒）语义是
    /// **到达即应答**，等不了 30 秒 tick。同样仅在实际会话注册点绑定；能力探针
    /// 不绑定 → 无唤醒，由 reaper 的定时 tick 兜底（探针不产生用户可见的审批）。
    perm_timeout: Arc<Mutex<Option<Arc<PermissionTimeoutConfig>>>>,
    /// 活跃度跟踪，供空闲回收看护任务（reaper）读取。
    activity: Arc<Mutex<ActivityState>>,
    /// agent 侧仍在运行的后台任务（Workflow / 后台 Bash）。
    ///
    /// ACP 核心协议没有后台任务语义：turn 以 `end_turn` 结束后宿主只看到
    /// `active_prompt = false`。适配器的 `async_task_*` 扩展帧是唯一能证明
    /// “它还在干活”的信号；`is_idle_stale` 必须把它并入判定，否则 reaper 会在
    /// 空闲阈值到达时杀掉 agent 进程，连带杀掉任务（2026-10-19 事故）。
    async_tasks: Arc<Mutex<AsyncTaskRegistry>>,
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
                    // 返回值不消费：崩溃原因经 crash_tx 走 prompt_error 帧，前端
                    // 不读耗时（该 turn 无结算语义）。
                    let _ = accumulator.finalize_turn();
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

/// `session/update` 的原始接收类型。
///
/// 不能直接用 SDK 的 `SessionNotification`：它的 `SessionUpdate` 是封闭枚举，
/// 未知的 `sessionUpdate` 值（JetBrains AIR 的 `async_task_*` 扩展）会让整个
/// 通知反序列化失败。这里先收原始 JSON，已知变体再转成 `SessionNotification`，
/// 扩展变体交给 [`AsyncTaskRegistry`]，其余按 ACP 扩展规则静默忽略。
#[derive(Debug, Clone, Serialize, Deserialize, agent_client_protocol::JsonRpcNotification)]
#[notification(method = "session/update")]
struct RawSessionNotification {
    #[serde(rename = "sessionId")]
    session_id: String,
    update: serde_json::Value,
    #[serde(default, rename = "_meta")]
    meta: Option<serde_json::Map<String, serde_json::Value>>,
}

/// initialize 时声明的客户端能力。
///
/// 只额外声明 JetBrains AIR 的 `asyncTasks` 扩展：适配器据此发送后台任务生命周期
/// 帧（`async_task_spawned` / `async_task_progress` / `async_task_state_update`）。
/// 不声明时适配器不会发这些帧，OmniTerm 既看不到进度，reaper 也会把“等待后台
/// workflow”的会话当空闲回收（2026-10-19 正式库事故）。
///
/// 其余 AIR 扩展（nativeSubagentSessions / diffPatch / planFile …）不消费，不声明；
/// 未声明的能力适配器不会发送，属于显式 opt-in。
fn initialize_request() -> InitializeRequest {
    let mut air = serde_json::Map::new();
    air.insert("version".into(), serde_json::json!(1));
    air.insert("capabilities".into(), serde_json::json!(["asyncTasks"]));
    let mut jetbrains = serde_json::Map::new();
    jetbrains.insert("air".into(), serde_json::Value::Object(air));
    let mut meta = serde_json::Map::new();
    meta.insert("jetbrains".into(), serde_json::Value::Object(jetbrains));
    let mut capabilities = ClientCapabilities::new();
    capabilities.meta = Some(meta);
    InitializeRequest::new(ProtocolVersion::V1).client_capabilities(capabilities)
}

/// 通知分流的共享依赖。字段集持续扩展（activity / accumulator / commands /
/// config / async tasks / notices / broadcast），用具名结构而非位置参数——
/// 新增一条通路时不会因参数顺序错位而静默串线（工程准则 7③）。
struct NotificationContext<'a> {
    activity: &'a Arc<Mutex<ActivityState>>,
    accumulator: &'a Arc<TurnAccumulator>,
    commands_notif: &'a Arc<Mutex<Option<SessionNotification>>>,
    config_prefs_slot: &'a Arc<Mutex<Option<config_prefs::ConfigPrefsHandle>>>,
    async_tasks: &'a Arc<Mutex<AsyncTaskRegistry>>,
    system_notice_tx: &'a broadcast::Sender<SystemNotice>,
    tx: &'a broadcast::Sender<SeqNotification>,
}

/// 原始 `session/update` 的分流入口。
///
/// - 已知 `SessionUpdate`：转回 `SessionNotification`，走原有累积/落库/广播链路；
/// - `async_task_*`：更新注册表，开始/结束各产出一次系统消息；
/// - 其他未知扩展：只刷新活动时间后忽略（agent 还活着，但不猜测语义）。
async fn on_raw_agent_notification(
    context: NotificationContext<'_>,
    raw: RawSessionNotification,
) -> Result<(), agent_client_protocol::Error> {
    // 任意通知都刷新最后活动时间——扩展帧同样证明 agent 在干活。
    if let Ok(mut st) = context.activity.lock() {
        st.last_activity = Instant::now();
    }

    let RawSessionNotification { session_id, update, meta } = raw;
    // 先看判别串再决定解析目标：已知帧不复制 update（tool_call 的 rawInput 可能
    // 很大，P1 的字节维度不能在热路径上再翻一倍）。
    let is_async_task = update
        .get("sessionUpdate")
        .and_then(|value| value.as_str())
        .is_some_and(|kind| kind.starts_with("async_task_"));

    if is_async_task {
        match serde_json::from_value::<AsyncTaskUpdate>(update) {
            Ok(update) => {
                let event = match context.async_tasks.lock() {
                    Ok(mut registry) => registry.apply(update),
                    Err(poisoned) => poisoned.into_inner().apply(update),
                };
                if let Some(event) = event {
                    emit_async_task_event(
                        context.config_prefs_slot,
                        context.system_notice_tx,
                        event,
                    )
                    .await;
                }
            }
            Err(parse_error) => {
                tracing::debug!(error = %parse_error, "ignoring malformed async task update");
            }
        }
        return Ok(());
    }

    match serde_json::from_value::<SessionUpdate>(update) {
        Ok(update) => {
            let notification = SessionNotification::new(SessionId::new(session_id), update);
            let notification = match meta {
                Some(meta) => notification.meta(Some(meta)),
                None => notification,
            };
            on_agent_notification(
                context.activity,
                context.accumulator,
                context.commands_notif,
                context.config_prefs_slot,
                context.tx,
                notification,
            )
            .await
        }
        Err(parse_error) => {
            // ACP 扩展规则：不识别的通知 SHOULD 忽略。只留 debug，避免未知厂商
            // 扩展把连接日志刷满。
            tracing::debug!(error = %parse_error, "ignoring unknown session update");
            Ok(())
        }
    }
}

/// 把后台任务开始/结束写进聊天流：有绑定会话时落 system 行（刷新后仍可见），
/// 同时广播给在线 WS 连接。
async fn emit_async_task_event(
    config_prefs_slot: &Arc<Mutex<Option<config_prefs::ConfigPrefsHandle>>>,
    system_notice_tx: &broadcast::Sender<SystemNotice>,
    event: AsyncTaskEvent,
) {
    let (started, task) = match event {
        AsyncTaskEvent::Started(task) => (true, task),
        AsyncTaskEvent::Finished(task) => (false, task),
    };
    let label =
        if started { SYSTEM_LABEL_ASYNC_TASK_STARTED } else { SYSTEM_LABEL_ASYNC_TASK_FINISHED };
    let detail = serde_json::json!({
        "async_task_name": task.name,
        "async_task_type": task.task_type,
        "async_task_state": task.state.as_str(),
        "async_task_summary": task.summary,
    });

    if let Some(handle) = config_prefs_slot.lock().ok().and_then(|guard| guard.clone()) {
        let blocks = serde_json::json!([{
            "type": "system",
            "label": label,
            "detail": detail,
        }])
        .to_string();
        let text = if started {
            format!("后台任务已启动：{}", task.name)
        } else {
            format!("后台任务已结束：{}（{}）", task.name, task.state.as_str())
        };
        if let Err(e) = chat_persistence::insert_message(
            &handle.db,
            &handle.db_session_id,
            "system",
            &text,
            Some(&blocks),
            None,
        )
        .await
        {
            tracing::warn!(error = %e, "failed to persist async task system notice");
        }
    }

    let _ = system_notice_tx.send(SystemNotice {
        label: label.to_string(),
        detail: Some(detail),
        notice_id: None,
    });
}

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
    // agent 侧会话标题同理落快照（§17.2）：刷新 / 换设备后侧栏要有东西可显示。
    // 只写 `agent_title` 列，`name`（用户手写名）永不被本路径触碰——展示口径
    // `name ?? agent_title ?? 宿主默认名` 由 schema 保证优先级，见 acp/title.rs。
    if let SessionUpdate::SessionInfoUpdate(u) = &notification.update
        && let Some(handle) = config_prefs_slot.lock().ok().and_then(|g| g.clone())
    {
        // `MaybeUndefined` 三态必须分开对待（协议原文："Set to null to clear"）：
        //   Undefined = 本帧没提 title → **不动**，一条也不写
        //   Null      = agent 主动清除 → 落 NULL
        //   Value     = 新标题
        // **不能**图省事传 `u.title.value()`：它把 Undefined 与 Null 都折成 `None`，
        // 而 `persist_title(None)` 是清除语义——于是 agent 发任何一条不带 title 的
        // `session_info_update`（实测 opencode / pi-acp 用这个变体推 `_meta` 运行时
        // 状态）都会把已回填好的标题擦掉。2026-10-16 实测复现：库里的
        // `opencode 添加自定义供应商` 被擦成 NULL，而 agent 侧标题仍在。
        if !u.title.is_undefined() {
            title::persist_title(
                &handle.db,
                &handle.db_session_id,
                u.title.value().map(String::as_str),
            )
            .await;
        }
    }
    handler::handle_session_update(tx, SeqNotification { seq, notification })
}

/// 两个构造器的会话建立差异：create 走 `session/new`（响应带 config_options），
/// restore 复用既有 `acp_session_id`（不发起新会话）。见
/// [`AcpClient::spawn_with_session`]。
enum SessionMode {
    New,
    Load(String),
    /// 只建连、**不发 `session/new`**：给 `session/list` 这类「按 cwd 查询、不
    /// 绑定会话」的只读 RPC 用。
    ///
    /// 为什么值得单开一个变体而不是复用 `New`：`session/list` 的调用点是「发现
    /// agent 侧历史」面板，每次展开都拉起一个短命进程。若走 `New`，每次展开都会
    /// 在 agent 自己的历史里留一条空会话（opencode 实测即多一行
    /// `New session - <时间>`）——**面板会往它正在展示的列表里掺数据**，用户看到
    /// 的自己刚造出来的那一行。只读查询不应有可见副作用。
    Probe,
}

/// `spawn_with_session` 内层连接闭包 → 外层的握手结果。
///
/// 具名字段取代此前的 6 元位置元组：新增一个能力位（`sessionCapabilities.delete`）
/// 就要再加一个 `bool`，位置元组在调用点靠顺序对齐、改错顺序编译器不报错
/// （工程准则 6/7：字段集持续扩展 → 用具名结构而非散落的位置参数）。
struct Handshake {
    connection: ConnectionTo<AcpAgentRole>,
    session_id: SessionId,
    supports_load_session: bool,
    supports_image: bool,
    supports_embedded_context: bool,
    /// `agentCapabilities.sessionCapabilities.delete` 的存在性（marker 空结构，
    /// 存在即支持）。缺失 = 不支持 `session/delete`（§8 多实现兼容：codebuddy
    /// 未声明，opencode / pi-acp 声明）。
    supports_delete_session: bool,
    /// `sessionCapabilities.list` 的存在性。语义见 struct 字段文档：**仅**门控
    /// turn 结束时的自动标题反查，不影响 `list_sessions` 本身（面板路径）。
    supports_list_session: bool,
    initial_config_options: Vec<SessionConfigOption>,
}

/// 下发给 agent 的 cwd 统一形态：去掉尾部路径分隔符（`/home/pax/` →
/// `/home/pax`），根 / 盘符根保持原样（`/`、`C:\` 不被裁空或裁成 `C:`）。
///
/// 背景（2026-10-11 对 qodercli 1.1.66 实测复现）：qoder 按「路径中非字母
/// 数字字符替换为 `-`」编码会话存储目录——`/home/pax/` → `-home-pax-`、
/// `/home/pax` → `-home-pax`。其 session/new 与 session/load 对该编码的规范化
/// 不一致：创建时去掉尾斜杠落盘 `-home-pax`，恢复时却按请求原样编码查
/// `-home-pax-`，于是 session/load 报 INVALID_SESSION_IDENTIFIER、恢复必失败。
/// omniterm 库里 workspace_path 常带尾斜杠（如 `/home/pax/`），正好踩中。
///
/// 三个下发点统一本形态：**session/new**（`spawn_with_session`）、
/// **session/load**（[`Self::load_session`]）、**session/list**
/// （[`Self::list_sessions`]）。第三点是 2026-10-16 补的：opencode 对
/// `session/list` 的 cwd 参数做**字符串级过滤**，而它建会话时会把 `/home/pax/`
/// 规范化成 `/home/pax` 再存——带斜杠查回来是**空列表**（实测 25 条 vs 0 条）。
/// 空列表会被读成「这个目录没有历史」而**不是**报错，用户与代码都无法察觉，
/// 所以归一必须落在 `list_sessions` 内部这个收口上，而不是某个调用点：落在
/// 调用点就等于要求每个未来的调用方都记得，而那正是这次漏掉的原因。
///
/// 对不按「原样 cwd 编码目录」定位会话的 agent 无影响（如 claude-agent-acp
/// 按会话 ID 跨目录查找）；对按路径编码存取的 agent，各端点同形态也保证
/// new 落盘 / load 查找 / list 过滤三者一致。
fn normalize_agent_cwd(cwd: &Path) -> PathBuf {
    let s = cwd.as_os_str().to_string_lossy();
    let trimmed = s.trim_end_matches(std::path::MAIN_SEPARATOR);
    // 全部裁光 = 根（POSIX `/` / 反斜杠单根）；`C:` 形态 = Windows 盘符根被裁掉
    // 尾分隔符（`C:\` 的语义），两者都保持原样。
    if trimmed.is_empty() || (trimmed.len() == 2 && trimmed.ends_with(':')) {
        cwd.to_path_buf()
    } else {
        PathBuf::from(trimmed)
    }
}

/// turn 结束时反查 `session/list` 的预算。比 `api::sessions::EPHEMERAL_AGENT_TIMEOUT`
/// （15s，含拉起进程）短：连接早已建好，这里只是一次往返；且这是后台动作，不该
/// 让 turn 收尾任务为一个可能永不自愈的 agent 干等。
const TITLE_REFRESH_TIMEOUT: Duration = Duration::from_secs(5);

impl AcpClient {
    pub async fn spawn_and_connect(
        agent: Agent,
        cwd: PathBuf,
        api_keys: &std::collections::HashMap<String, String>,
    ) -> Result<Self, AcpError> {
        Self::spawn_with_session(agent, cwd, api_keys, SessionMode::New).await
    }

    /// 只读探针构造器：建连 + initialize，但**不发 `session/new`**（见
    /// [`SessionMode::Probe`]）。当前唯一消费者是 `session/list`（发现 agent 侧
    /// 历史的面板）——每次展开面板都拉起一个短命进程，走 `New` 会往 agent 自己的
    /// 历史里掺一条空会话。
    ///
    /// 探针 client 上**不得**调用任何按 session 定位的方法（`send_prompt` /
    /// `delete_session` / `set_config_option` …）：它的 `session_id` 是空哨兵，
    /// agent 侧没有对应会话。
    pub async fn spawn_probe(
        agent: Agent,
        cwd: PathBuf,
        api_keys: &std::collections::HashMap<String, String>,
    ) -> Result<Self, AcpError> {
        Self::spawn_with_session(agent, cwd, api_keys, SessionMode::Probe).await
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
        // 包装 `cd` / 下发 session/new 前统一 cwd 形态（见 [normalize_agent_cwd]）：
        // 与 load_session 两端同形态，兜底 qoder 等按路径编码存储会话的 agent
        // 在恢复时因尾斜杠（`-home-pax-` vs 落盘的 `-home-pax`）找不到会话。
        let cwd = normalize_agent_cwd(&cwd);
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
        let (turn_event_tx, _) = broadcast::channel::<TurnEvent>(16);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        // D4：连接任务 abort 指令（shutdown/disconnect → crash watcher）。
        let (abort_tx, abort_rx) = oneshot::channel::<()>();
        let (conn_tx, conn_rx) = oneshot::channel::<Handshake>();

        let notif_tx = session_update_tx.clone();
        let terminal_manager = Arc::new(AcpTerminalManager::new(terminal_event_tx.clone()));
        let tm = terminal_manager.clone();
        let permission_manager = Arc::new(PermissionManager::new());
        let pm = permission_manager.clone();
        let activity = Arc::new(Mutex::new(ActivityState::new()));
        let async_tasks = Arc::new(Mutex::new(AsyncTaskRegistry::new()));
        let commands_notif: Arc<Mutex<Option<SessionNotification>>> = Arc::new(Mutex::new(None));
        let accumulator = Arc::new(TurnAccumulator::new());
        let config_prefs_slot: Arc<Mutex<Option<config_prefs::ConfigPrefsHandle>>> =
            Arc::new(Mutex::new(None));
        // 权限超时配置槽：请求闭包构造早于本 struct，用槽共享「attach 后」的
        // 配置实例（与 config_prefs_slot 同一模式）。
        let perm_timeout_slot: Arc<Mutex<Option<Arc<PermissionTimeoutConfig>>>> =
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
                    let async_tasks = async_tasks.clone();
                    let system_notice_tx = system_notice_tx.clone();
                    async move |notification: RawSessionNotification, _cx| {
                        on_raw_agent_notification(
                            NotificationContext {
                                activity: &activity,
                                accumulator: &accumulator,
                                commands_notif: &commands_notif,
                                config_prefs_slot: &config_prefs_slot,
                                async_tasks: &async_tasks,
                                system_notice_tx: &system_notice_tx,
                                tx: &tx,
                            },
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
                    let perm_timeout_slot = perm_timeout_slot.clone();
                    async move |request: RequestPermissionRequest, responder, _cx| {
                        // 登记成功即进入未决态 → 起算「等真人审批」区间（无活跃 turn 时
                        // begin_wait 自行 no-op，见 TurnAccumulator）。
                        pm.handle_request(request, responder).await?;
                        accumulator.begin_wait();
                        // 唤醒 reaper 立刻评估超时策略：「总是」档（auto + 0 秒）要求
                        // 到达即应答，否则要等下一个 30 秒 tick（用户实测的等待）。
                        // begin_wait 在前保证 reaper 的 resolve → end_wait 不会先于
                        // 它执行（等待计时不倒挂）；槽为 None（能力探针）时无唤醒，
                        // 由 tick 兜底。
                        if let Some(cfg) = perm_timeout_slot.lock().ok().and_then(|g| g.clone()) {
                            cfg.notify_perm_request();
                        }
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
                    let init_resp = cx.send_request(initialize_request()).block_task().await?;
                    let supports_load = init_resp.agent_capabilities.load_session;
                    let supports_image = init_resp.agent_capabilities.prompt_capabilities.image;
                    let supports_embedded =
                        init_resp.agent_capabilities.prompt_capabilities.embedded_context;
                    // `sessionCapabilities.delete` 是 marker 空结构：`Some` = 声明支持
                    // `session/delete`，`None`/缺失 = 不支持。只在 initialize 现场判一次，
                    // 不落库（agent 配置可改、版本可升，缓存会撒谎，见计划 D3）。
                    let supports_delete_session =
                        init_resp.agent_capabilities.session_capabilities.delete.is_some();
                    // `sessionCapabilities.list` 同理是 marker 空结构。只在 initialize
                    // 现场判一次、不落库（与 delete 同理由：agent 配置可改、版本可升，
                    // 缓存会撒谎）。**仅**用于 turn 结束自动反查的门控，见字段文档。
                    let supports_list_session =
                        init_resp.agent_capabilities.session_capabilities.list.is_some();

                    // 三个构造器的唯一差异：create 走 session/new（响应带
                    // config_options），restore 复用既有 acp_session_id，probe 两者
                    // 都不发（只读查询不应在 agent 历史里留痕，见 SessionMode::Probe）。
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
                        // 哨兵 id：probe client 上没有任何按 session 定位的方法会被
                        // 调用（只有 session/list，其参数是 cwd 不是本 id）。
                        SessionMode::Probe => (SessionId::new(String::new()), Vec::new()),
                    };
                    let _ = conn_tx.send(Handshake {
                        connection: cx.clone(),
                        session_id,
                        supports_load_session: supports_load,
                        supports_image,
                        supports_embedded_context: supports_embedded,
                        supports_delete_session,
                        supports_list_session,
                        initial_config_options: config_options,
                    });

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

        let Handshake {
            connection,
            session_id,
            supports_load_session,
            supports_image,
            supports_embedded_context,
            supports_delete_session,
            supports_list_session,
            initial_config_options,
        } = match conn_rx.await {
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
            turn_event_tx,
            terminal_manager,
            permission_manager,
            supports_load_session,
            supports_image,
            supports_embedded_context,
            supports_delete_session,
            supports_list_session,
            initial_config_options: Arc::new(Mutex::new(initial_config_options)),
            available_commands_notif: commands_notif,
            activity,
            async_tasks,
            last_noticed_generation: Mutex::new(None),
            accumulator,
            config_prefs: config_prefs_slot,
            perm_timeout: perm_timeout_slot,
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

    /// 订阅 turn 生命周期事件（所有 WS 连接都应订阅，见 [`TurnEvent`]）。
    pub fn turn_event_subscribe(&self) -> broadcast::Receiver<TurnEvent> {
        self.turn_event_tx.subscribe()
    }

    /// 当前（或刚结束的）turn 的 DB 行 id。专用轻量访问器：`turn_snapshot()`
    /// 会克隆全量 `text` 并序列化整个帧窗口（可达 128KB），为拿一个 id 不值得。
    pub fn turn_row_id(&self) -> Option<String> {
        self.accumulator.turn_row_id()
    }

    /// 本 turn（或刚定稿那一轮）是否折叠过**可见产出**帧（正文 / 思考 / 工具卡 / 计划）。
    /// turn 结束路径用它识别「协议回正常终态、聊天流里却什么都没有」的静默失败，
    /// 判定口径见 `turn_accumulator` 的 `turn_has_visible_output`。
    pub fn turn_has_visible_output(&self) -> bool {
        self.accumulator.turn_has_visible_output()
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

    /// 进行中 turn 的实时读数（工作 / 工具 / 估算速度）。WS 层按秒推送给浏览器，
    /// 前端只显示、不计算——估算的唯一真相源在累积器。`None` = 无活跃 turn。
    pub fn live_turn_stats(&self) -> Option<TurnStats> {
        self.accumulator.live_stats()
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

    /// 当前（或刚定稿）turn 的 assistant 行 id；`None` = 无活跃 turn 或行未惰创建。
    /// mid-turn 告知落库时用作 `turn_row_id` 归属（计划 2026-10-26 D2），与
    /// [`TurnAccumulator::turn_row_id`] 同生命周期（`finalize_turn` 不清、
    /// `begin_turn` 才清）。
    pub fn current_turn_row_id(&self) -> Option<String> {
        self.accumulator.turn_row_id()
    }

    /// 广播 turn 结束事件（无订阅者时静默丢弃）。
    pub fn notify_turn_event(&self, event: TurnEvent) {
        let _ = self.turn_event_tx.send(event);
    }

    /// 广播后端主动产生的系统通知（权限超时回收告知等；无订阅者时静默丢弃）。
    pub fn notify_system_message(&self, notice: SystemNotice) {
        let _ = self.system_notice_tx.send(notice);
    }

    /// mid-turn SYSTEM 告知：写入当前 turn 的**有序帧窗口**（hydrate / snapshot 时
    /// 与前后 agent 帧保持同一位置），并广播实时 `system_message` 帧。
    ///
    /// 返回 `false` = 无活跃 turn（调用方降级为独立 system 行）。`notice_id` 必须
    /// 存在：它同时进入帧内 `_meta.omnitermSystem.id` 与 WS 帧，供前端在快照/补拉
    /// 时去掉重复的独立 system 消息。
    pub fn notify_inline_system_notice(&self, notice: &SystemNotice) -> bool {
        let Some(notice_id) = notice.notice_id.as_deref() else { return false };
        let mut meta = serde_json::Map::new();
        meta.insert(
            "omnitermSystem".to_string(),
            serde_json::json!({
                "id": notice_id,
                "label": notice.label,
                "detail": notice.detail,
            }),
        );
        let update = SessionUpdate::SessionInfoUpdate(SessionInfoUpdate::new().meta(Some(meta)));
        let Ok(update_json) = serde_json::to_value(&update) else {
            tracing::warn!("failed to serialize inline system notice");
            return false;
        };
        let Some((seq, _row_id)) = self.accumulator.append_host_update(&update_json) else {
            return false;
        };
        // 与 agent session_update 走同一有序广播通道：本帧在自动审批的
        // `responder.respond()` 之前入队，agent 的后续输出必然排在它之后；
        // 前端 classifier 识别 `_meta.omnitermSystem` 后按独立 SYSTEM 消息落地。
        let notification = SessionNotification::new(self.session_id.clone(), update);
        let _ = self.session_update_tx.send(SeqNotification { seq: Some(seq), notification });
        true
    }

    /// 自动审批专用：在 agent 收到 `Selected` 应答**之前**写入并广播 SYSTEM 告知，
    /// 保证 live 端先看到告知、再看到 agent 的后续输出；若请求已被用户抢先解决，
    /// `resolve_with` 的钩子不会执行（不会留下幽灵告知）。
    ///
    /// 返回 `(resolved, notice_emitted)`；`resolved && !notice_emitted` 表示无活跃
    /// turn，调用方应回退到独立 system 行。
    pub async fn resolve_permission_with_notice(
        &self,
        id: &str,
        option_id: &str,
        notice: &SystemNotice,
    ) -> (bool, bool) {
        let mut notice_emitted = false;
        let resolved = self
            .permission_manager
            .resolve_with(id, option_id, || {
                notice_emitted = self.notify_inline_system_notice(notice);
            })
            .await;
        if resolved {
            // 与 resolve_permission 同一口径：只在本次真正消费掉未决审批时结束等待段。
            self.accumulator.end_wait();
        }
        (resolved, notice_emitted)
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

    /// `agentCapabilities.sessionCapabilities.delete` 是否声明（存在即支持）。
    /// 删除会话时是否顺带抹掉 agent 侧记录的唯一判据（主动删除与 UI 三态共用）。
    pub fn supports_delete_session(&self) -> bool {
        self.supports_delete_session
    }

    /// `sessionCapabilities.list` 是否声明。**只被 turn 结束时的自动标题反查用来
    /// 决定要不要问**，`list_sessions` 本身不看它（面板路径要如实呈现失败）。
    pub fn supports_list_session(&self) -> bool {
        self.supports_list_session
    }

    /// 请 agent 删除本连接所绑会话在 **agent 侧**的记录（`session/delete`）。
    ///
    /// 能力未声明时调用方不得调用（本方法不自行 gate，便于调用方把
    /// 「不支持」与「调用失败」分成两种结果）；协议规定删除不存在的会话
    /// SHOULD 静默成功，故重复删除不报错。
    pub async fn delete_session(&self, acp_session_id: &str) -> Result<(), AcpError> {
        self.connection
            .send_request(DeleteSessionRequest::new(SessionId::new(acp_session_id)))
            .block_task()
            .await
            .map(|_resp| ())
    }

    /// 枚举 agent 侧的会话历史（`session/list`，ACP §17.1），带显式上限翻页。
    ///
    /// 返回 `(sessions, truncated)`：`truncated = true` 表示还有更多页没拉
    /// （命中 [`ACP_LIST_MAX_SESSIONS`] 或 [`ACP_LIST_MAX_PAGES`]），调用方必须
    /// 如实告知用户「看到的是截断后的列表」而不是假装看全了。
    ///
    /// **不做能力 gate**（与 `delete_session` 的有意分歧）：`session/list` 的
    /// 能力位在实测的四个实现里覆盖不一（codebuddy 连 `sessionCapabilities` 都
    /// 不声明，omp 声明了 `list` 却对部分会话不给 title），gate 会把「不支持」
    /// 与「声明了但 RPC 失败」混成一谈；而 method-not-found 的错误文案本身就
    /// 足以对用户如实交代（§8 多实现兼容，勿把单一实现当约定）。
    /// **cwd 在本方法内归一**（[`normalize_agent_cwd`]）：调用方传库里原样的
    /// `workspace_path` 即可，勿在调用点自行裁剪——收口在此，漏一处就是一次
    /// 「空列表被读成没有历史」的静默失败（2026-10-16 实测，见该函数文档）。
    pub async fn list_sessions(
        &self,
        cwd: Option<&str>,
    ) -> Result<(Vec<SessionInfo>, bool), AcpError> {
        let cwd = cwd.map(|c| normalize_agent_cwd(Path::new(c)));
        let mut out: Vec<SessionInfo> = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0usize;
        loop {
            let mut req = ListSessionsRequest::new();
            if let Some(cwd) = cwd.as_deref() {
                req = req.cwd(cwd.to_path_buf());
            }
            if let Some(c) = cursor.as_deref() {
                req = req.cursor(c);
            }
            let resp = self.connection.send_request(req).block_task().await?;
            out.extend(resp.sessions);
            pages += 1;
            // 上限判定放在取 next_cursor 之前：任一维度触顶即停，不再发起下一轮
            // RPC（否则「已经决定不用了还要再问一次」是纯浪费）。
            if out.len() >= ACP_LIST_MAX_SESSIONS || pages >= ACP_LIST_MAX_PAGES {
                let truncated = resp.next_cursor.is_some() || out.len() > ACP_LIST_MAX_SESSIONS;
                out.truncate(ACP_LIST_MAX_SESSIONS);
                return Ok((out, truncated));
            }
            match resp.next_cursor {
                Some(c) if !c.is_empty() => cursor = Some(c),
                // 无游标 = 已到头（协议：有 next_cursor 才表示还有更多）。
                _ => return Ok((out, false)),
            }
        }
    }

    /// turn 结束时补一次 agent 侧标题（`session/list` 反查通道的**自动**触发点）。
    ///
    /// 为什么需要它：opencode / qodercli / pi-acp **从不推** live
    /// `session_info_update.title`（2026-10-16 实测），它们的标题只能靠
    /// `session/list` 反查。没有这个触发点，那些 agent 的会话名就永远停在
    /// `${agent}_${时间}`，除非用户手动打开「Agent 历史」面板。
    ///
    /// 两道门控，任一不满足就**一个 RPC 都不发**：
    /// 1. 用户已命名（`name` 非空白）——那一行的名字由用户说了算；
    /// 2. agent 未声明 `sessionCapabilities.list`——问了也是 `-32601`。
    ///
    /// **刻意没有「已有 `agent_title` 就别问」这一道**：opencode 的真标题是异步
    /// 生成的，turn 结束那一刻查到的可能是建会话时的占位串
    /// `New session - <ISO>`（真机实测，见 `title::workspace_to_refresh_title`）。
    /// 加那道门控会把占位串永久锁死。写放大由 `persist_title` 的同值跳过把守：
    /// 标题没变就是 0 次写入。
    ///
    /// **门控 1 的权威判据在 SQL 里，不在这里**：用户可以在 turn 进行中的任意
    /// 一刻改名，与本方法真并发。这里的事前查询只是省 RPC 的优化；竞态下最坏
    /// 是多问一次，写入被 [`title::persist_title`] WHERE 里的同名判据挡下
    /// （0 行）。所以「改名后不再回填」不依赖任何时序假设。
    ///
    /// best-effort：失败只 WARN，绝不影响 turn 收尾（`Done` 帧早已发出）。
    pub async fn refresh_agent_title(&self, db: &sqlx::SqlitePool, db_session_id: &str) {
        if !self.supports_list_session() {
            return;
        }
        let Some(workspace_path) = title::workspace_to_refresh_title(db, db_session_id).await
        else {
            return; // 已命名 / 行不存在
        };
        let listed =
            tokio::time::timeout(TITLE_REFRESH_TIMEOUT, self.list_sessions(Some(&workspace_path)))
                .await;
        match listed {
            Ok(Ok((sessions, _truncated))) => {
                // 截断与否与标题回填无关：目标是「本会话那条」，命不中只是这次没补上。
                title::backfill_from_list(db, &sessions).await;
            }
            Ok(Err(e)) => {
                tracing::warn!(session = db_session_id, "turn 结束时反查 agent 侧标题失败：{e}")
            }
            Err(_) => tracing::warn!(
                session = db_session_id,
                "turn 结束时反查 agent 侧标题超时（{}s）",
                TITLE_REFRESH_TIMEOUT.as_secs()
            ),
        }
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

    /// 标记有进行中的 prompt（由 WS handler 在收到用户 prompt 时调用），返回本次
    /// prompt 的世代号（供 [`Self::mark_prompt_idle_for_generation`] 守卫陈旧终结者）。
    ///
    /// **supersede**：上一个 turn 未经终结就被新 prompt 顶替时（部分实现确实不回
    /// 结束信号——实测 oh-my-pi 的 `/compact`，用户遂直接发下一条），先给它补发
    /// 合成终态 `Done { stop_reason: "Superseded" }` 再开新 turn。不补的话那条
    /// 气泡在**所有**前端永远停留在 streaming / 计时中：能收尾它的 send_prompt
    /// 返回会被世代守卫拦下，再无任何后续帧能收敛它。`duration` 照常带出（累积器
    /// 此刻定稿结算），前端当场显示耗时；`abnormal: false` 与不写留痕 system 消息，
    /// 口径同 InactivityTimeout：这是宿主合成的原因，不是协议回了非正常 stopReason。
    ///
    /// 世代递增、supersede 定稿与 `begin_turn` 全在 `activity` 临界区内完成，事件
    /// 广播也在临界区内按序发出：与 [`Self::mark_prompt_idle_for_generation`] 的
    /// 「查世代 + 定稿」互斥（同 `claim_turn_end_notice_for_current_turn` 的 TOCTOU
    /// 修复模式），否则陈旧终结者可插进「查」与「定」之间，把刚开的**新** turn
    /// 定稿掉；broadcast 的发送顺序即前端观察顺序（Done{Superseded} → Started）。
    pub fn mark_prompt_active(&self) -> u64 {
        let mut st = match self.activity.lock() {
            Ok(guard) => guard,
            // 中毒语义与 claim 路径一致：取回数据继续。这里必须继续**递增**——
            // 调用方拿返回值做世代守卫，不递增会让新旧世代同值，终结者被误判为
            // 陈旧而永久跳过定稿。
            Err(poisoned) => poisoned.into_inner(),
        };
        st.active_prompt = true;
        st.prompt_generation = st.prompt_generation.wrapping_add(1);
        st.last_activity = Instant::now();
        let generation = st.prompt_generation;
        // 用户 prompt 是唯一的 turn 起点：先收掉上一 turn（若有），再开启累积器
        // turn 门控。load_session 重放从不走此路径，故重放帧不会被折叠进
        // streaming 行（结构性排除）。
        if let Some(timing) = self.accumulator.finalize_turn() {
            self.notify_turn_event(TurnEvent::Done {
                stop_reason: "Superseded".into(),
                row_id: timing.row_id.clone(),
                duration: Some(timing),
                abnormal: false,
            });
        }
        self.accumulator.begin_turn();
        self.notify_turn_event(TurnEvent::Started);
        generation
    }

    /// 强制收尾进行中的 prompt（看门狗 / 关闭语义：reaper prompt-stale、shutdown）。
    /// 不校验世代——这些路径要的就是「终结当下活跃的那一轮」。
    ///
    /// prompt 任务自身的收尾必须走 [`Self::mark_prompt_idle_for_generation`]：
    /// 只有那里的「世代匹配才定稿」能拦住陈旧终结者误杀新 turn。
    ///
    /// 返回是否真的定稿了一个 turn（供调用方决定要不要广播终态帧）。
    pub fn mark_prompt_idle(&self) -> bool {
        if let Ok(mut st) = self.activity.lock() {
            st.active_prompt = false;
        }
        // turn 结束（正常完成 / 出错 / 取消）统一定稿进行中的 assistant 行（幂等）。
        self.accumulator.finalize_turn().is_some()
    }

    /// prompt 任务按世代收尾：世代不匹配（本 turn 已被新 prompt 顶替）或已有别的
    /// 终结者定稿时，什么都不做并返回 false。
    ///
    /// 「查世代 + 定稿」必须在同一 `activity` 临界区内完成。拆成两步是 TOCTOU：
    /// [`Self::mark_prompt_active`] 在递增世代后接管累积器（supersede 定稿旧 turn →
    /// begin 新 turn），陈旧终结者若插进这中间，就会把刚开的**新** turn 定稿掉——
    /// 新 turn 的帧从此 fold 不进（fold 以 active 门控），前端看得到流式内容、DB 里
    /// 却没有行（定稿时 row_id 为空，cooked 回写被跳过）= 静默丢数据。与
    /// `claim_turn_end_notice_for_current_turn` 用同一次持锁消除 TOCTOU。
    ///
    /// 返回 true = 本次调用赢得定稿（世代匹配且确有活跃 turn 被收尾），调用方据此
    /// 广播终态帧；false = 轮不到本调用，不得广播（否则终态帧重复或张冠李戴）。
    pub fn mark_prompt_idle_for_generation(&self, generation: u64) -> bool {
        let mut st = match self.activity.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if st.prompt_generation != generation {
            return false;
        }
        st.active_prompt = false;
        self.accumulator.finalize_turn().is_some()
    }

    /// cancel 的 turn 收尾兜底。
    ///
    /// 正常路径：合作的 agent 收到 `session/cancel` 后让 `send_prompt` 以
    /// `Cancelled` 返回，prompt 任务照常定稿 turn 并广播结束——取消后 agent
    /// 补发的尾部帧（收尾文本等）得以落库。但无视 cancel 的实现可能永不
    /// 返回（§8 多实现兼容），超时后若同一 turn 仍在进行则强制定稿 + 广播
    /// 结束，防止会话永久卡在运行中。世代守卫（原子版，见
    /// [`Self::mark_prompt_idle_for_generation`]）避免误杀取消后新发起的 turn。
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
            // 世代匹配与定稿在同一临界区内完成：期间用户已发新 prompt（supersede
            // 已推进世代并给旧 turn 补发终态）时返回 false，本兜底什么都不做。
            if !client.mark_prompt_idle_for_generation(generation) {
                return;
            }
            tracing::warn!(
                "agent 未在 {}s 内响应 session/cancel，强制定稿进行中 turn（兜底）",
                CANCEL_TURN_FALLBACK_SECS
            );
            // `abnormal: false`：本路径是**合成的非协议原因**（agent 无视 cancel
            // 时的兜底定稿），并不是协议回了非正常 stopReason；且此处不写留痕
            // system 消息（计划 D3 之外），若报 error 语义就会出现「有错误提示、
            // 无任何解释文案」。保持既有行为：前端只按 `stop_reason == Cancelled`
            // 走取消文案。
            client.notify_turn_event(TurnEvent::Done {
                stop_reason: "Cancelled".into(),
                row_id: client.turn_row_id(),
                duration: client.turn_timing(),
                abnormal: false,
            });
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

    /// 绑定权限超时配置（main.rs 注入的共享实例，`Arc` 同一份——PUT 热更新
    /// 立即对唤醒后的判定生效）。仅在真实会话注册点调用（create-session /
    /// load_session restore）；能力探针不调用 → 权限请求到达无唤醒，回退 reaper
    /// 的定时 tick 兜底。
    pub fn attach_perm_timeout(&self, perm_timeout: Arc<PermissionTimeoutConfig>) {
        if let Ok(mut guard) = self.perm_timeout.lock() {
            *guard = Some(perm_timeout);
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
        // 后台任务（Workflow / 后台 Bash）不占用 active_prompt：turn 已经 end_turn，
        // 但 agent 仍在干活。没有这条豁免时 reaper 会在 idle 阈值到达后杀掉进程，
        // 连带杀掉任务（2026-10-19 事故）。锁中毒时取回数据继续判定。
        let active_async_tasks = self
            .async_tasks
            .lock()
            .map(|registry| registry.has_active())
            .unwrap_or_else(|poisoned| poisoned.into_inner().has_active());
        !active_prompt
            && pending == 0
            && !active_async_tasks
            && last_activity.elapsed().as_secs() >= idle_secs
    }

    /// 当前跟踪中的后台任务数（测试/诊断用；不暴露给生产调用方做业务判断）。
    pub fn active_async_task_count(&self) -> usize {
        self.async_tasks
            .lock()
            .map(|registry| registry.active_count())
            .unwrap_or_else(|poisoned| poisoned.into_inner().active_count())
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
        // 与创建侧（spawn_with_session）同形态：去尾部分隔符后再下发，见
        // [normalize_agent_cwd]。恢复必失败场景的直接修复点。
        let cwd = normalize_agent_cwd(&cwd);
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

    // ── normalize_agent_cwd：下发 cwd 去尾部分隔符（qoder 恢复兜底）────────

    #[test]
    fn normalize_agent_cwd_strips_trailing_separator() {
        // 报告场景：库中 workspace_path="/home/pax/"，qoder 会编码成 -home-pax-
        // 而找不到落盘在 -home-pax 的会话；下发前必须裁成 /home/pax。
        assert_eq!(normalize_agent_cwd(Path::new("/home/pax/")), PathBuf::from("/home/pax"));
    }

    #[test]
    fn normalize_agent_cwd_collapses_multiple_trailing_separators() {
        assert_eq!(normalize_agent_cwd(Path::new("/home/pax///")), PathBuf::from("/home/pax"));
    }

    #[test]
    fn normalize_agent_cwd_leaves_clean_path_unchanged() {
        assert_eq!(normalize_agent_cwd(Path::new("/home/pax")), PathBuf::from("/home/pax"));
    }

    #[test]
    fn normalize_agent_cwd_keeps_root() {
        // 根目录不被裁空：裁光后必须回退原路径（"" 会破坏所有 agent 的 cwd）。
        assert_eq!(normalize_agent_cwd(Path::new("/")), PathBuf::from("/"));
    }
}
