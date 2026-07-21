use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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

        let builder = agent_client_protocol::Client
            .builder()
            .name("omniterm")
            .on_receive_notification(
                {
                    let tx = notif_tx.clone();
                    async move |notification: SessionNotification, _cx| {
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

        let builder = agent_client_protocol::Client
            .builder()
            .name("omniterm")
            .on_receive_notification(
                {
                    let tx = notif_tx.clone();
                    async move |notification: SessionNotification, _cx| {
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
        })
    }

    pub async fn disconnect(self) {
        drop(self._shutdown_tx);
        let _ = self.connection_task.await;
    }
}
