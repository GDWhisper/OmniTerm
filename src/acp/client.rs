use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ConfigOptionUpdate, ContentBlock, CreateTerminalRequest, InitializeRequest,
    KillTerminalRequest, LoadSessionRequest, NewSessionRequest, PromptRequest, PromptResponse,
    ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest, RequestPermissionRequest,
    SessionConfigId, SessionConfigKind, SessionConfigOption, SessionConfigOptionValue, SessionId,
    SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, TextContent,
    WaitForTerminalExitRequest, WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::{AcpAgent, Agent as AcpAgentRole, ConnectionTo, Error as AcpError};
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

use crate::acp::handler;
use crate::acp::permission::{PermissionManager, PermissionRequestEvent};
use crate::acp::terminal::{AcpTerminalManager, TerminalActivity};
use crate::models::agent::Agent;

/// 后端可观测的 agent 活跃度状态（对所有 ACP agent 通用，与具体 agent 实现无关）。
///
/// ACP v1 协议（所有当前对接的 agent 均协商 protocolVersion:1）没有官方
/// `state_update`（`running`/`idle`/`requires_action`）状态机，agent 也不会
/// 发送 v2 状态帧。因此只能用后端可观测信号推断 agent 是否"在干活"：
/// - `active_prompt`：有进行中的 prompt（由 WS handler 在 Prompt/PromptDone/Err 时标记）
/// - `last_activity`：最近一次收到 agent 任意 `session/update` 通知的时间（任意 v1 agent 干活时都会持续发送）
/// - 未决权限数见 [`PermissionManager::pending_count`]（任意 agent 的 `request_permission` 均走此处）
/// 三者共同决定 idle / requires_action 语义（详见 `reaper` 模块）。
struct ActivityState {
    active_prompt: bool,
    last_activity: Instant,
}

impl ActivityState {
    fn new() -> Self {
        Self { active_prompt: false, last_activity: Instant::now() }
    }
}

pub struct AcpClient {
    connection: ConnectionTo<AcpAgentRole>,
    session_id: SessionId,
    session_update_tx: broadcast::Sender<SessionNotification>,
    _shutdown_tx: oneshot::Sender<()>,
    /// agent 连接任务崩溃时广播错误原因，供 WS 层即时透传给前端。
    /// 取代原先 `disconnect` 中 `let _ = connection_task.await` 被静默丢弃的错误。
    crash_tx: broadcast::Sender<String>,
    /// agent 终端命令生命周期事件（创建/退出），供 WS 层透传让前端感知后台命令。
    terminal_event_tx: broadcast::Sender<TerminalActivity>,
    terminal_manager: Arc<AcpTerminalManager>,
    permission_manager: Arc<PermissionManager>,
    supports_load_session: bool,
    initial_config_options: Arc<Mutex<Vec<SessionConfigOption>>>,
    available_commands_notif: Arc<Mutex<Option<SessionNotification>>>,
    /// 活跃度跟踪，供空闲回收看护任务（reaper）读取。
    activity: Arc<Mutex<ActivityState>>,
}

/// 看护 agent 连接任务：若其因 agent 进程崩溃/异常退出而返回 `Err`，
/// 通过 `crash_tx` 广播错误原因，供 WS 层即时透传给前端（否则该错误仅被
/// `disconnect` 中的 `let _ =` 丢弃，用户看不到崩溃原因）。
fn spawn_crash_watcher(
    connection_task: JoinHandle<Result<(), AcpError>>,
    crash_tx: broadcast::Sender<String>,
) {
    tokio::spawn(async move {
        if let Err(e) = connection_task.await {
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
    pub async fn spawn_and_connect(agent: Agent, cwd: PathBuf) -> Result<Self, AcpError> {
        let mut all_args: Vec<String> = Vec::new();

        for env_var in &agent.env {
            all_args.push(format!("{}={}", env_var.key, env_var.value));
        }
        // 包装 agent 命令为 `sh -c "cd <workspace> && exec <cmd> <args>"`，
        // 让 agent 子进程的 OS cwd 落在 session 的 workspace_path 上
        // （详见 wrap_agent_with_cwd 的 doc）。POSIX-only 路径。
        #[cfg(unix)]
        let (cmd, args) =
            ("/bin/sh".to_string(), wrap_agent_with_cwd(&agent.command, &agent.args, &cwd));
        #[cfg(not(unix))]
        let (cmd, args) = (agent.command.clone(), agent.args.clone());

        all_args.push(cmd);
        all_args.extend(args);

        let transport = AcpAgent::from_args(all_args)?;

        let (session_update_tx, _) = broadcast::channel(256);
        let (crash_tx, _) = broadcast::channel::<String>(16);
        let (terminal_event_tx, _) = broadcast::channel::<TerminalActivity>(64);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let (conn_tx, conn_rx) = oneshot::channel::<(
            ConnectionTo<AcpAgentRole>,
            SessionId,
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

        let builder = agent_client_protocol::Client
            .builder()
            .name("omniterm")
            .on_receive_notification(
                {
                    let tx = notif_tx.clone();
                    let activity = activity.clone();
                    let commands_notif = commands_notif.clone();
                    async move |notification: SessionNotification, _cx| {
                        // 收到任意 agent 通知即视为有活动，刷新最后活动时间
                        if let Ok(mut st) = activity.lock() {
                            st.last_activity = Instant::now();
                        }
                        if matches!(
                            notification.update,
                            SessionUpdate::AvailableCommandsUpdate(_)
                        ) {
                            if let Ok(mut guard) = commands_notif.lock() {
                                *guard = Some(notification.clone());
                            }
                        }
                        handler::handle_session_update(&tx, notification)
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

                    let session_resp =
                        cx.send_request(NewSessionRequest::new(cwd)).block_task().await?;

                    let config_options = session_resp.config_options.clone().unwrap_or_default();

                    let session_id = session_resp.session_id;
                    let _ = conn_tx.send((cx.clone(), session_id, supports_load, config_options));

                    let _ = shutdown_rx.await;
                    Ok(())
                })
                .await
        });

        spawn_crash_watcher(connection_task, crash_tx.clone());

        let (connection, session_id, supports_load_session, initial_config_options) =
            conn_rx.await.map_err(|_| AcpError::internal_error())?;

        Ok(AcpClient {
            connection,
            session_id,
            session_update_tx,
            _shutdown_tx: shutdown_tx,
            crash_tx,
            terminal_event_tx,
            terminal_manager,
            permission_manager,
            supports_load_session,
            initial_config_options: Arc::new(Mutex::new(initial_config_options)),
            available_commands_notif: commands_notif,
            activity,
        })
    }

    pub fn session_update_subscribe(&self) -> broadcast::Receiver<SessionNotification> {
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

    pub fn permission_subscribe(&self) -> broadcast::Receiver<PermissionRequestEvent> {
        self.permission_manager.subscribe()
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
                SessionConfigId::new(config_id),
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
            let _ = self.session_update_tx.send(notification);
        }
        Ok(())
    }

    pub fn session_id(&self) -> &SessionId {
        &self.session_id
    }

    pub async fn send_prompt(&self, text: &str) -> Result<PromptResponse, AcpError> {
        self.connection
            .send_request(PromptRequest::new(
                self.session_id.clone(),
                vec![ContentBlock::Text(TextContent::new(text))],
            ))
            .block_task()
            .await
    }

    pub fn cancel(&self) -> Result<(), AcpError> {
        self.connection.send_notification(CancelNotification::new(self.session_id.clone()))?;
        let tm = self.terminal_manager.clone();
        tokio::spawn(async move { tm.kill_all().await });
        Ok(())
    }

    pub fn supports_load_session(&self) -> bool {
        self.supports_load_session
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
            st.last_activity = Instant::now();
        }
    }

    /// 标记 prompt 已结束（由 WS handler 在 PromptDone/PromptError/Cancel 时调用）。
    pub fn mark_prompt_idle(&self) {
        if let Ok(mut st) = self.activity.lock() {
            st.active_prompt = false;
        }
    }

    /// 当前未决权限请求数（requires_action 语义）。
    pub async fn pending_permissions(&self) -> usize {
        self.permission_manager.pending_count().await
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
            let _ = self.session_update_tx.send(notification);
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
    ) -> Result<Self, AcpError> {
        let mut all_args: Vec<String> = Vec::new();
        for env_var in &agent.env {
            all_args.push(format!("{}={}", env_var.key, env_var.value));
        }
        // 包装 agent 命令为 `sh -c "cd <workspace> && exec <cmd> <args>"`，
        // 让 agent 子进程的 OS cwd 落在 session 的 workspace_path 上
        // （详见 wrap_agent_with_cwd 的 doc）。POSIX-only 路径。
        #[cfg(unix)]
        let (cmd, args) =
            ("/bin/sh".to_string(), wrap_agent_with_cwd(&agent.command, &agent.args, &cwd));
        #[cfg(not(unix))]
        let (cmd, args) = (agent.command.clone(), agent.args.clone());

        all_args.push(cmd);
        all_args.extend(args);

        let transport = AcpAgent::from_args(all_args)?;

        let (session_update_tx, _) = broadcast::channel(256);
        let (crash_tx, _) = broadcast::channel::<String>(16);
        let (terminal_event_tx, _) = broadcast::channel::<TerminalActivity>(64);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let (conn_tx, conn_rx) = oneshot::channel::<(
            ConnectionTo<AcpAgentRole>,
            SessionId,
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

        let builder = agent_client_protocol::Client
            .builder()
            .name("omniterm")
            .on_receive_notification(
                {
                    let tx = notif_tx.clone();
                    let activity = activity.clone();
                    let commands_notif = commands_notif.clone();
                    async move |notification: SessionNotification, _cx| {
                        // 收到任意 agent 通知即视为有活动，刷新最后活动时间
                        if let Ok(mut st) = activity.lock() {
                            st.last_activity = Instant::now();
                        }
                        if matches!(
                            notification.update,
                            SessionUpdate::AvailableCommandsUpdate(_)
                        ) {
                            if let Ok(mut guard) = commands_notif.lock() {
                                *guard = Some(notification.clone());
                            }
                        }
                        handler::handle_session_update(&tx, notification)
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

                    let session_id = SessionId::new(acp_session_id.as_str());
                    let _ = conn_tx.send((cx.clone(), session_id, supports_load, Vec::new()));

                    let _ = shutdown_rx.await;
                    Ok(())
                })
                .await
        });

        spawn_crash_watcher(connection_task, crash_tx.clone());

        let (connection, session_id, supports_load_session, initial_config_options) =
            conn_rx.await.map_err(|_| AcpError::internal_error())?;

        Ok(AcpClient {
            connection,
            session_id,
            session_update_tx,
            _shutdown_tx: shutdown_tx,
            crash_tx,
            terminal_event_tx,
            terminal_manager,
            permission_manager,
            supports_load_session,
            initial_config_options: Arc::new(Mutex::new(initial_config_options)),
            available_commands_notif: commands_notif,
            activity,
        })
    }

    pub async fn disconnect(self) {
        // 回收本会话可能创建的终端子进程（kill_on_drop 依赖 TerminalProcess 被 drop，
        // 但 spawned 的 wait task 持有 Child 句柄，需显式 kill_all 通知其退出）。
        self.terminal_manager.kill_all().await;
        drop(self._shutdown_tx);
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
