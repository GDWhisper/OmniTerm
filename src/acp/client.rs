use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, CreateTerminalRequest, InitializeRequest,
    KillTerminalRequest, NewSessionRequest, PromptRequest, PromptResponse,
    ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest, RequestPermissionRequest,
    SessionId, SessionNotification, TextContent, WaitForTerminalExitRequest,
    WriteTextFileRequest, WriteTextFileResponse,
};
use agent_client_protocol::{AcpAgent, Agent as AcpAgentRole, ConnectionTo, Error as AcpError};
use tokio::sync::{broadcast, oneshot};
use tokio::task::JoinHandle;

use crate::acp::handler;
use crate::acp::permission::PermissionManager;
use crate::acp::terminal::AcpTerminalManager;
use crate::models::agent::Agent;

pub struct AcpClient {
    connection: ConnectionTo<AcpAgentRole>,
    session_id: SessionId,
    session_update_tx: broadcast::Sender<SessionNotification>,
    _shutdown_tx: oneshot::Sender<()>,
    connection_task: JoinHandle<Result<(), AcpError>>,
    terminal_manager: Arc<AcpTerminalManager>,
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
        let (conn_tx, conn_rx) =
            oneshot::channel::<(ConnectionTo<AcpAgentRole>, SessionId)>();

        let notif_tx = session_update_tx.clone();
        let terminal_manager = Arc::new(AcpTerminalManager::new());
        let tm = terminal_manager.clone();

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
                async move |request: RequestPermissionRequest, responder, _cx| {
                    PermissionManager::resolve(request, responder)
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
                        cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                            .block_task()
                            .await?;

                        let session_resp = cx
                            .send_request(NewSessionRequest::new(cwd))
                            .block_task()
                            .await?;

                        let session_id = session_resp.session_id;
                        let _ = conn_tx.send((cx.clone(), session_id));

                        let _ = shutdown_rx.await;
                        Ok(())
                    },
                )
                .await
        });

        let (connection, session_id) = conn_rx
            .await
            .map_err(|_| AcpError::internal_error())?;

        Ok(AcpClient {
            connection,
            session_id,
            session_update_tx,
            _shutdown_tx: shutdown_tx,
            connection_task,
            terminal_manager,
        })
    }

    pub fn session_update_subscribe(&self) -> broadcast::Receiver<SessionNotification> {
        self.session_update_tx.subscribe()
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

    pub async fn disconnect(self) {
        drop(self._shutdown_tx);
        let _ = self.connection_task.await;
    }
}
