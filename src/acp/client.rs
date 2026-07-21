use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ConfigOptionUpdate, ContentBlock, CreateTerminalRequest,
    InitializeRequest, KillTerminalRequest, LoadSessionRequest, NewSessionRequest, PromptRequest,
    PromptResponse, ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest,
    RequestPermissionRequest, SessionConfigId, SessionConfigKind, SessionConfigOption,
    SessionConfigOptionValue, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, TextContent, WaitForTerminalExitRequest, WriteTextFileRequest,
    WriteTextFileResponse,
};
use agent_client_protocol::{AcpAgent, Agent as AcpAgentRole, ConnectionTo, Error as AcpError};
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

use crate::acp::handler;
use crate::acp::permission::{PermissionManager, PermissionRequestEvent};
use crate::acp::terminal::AcpTerminalManager;
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
        Self {
            active_prompt: false,
            last_activity: Instant::now(),
        }
    }
}

pub struct AcpClient {
    connection: ConnectionTo<AcpAgentRole>,
    session_id: SessionId,
    session_update_tx: broadcast::Sender<SessionNotification>,
    _shutdown_tx: oneshot::Sender<()>,
    connection_task: JoinHandle<Result<(), AcpError>>,
    terminal_manager: Arc<AcpTerminalManager>,
    permission_manager: Arc<PermissionManager>,
    supports_load_session: bool,
    initial_config_options: Arc<Mutex<Vec<SessionConfigOption>>>,
    available_commands_notif: Arc<Mutex<Option<SessionNotification>>>,
    /// 活跃度跟踪，供空闲回收看护任务（reaper）读取。
    activity: Arc<Mutex<ActivityState>>,
}

impl AcpClient {
    pub async fn spawn_and_connect(agent: Agent, cwd: PathBuf) -> Result<Self, AcpError> {
        let mut all_args: Vec<String> = Vec::new();

        for env_var in &agent.env {
            all_args.push(format!("{}={}", env_var.key, env_var.value));
        }
        all_args.push(agent.command.clone());
        all_args.extend(agent.args.clone());

        let transport = AcpAgent::from_args(all_args)?;

        let (session_update_tx, _) = broadcast::channel(256);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let (conn_tx, conn_rx) = oneshot::channel::<(
            ConnectionTo<AcpAgentRole>,
            SessionId,
            bool,
            Vec<SessionConfigOption>,
        )>();

        let notif_tx = session_update_tx.clone();
        let terminal_manager = Arc::new(AcpTerminalManager::new());
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
                async move |_request: ReadTextFileRequest, responder, _cx| {
                    responder.respond(ReadTextFileResponse::new(""))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: WriteTextFileRequest, responder, _cx| {
                    responder.respond(WriteTextFileResponse::new())
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
                .connect_with(
                    transport,
                    move |cx: ConnectionTo<AcpAgentRole>| async move {
                        let init_resp = cx
                            .send_request(InitializeRequest::new(ProtocolVersion::V1))
                            .block_task()
                            .await?;
                        let supports_load = init_resp.agent_capabilities.load_session;

                        let session_resp = cx
                            .send_request(NewSessionRequest::new(cwd))
                            .block_task()
                            .await?;

                        let config_options =
                            session_resp.config_options.clone().unwrap_or_default();

                        let session_id = session_resp.session_id;
                        let _ = conn_tx.send((cx.clone(), session_id, supports_load, config_options));

                        let _ = shutdown_rx.await;
                        Ok(())
                    },
                )
                .await
        });

        let (connection, session_id, supports_load_session, initial_config_options) = conn_rx
            .await
            .map_err(|_| AcpError::internal_error())?;

        Ok(AcpClient {
            connection,
            session_id,
            session_update_tx,
            _shutdown_tx: shutdown_tx,
            connection_task,
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
                opts.iter().any(|o| {
                    o.id.0 == config_id && matches!(o.kind, SessionConfigKind::Boolean(_))
                })
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
        self.connection
            .send_notification(CancelNotification::new(self.session_id.clone()))?;
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
            .send_request(LoadSessionRequest::new(
                SessionId::new(acp_session_id),
                cwd,
            ))
            .block_task()
            .await?;

        if let Some(opts) = resp.config_options {
            if !opts.is_empty() {
                if let Ok(mut guard) = self.initial_config_options.lock() {
                    *guard = opts.clone();
                }
                let notification = SessionNotification::new(
                    self.session_id.clone(),
                    SessionUpdate::ConfigOptionUpdate(ConfigOptionUpdate::new(opts)),
                );
                let _ = self.session_update_tx.send(notification);
            }
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
        _cwd: PathBuf,
        acp_session_id: String,
    ) -> Result<Self, AcpError> {
        let mut all_args: Vec<String> = Vec::new();
        for env_var in &agent.env {
            all_args.push(format!("{}={}", env_var.key, env_var.value));
        }
        all_args.push(agent.command.clone());
        all_args.extend(agent.args.clone());

        let transport = AcpAgent::from_args(all_args)?;

        let (session_update_tx, _) = broadcast::channel(256);
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let (conn_tx, conn_rx) = oneshot::channel::<(
            ConnectionTo<AcpAgentRole>,
            SessionId,
            bool,
            Vec<SessionConfigOption>,
        )>();

        let notif_tx = session_update_tx.clone();
        let terminal_manager = Arc::new(AcpTerminalManager::new());
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
                async move |_request: ReadTextFileRequest, responder, _cx| {
                    responder.respond(ReadTextFileResponse::new(""))
                },
                agent_client_protocol::on_receive_request!(),
            )
            .on_receive_request(
                async move |_request: WriteTextFileRequest, responder, _cx| {
                    responder.respond(WriteTextFileResponse::new())
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
                .connect_with(
                    transport,
                    move |cx: ConnectionTo<AcpAgentRole>| async move {
                        let init_resp = cx
                            .send_request(InitializeRequest::new(ProtocolVersion::V1))
                            .block_task()
                            .await?;
                        let supports_load = init_resp.agent_capabilities.load_session;

                        let session_id = SessionId::new(acp_session_id.as_str());
                        let _ = conn_tx.send((cx.clone(), session_id, supports_load, Vec::new()));

                        let _ = shutdown_rx.await;
                        Ok(())
                    },
                )
                .await
        });

        let (connection, session_id, supports_load_session, initial_config_options) = conn_rx
            .await
            .map_err(|_| AcpError::internal_error())?;

        Ok(AcpClient {
            connection,
            session_id,
            session_update_tx,
            _shutdown_tx: shutdown_tx,
            connection_task,
            terminal_manager,
            permission_manager,
            supports_load_session,
            initial_config_options: Arc::new(Mutex::new(initial_config_options)),
            available_commands_notif: commands_notif,
            activity,
        })
    }

    pub async fn disconnect(self) {
        drop(self._shutdown_tx);
        let _ = self.connection_task.await;
    }
}
