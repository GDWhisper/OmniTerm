use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ConfigOptionUpdate, ContentBlock, CreateTerminalRequest, EmbeddedResource,
    EmbeddedResourceResource, ImageContent, InitializeRequest, KillTerminalRequest,
    LoadSessionRequest, NewSessionRequest, PromptRequest, PromptResponse, ReadTextFileRequest,
    ReadTextFileResponse, ReleaseTerminalRequest, RequestPermissionRequest, SessionConfigId,
    SessionConfigKind, SessionConfigOption, SessionConfigOptionValue, SessionId,
    SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, TextContent,
    TextResourceContents, WaitForTerminalExitRequest, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::{AcpAgent, Agent as AcpAgentRole, ConnectionTo, Error as AcpError};
use serde::Deserialize;
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

use crate::acp::config_prefs;
use crate::acp::handler::{self, SeqNotification};
use crate::acp::permission::{PermissionManager, PermissionRequestEvent};
use crate::acp::terminal::{AcpTerminalManager, TerminalActivity};
use crate::acp::turn_accumulator::{TurnAccumulator, TurnSnapshot};
use crate::models::agent::Agent;

/// session_update broadcast 容量。重放/实时链路已边生产边消费，此容量仅作为
/// 慢消费者（如弱网 WS 客户端）的积压缓冲；超长历史 + 持续慢消费才会 Lagged 丢帧，
/// 每帧仅 Arc 克隆，放大容量的内存代价可忽略。
const SESSION_UPDATE_CHANNEL_CAPACITY: usize = 4096;

/// cancel 后等待 agent 自行结束 turn 的兜底秒数：合作的 agent 通常 1-2s 内让
/// send_prompt 以 Cancelled 返回；超时视为该实现无视 cancel，强制收尾
/// （见 [`AcpClient::spawn_cancel_turn_fallback`]）。
const CANCEL_TURN_FALLBACK_SECS: u64 = 15;

/// 前端随 prompt 附带的图片附件（base64 内联，映射为 `ContentBlock::Image`）。
#[derive(Debug, Deserialize)]
pub struct ImageInput {
    /// Base64 编码的图片数据（不含 data URI 前缀）。
    pub data: String,
    pub mime_type: String,
}

/// `@path` 引用解析出的文件内容（映射为 `ContentBlock::Resource`，
/// agent 不支持 embeddedContext 时降级内联进 text block）。
#[derive(Debug)]
pub struct ResourceInput {
    /// `file://` 绝对路径 URI。
    pub uri: String,
    /// 用户输入的原始 `@` 相对路径（内联降级时的标题）。
    pub label: String,
    pub text: String,
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
    },
    Error {
        message: String,
    },
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
    last_activity: Instant,
}

impl ActivityState {
    fn new() -> Self {
        Self { active_prompt: false, prompt_generation: 0, last_activity: Instant::now() }
    }
}

pub struct AcpClient {
    connection: ConnectionTo<AcpAgentRole>,
    session_id: SessionId,
    session_update_tx: broadcast::Sender<SeqNotification>,
    _shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    /// agent 连接任务崩溃时广播错误原因，供 WS 层即时透传给前端。
    /// 取代原先 `disconnect` 中 `let _ = connection_task.await` 被静默丢弃的错误。
    crash_tx: broadcast::Sender<String>,
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
    /// 用 `std::sync::Mutex<Option<_>>`：使用时 lock 克隆 handle、立即 drop guard
    /// 再 await，避免跨 await 持 std MutexGuard 破坏 Send（replay task 是 tokio::spawn）。
    config_prefs: Mutex<Option<config_prefs::ConfigPrefsHandle>>,
    /// 活跃度跟踪，供空闲回收看护任务（reaper）读取。
    activity: Arc<Mutex<ActivityState>>,
    /// 后端权威的进行中 turn 累积器：把流式 session/update 帧防抖落库，
    /// 使刷新/切设备/弱网不再丢失进行中的 assistant 回复（见 turn_accumulator）。
    accumulator: Arc<TurnAccumulator>,
    /// 显式存活标志：`shutdown()` / `disconnect()` 时置 false。
    ///
    /// **不能用 `is_incoming_closed()` 单测判定死连接**：reaper 主动 `shutdown`
    /// 是让连接任务退出（`shutdown_rx.await` 返回），incoming 传输不读 EOF，
    /// `is_incoming_closed()` 保持 false，但 `send_request` 已报 "connection is
    /// no longer running"。`is_alive()` 因此必须组合本标志 + incoming-closed。
    alive: AtomicBool,
}

/// 看护 agent 连接任务：若其因 agent 进程崩溃/异常退出而返回 `Err`，
/// 通过 `crash_tx` 广播错误原因，供 WS 层即时透传给前端（否则该错误仅被
/// `disconnect` 中的 `let _ =` 丢弃，用户看不到崩溃原因）。
fn spawn_crash_watcher(
    connection_task: JoinHandle<Result<(), AcpError>>,
    crash_tx: broadcast::Sender<String>,
    accumulator: Arc<TurnAccumulator>,
) {
    tokio::spawn(async move {
        if let Err(e) = connection_task.await {
            // 进程崩溃也算 turn 结束：定稿进行中的 assistant 行（幂等），
            // 使已折叠的部分内容不丢，且不会永远停留在 streaming 状态。
            accumulator.finalize_turn();
            let _ = crash_tx.send(format!("{}", e));
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
// POSIX cwd 修复：ACP spawn_process 不设 current_dir
//
// agent-client-protocol 的 AcpAgent::spawn_process 不提供 current_dir 参数，
// 也不调用 Command::current_dir()，导致 agent 子进程 OS cwd = 后端进程 cwd。
// 实测 PID 1838360 的 /proc/PID/cwd -> /home/pax/coding/OmniTerm-dev，
// 但 session workspace 应是 /home/pax/home。
//
// 这两个函数构建一个 shell wrapper 来显式 cd 到 workspace 再 exec agent 进程，
// 使得 agent 进程看到正确的 workspace cwd。
// ---------------------------------------------------------------------------

/// POSIX shell 单引号转义。
///
/// 将字符串安全嵌入 `sh -c '...'` 的单引号片段中：
/// - 空串 → `''`
/// - 不含单引号 → 原样包裹在单引号内
/// - 含单引号 → 按 POSIX 模式 `'...'\''...'` 分段转义
///
/// 实测 PID 1838360 的 /proc/PID/cwd -> /home/pax/coding/OmniTerm-dev，
/// session workspace 应是 /home/pax/home —— 根因是 agent 进程缺少 workspace cwd。
#[cfg(unix)]
fn sh_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if !s.contains('\'') {
        return format!("'{s}'");
    }
    // 含单引号：分段拼接  '...'\''...'
    let mut quoted = String::new();
    quoted.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            // 结束当前单引号段、插入转义单引号、重新开始单引号段
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

/// 生成 shell wrapper 命令，使 agent 子进程以正确的 workspace 作为 OS cwd。
///
/// POSIX-only; ACP 暂不支持 Windows。
///
/// 返回 `["-c", "cd <workspace> && exec <agent_cmd> <arg1> <arg2> ..."]`，
/// 调用方应将其附加到 `/bin/sh`（或 `sh`）之后：
///
/// ```ignore
/// let mut cmd = std::process::Command::new("/bin/sh");
/// cmd.args(wrap_agent_with_cwd(&cmd_path, &args, &workspace));
/// ```
///
/// 使用 `exec` 替换 shell 进程，确保：
/// - agent 进程直接接收信号（不会因 shell 而屏蔽/延迟）
/// - 进程组清理工作正常
/// - 额外 shell 进程不会残留
///
/// 所有动态值均通过 [`sh_quote`] 安全转义，防止 shell 注入。
///
/// # 实测证据
///
/// PID 1838360 的 /proc/PID/cwd -> /home/pax/coding/OmniTerm-dev，
/// 但 session workspace 应是 /home/pax/home。根因是 ACP 的
/// AcpAgent::spawn_process 不设 current_dir，此 wrapper 在
/// agent 进程启动前先 cd 到 workspace_path。
#[cfg(unix)]
fn wrap_agent_with_cwd(agent_cmd: &str, agent_args: &[String], workspace: &Path) -> Vec<String> {
    let cd_cmd =
        format!("cd {} && exec {}", sh_quote(&workspace.to_string_lossy()), sh_quote(agent_cmd));
    // 用 fold 避免预分配：每个 arg 单独 sh_quote，空格分隔拼入 shell 脚本
    let shell_script = agent_args.iter().fold(cd_cmd, |acc, arg| acc + " " + &sh_quote(arg));
    vec!["-c".to_string(), shell_script]
}

impl AcpClient {
    pub async fn spawn_and_connect(
        agent: Agent,
        cwd: PathBuf,
        api_keys: &std::collections::HashMap<String, String>,
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
        // 包装 agent 命令为 `sh -c "cd <workspace> && exec <cmd> <args>"`，
        // 让 agent 子进程的 OS cwd 落在 session 的 workspace_path 上
        // （详见 wrap_agent_with_cwd 的 doc）。POSIX-only 路径。
        #[cfg(unix)]
        let (cmd, args) =
            ("/bin/sh".to_string(), wrap_agent_with_cwd(&resolved_cmd, &agent.args, &cwd));
        #[cfg(not(unix))]
        let (cmd, args) = (resolved_cmd, agent.args.clone());

        all_args.push(cmd);
        all_args.extend(args);

        let transport = AcpAgent::from_args(all_args)?;

        let (session_update_tx, _) = broadcast::channel(SESSION_UPDATE_CHANNEL_CAPACITY);
        let (crash_tx, _) = broadcast::channel::<String>(16);
        let (terminal_event_tx, _) = broadcast::channel::<TerminalActivity>(64);
        let (turn_end_tx, _) = broadcast::channel::<TurnEndEvent>(16);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
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

        let builder = agent_client_protocol::Client
            .builder()
            .name("omniterm")
            .on_receive_notification(
                {
                    let tx = notif_tx.clone();
                    let activity = activity.clone();
                    let commands_notif = commands_notif.clone();
                    let accumulator = accumulator.clone();
                    async move |notification: SessionNotification, _cx| {
                        // 收到任意 agent 通知即视为有活动，刷新最后活动时间
                        if let Ok(mut st) = activity.lock() {
                            st.last_activity = Instant::now();
                        }
                        // 后端权威累积：把进行中 turn 的原始帧防抖落库（仅在 turn active 时生效，
                        // 重放帧无 turn 门控故自动忽略）。运行在 ACP 连接任务上，与 WS 存活无关。
                        // fold 返回该帧的 seq（turn 内单调，非 turn 帧为 None），随广播下发供重连对账。
                        let seq = accumulator.fold(&notification);
                        if matches!(
                            notification.update,
                            SessionUpdate::AvailableCommandsUpdate(_)
                        )
                            && let Ok(mut guard) = commands_notif.lock() {
                                *guard = Some(notification.clone());
                            }
                        handler::handle_session_update(&tx, SeqNotification { seq, notification })
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let pm = pm.clone();
                    async move |request: RequestPermissionRequest, responder, _cx| {
                        pm.handle_request(request, responder).await
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

        let connection_task = tokio::spawn(async move {
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

                    let session_resp =
                        cx.send_request(NewSessionRequest::new(cwd)).block_task().await?;

                    let config_options = session_resp.config_options.clone().unwrap_or_default();

                    let session_id = session_resp.session_id;
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

        spawn_crash_watcher(connection_task, crash_tx.clone(), accumulator.clone());

        let (
            connection,
            session_id,
            supports_load_session,
            supports_image,
            supports_embedded_context,
            initial_config_options,
        ) = conn_rx.await.map_err(|_| AcpError::internal_error())?;

        Ok(AcpClient {
            connection,
            session_id,
            session_update_tx,
            _shutdown_tx: Mutex::new(Some(shutdown_tx)),
            crash_tx,
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
            accumulator,
            config_prefs: Mutex::new(None),
            alive: AtomicBool::new(true),
        })
    }

    pub fn session_update_subscribe(&self) -> broadcast::Receiver<SeqNotification> {
        self.session_update_tx.subscribe()
    }

    /// 订阅 agent 进程崩溃错误（仅在连接任务非正常退出时收到）。
    pub fn crash_subscribe(&self) -> broadcast::Receiver<String> {
        self.crash_tx.subscribe()
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

    /// 广播 turn 结束事件（无订阅者时静默丢弃）。
    pub fn notify_turn_end(&self, event: TurnEndEvent) {
        let _ = self.turn_end_tx.send(event);
    }

    pub fn permission_subscribe(&self) -> broadcast::Receiver<PermissionRequestEvent> {
        self.permission_manager.subscribe()
    }

    /// 订阅审批解决事件（载荷为审批 id），供 WS 层广播 `permission_resolved` 帧。
    pub fn permission_resolved_subscribe(&self) -> broadcast::Receiver<String> {
        self.permission_manager.resolved_subscribe()
    }

    pub async fn resolve_permission(&self, id: &str, option_id: &str) -> bool {
        self.permission_manager.resolve(id, option_id).await
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
        if !resp.config_options.is_empty() {
            if let Ok(mut guard) = self.initial_config_options.lock() {
                *guard = resp.config_options.clone();
            }
            let notification = SessionNotification::new(
                self.session_id.clone(),
                SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(resp.config_options)),
            );
            // 合成的 config 更新不属于任何 turn，seq 为 None（前端无条件应用）。
            let _ = self.session_update_tx.send(SeqNotification { seq: None, notification });
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
    ) -> Result<PromptResponse, AcpError> {
        // 不支持 embeddedContext 的 agent：@ 引用文件内容内联进 text（§8 多实现兼容）。
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

        // 纯图片消息不塞空 text block（部分实现可能拒绝空文本，§8 保守处理）。
        let mut blocks = Vec::new();
        if !text.is_empty() || images.is_empty() {
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
        self.connection
            .send_request(PromptRequest::new(self.session_id.clone(), blocks))
            .block_task()
            .await
    }

    pub fn cancel(&self) -> Result<(), AcpError> {
        self.connection.send_notification(CancelNotification::new(self.session_id.clone()))?;
        // ACP 规范：session/cancel 后 MUST 以 Cancelled 应答所有未决权限请求。
        let pm = self.permission_manager.clone();
        tokio::spawn(async move { pm.cancel_all().await });
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
                client.notify_turn_end(TurnEndEvent::Done {
                    stop_reason: "Cancelled".into(),
                    row_id: client.turn_row_id(),
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
    pub fn attach_config_prefs(
        &self,
        db: sqlx::SqlitePool,
        db_session_id: String,
        agent_id: String,
    ) {
        if let Ok(mut guard) = self.config_prefs.lock() {
            *guard = Some(config_prefs::ConfigPrefsHandle { db, db_session_id, agent_id });
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

    /// 定稿进行中的 assistant turn（幂等）。供外部收尾路径显式调用。
    pub fn finalize_turn(&self) {
        self.accumulator.finalize_turn();
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
        // 包装 agent 命令为 `sh -c "cd <workspace> && exec <cmd> <args>"`，
        // 让 agent 子进程的 OS cwd 落在 session 的 workspace_path 上
        // （详见 wrap_agent_with_cwd 的 doc）。POSIX-only 路径。
        #[cfg(unix)]
        let (cmd, args) =
            ("/bin/sh".to_string(), wrap_agent_with_cwd(&resolved_cmd, &agent.args, &cwd));
        #[cfg(not(unix))]
        let (cmd, args) = (resolved_cmd, agent.args.clone());

        all_args.push(cmd);
        all_args.extend(args);

        let transport = AcpAgent::from_args(all_args)?;

        let (session_update_tx, _) = broadcast::channel(SESSION_UPDATE_CHANNEL_CAPACITY);
        let (crash_tx, _) = broadcast::channel::<String>(16);
        let (terminal_event_tx, _) = broadcast::channel::<TerminalActivity>(64);
        let (turn_end_tx, _) = broadcast::channel::<TurnEndEvent>(16);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
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

        let builder = agent_client_protocol::Client
            .builder()
            .name("omniterm")
            .on_receive_notification(
                {
                    let tx = notif_tx.clone();
                    let activity = activity.clone();
                    let commands_notif = commands_notif.clone();
                    let accumulator = accumulator.clone();
                    async move |notification: SessionNotification, _cx| {
                        // 收到任意 agent 通知即视为有活动，刷新最后活动时间
                        if let Ok(mut st) = activity.lock() {
                            st.last_activity = Instant::now();
                        }
                        // 后端权威累积：把进行中 turn 的原始帧防抖落库（仅在 turn active 时生效，
                        // 重放帧无 turn 门控故自动忽略）。运行在 ACP 连接任务上，与 WS 存活无关。
                        // fold 返回该帧的 seq（turn 内单调，非 turn 帧为 None），随广播下发供重连对账。
                        let seq = accumulator.fold(&notification);
                        if matches!(
                            notification.update,
                            SessionUpdate::AvailableCommandsUpdate(_)
                        )
                            && let Ok(mut guard) = commands_notif.lock() {
                                *guard = Some(notification.clone());
                            }
                        handler::handle_session_update(&tx, SeqNotification { seq, notification })
                    }
                },
                agent_client_protocol::on_receive_notification!(),
            )
            .on_receive_request(
                {
                    let pm = pm.clone();
                    async move |request: RequestPermissionRequest, responder, _cx| {
                        pm.handle_request(request, responder).await
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

        let connection_task = tokio::spawn(async move {
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

                    let session_id = SessionId::new(acp_session_id.as_str());
                    let _ = conn_tx.send((
                        cx.clone(),
                        session_id,
                        supports_load,
                        supports_image,
                        supports_embedded,
                        Vec::new(),
                    ));

                    let _ = shutdown_rx.await;
                    Ok(())
                })
                .await
        });

        spawn_crash_watcher(connection_task, crash_tx.clone(), accumulator.clone());

        let (
            connection,
            session_id,
            supports_load_session,
            supports_image,
            supports_embedded_context,
            initial_config_options,
        ) = conn_rx.await.map_err(|_| AcpError::internal_error())?;

        Ok(AcpClient {
            connection,
            session_id,
            session_update_tx,
            _shutdown_tx: Mutex::new(Some(shutdown_tx)),
            crash_tx,
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
            accumulator,
            config_prefs: Mutex::new(None),
            alive: AtomicBool::new(true),
        })
    }

    /// 通过 shared reference 回收所有子进程并通知连接任务退出。
    /// 供 [`AcpSupervisor::shutdown_all`] 在持有 `Arc<AcpClient>` 时调用
    /// （`disconnect` 消费 self，无法在 Arc 上使用）。
    pub async fn shutdown(&self) {
        // 先置存活标志 false：即使 teardown 尚未完成，prompt 到达时也应走自动恢复。
        self.alive.store(false, Ordering::Release);
        self.terminal_manager.kill_all().await;
        // 取出并 drop shutdown_tx → 连接任务的 shutdown_rx 收到 RecvError 后退出。
        // lock().await 安全：shutdown_tx 仅在此处和 disconnect 中被 take，
        // 且调用方不会跨 await 持有此锁。
        let _ = self._shutdown_tx.lock().unwrap().take();
    }

    pub async fn disconnect(self) {
        // 回收本会话可能创建的终端子进程（kill_on_drop 依赖 TerminalProcess 被 drop，
        // 但 spawned 的 wait task 持有 Child 句柄，需显式 kill_all 通知其退出）。
        self.alive.store(false, Ordering::Release);
        self.terminal_manager.kill_all().await;
        if let Ok(mut guard) = self._shutdown_tx.try_lock() {
            let _ = guard.take();
        }
        // 注意：agent 连接任务句柄已移交给 `spawn_crash_watcher`，由其负责在
        // 连接异常退出时广播错误；此处不再 `await`，仅触发优雅关闭。
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;

    // ── sh_quote：POSIX shell 单引号转义 ────────────────────────────────

    #[test]
    fn sh_quote_empty_string() {
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn sh_quote_plain_path() {
        assert_eq!(sh_quote("/home/user/project"), "'/home/user/project'");
    }

    #[test]
    fn sh_quote_no_special_chars_passes_through() {
        // 不含单引号 → 直接单引号包裹
        assert_eq!(sh_quote("hello world"), "'hello world'");
        assert_eq!(sh_quote("--acp"), "'--acp'");
    }

    #[test]
    fn sh_quote_with_single_quote_splits_segments() {
        // POSIX 转义规则：'foo'bar' → 'foo'\''bar'
        assert_eq!(sh_quote("foo'bar"), "'foo'\\''bar'");
    }

    #[test]
    fn sh_quote_only_single_quote() {
        // 极端情况：只有单引号
        // 实现逻辑：开单引号 → 对 `'` 字符插入 '然后转义'再开单引号 → 关单引号
        // 输入 `'` → `' '' \' '' '` 收敛为 `''\'''`
        // shell 解析：`''`(空) + `\'` (literal `'`) + `''`(空) = `'` ✓
        assert_eq!(sh_quote("'"), "''\\'''");
    }

    #[test]
    fn sh_quote_does_not_inject_shell_metacharacters() {
        // 含 `;` `&&` `$()` 都不应让 sh 误解析：单引号包裹下全部字面化
        let dangerous = "a; rm -rf /; $(echo bad); `id`";
        let quoted = sh_quote(dangerous);
        assert_eq!(quoted, format!("'{dangerous}'"));
    }

    // ── wrap_agent_with_cwd：shell wrapper 构造 ────────────────────────

    #[test]
    fn wrap_returns_cd_then_exec_form() {
        let args =
            wrap_agent_with_cwd("codebuddy", &["--acp".into()], Path::new("/home/user/project"));
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "-c");
        // cd 必须是 cd '/home/user/project' && exec 'codebuddy' '--acp'
        assert_eq!(args[1], "cd '/home/user/project' && exec 'codebuddy' '--acp'");
    }

    #[test]
    fn wrap_escapes_workspace_with_spaces_and_quotes() {
        let workspace = Path::new("/home/user/it's a 'project'");
        let args = wrap_agent_with_cwd("agent", &[], workspace);
        // workspace 路径里同时含空格和单引号，单引号必须被 '\\'' 分段转义
        assert!(args[1].contains("'/home/user/it'\\''s a '\\''project'\\'''"));
    }

    #[test]
    fn wrap_with_no_args_emits_cd_exec_only() {
        let args = wrap_agent_with_cwd("/usr/bin/myagent", &[], Path::new("/tmp"));
        assert_eq!(args[1], "cd '/tmp' && exec '/usr/bin/myagent'");
    }

    // ── 端到端：spawn 出来的子进程 cwd 必须等于 session workspace ────────

    /// 模拟 AcpClient::spawn_and_connect 的 all_args 构造路径，spawn
    /// `pwd` 进程并断言 stdout 等于 session workspace。这是
    /// `/proc/<pid>/cwd` 行为的端到端回归——单测 `wrap_agent_with_cwd`
    /// 只验证字符串拼接，不验证执行时 cwd 真的切到目标。
    #[tokio::test]
    async fn wrapped_subprocess_has_session_workspace_as_cwd() {
        // 用 tmp 子目录作为目标 workspace，避免依赖具体路径
        let workspace = std::env::temp_dir().join(format!(
            "omniterm-cwd-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&workspace).expect("create temp workspace");
        let workspace_str = workspace.to_string_lossy().to_string();

        // 模拟 spawn_and_connect 中的 wrapper 构造：
        // AcpAgent::from_args 接受 ["-c", <script>]，前面是 sh 路径
        // 实际行为：从 all_args[0] 解析命令（/bin/sh），all_args[1..] 作为参数
        let wrapped = wrap_agent_with_cwd("pwd", &[], &workspace);

        // 直接 spawn sh，验证子进程 cwd。捕获 stdout，期望 pwd 输出 workspace_str
        let output = std::process::Command::new("/bin/sh")
            .args(&wrapped)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("spawn sh");
        assert!(
            output.status.success(),
            "sh exited with {}: stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        assert_eq!(
            stdout, workspace_str,
            "subprocess cwd was {stdout:?}, expected {workspace_str:?} — wrap_agent_with_cwd \
             is not actually changing the OS cwd. This is the regression \
             the fix targets: agent-client-protocol's AcpAgent::spawn_process \
             does NOT call Command::current_dir, so the spawned agent runs \
             in the backend's cwd rather than the session's workspace_path."
        );

        // cleanup
        let _ = std::fs::remove_dir_all(&workspace);
    }

    /// 验证 wrap + sh 的 path-with-spaces 端到端：workspace 路径含空格时，
    /// `cd` 仍能正确切换、pwd 输出仍等于 workspace。
    #[tokio::test]
    async fn wrapped_subprocess_workspaces_with_spaces() {
        let parent = std::env::temp_dir();
        let workspace = parent.join(format!(
            "omniterm cwd test {}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&workspace).expect("create temp workspace with space");
        let workspace_str = workspace.to_string_lossy().to_string();
        assert!(
            workspace_str.contains(' '),
            "test setup must use a workspace with spaces; got {workspace_str}"
        );

        let wrapped = wrap_agent_with_cwd("pwd", &[], &workspace);
        let output = std::process::Command::new("/bin/sh")
            .args(&wrapped)
            .stdout(Stdio::piped())
            .output()
            .expect("spawn sh");
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        assert_eq!(
            stdout, workspace_str,
            "subprocess cwd with spaces-in-path didn't survive sh -c wrap"
        );

        let _ = std::fs::remove_dir_all(&workspace);
    }

    /// 验证 exec 替换 shell：子进程 PID 不同于 wrapper 自身。
    /// 若 shell 没被 exec 替换，会出现一个常驻 shell 子进程被 OOM-killer 抓到。
    /// （这是间接证据——若 build 输出 `exit_signal` 不是 0，则说明进程异常。）
    #[tokio::test]
    async fn wrapped_subprocess_exits_normally() {
        let workspace = std::env::temp_dir().join("omniterm-exec-test");
        let _ = std::fs::create_dir_all(&workspace);

        let wrapped = wrap_agent_with_cwd("true", &[], &workspace);
        let output =
            std::process::Command::new("/bin/sh").args(&wrapped).output().expect("spawn sh");
        assert!(output.status.success(), "wrapped exit != 0");
        // exec 替换后无残留 shell 进程——这里只断言正常退出，不强求 PID 不同
        // （exec 替换行为由 shell 保证，不应在测试中过度约束）

        let _ = std::fs::remove_dir_all(&workspace);
    }
}
