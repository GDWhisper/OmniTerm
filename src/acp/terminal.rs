use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    CreateTerminalRequest, CreateTerminalResponse, KillTerminalRequest, KillTerminalResponse,
    ReleaseTerminalRequest, ReleaseTerminalResponse, TerminalExitStatus, TerminalId,
    TerminalOutputRequest, TerminalOutputResponse, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse,
};
use agent_client_protocol::Responder;
use tokio::io::AsyncReadExt;
use tokio::sync::{Mutex, mpsc, oneshot};
use uuid::Uuid;

struct TerminalProcess {
    kill_tx: mpsc::Sender<()>,
    output: Arc<Mutex<String>>,
    output_byte_limit: Option<u64>,
    exit_status: Option<TerminalExitStatus>,
    exit_waiters: Vec<oneshot::Sender<TerminalExitStatus>>,
}

pub struct AcpTerminalManager {
    terminals: Arc<Mutex<HashMap<String, TerminalProcess>>>,
}

impl AcpTerminalManager {
    pub fn new() -> Self {
        Self {
            terminals: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn handle_create(
        &self,
        request: CreateTerminalRequest,
        responder: Responder<CreateTerminalResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        let terminal_id = Uuid::new_v4().to_string();

        let mut cmd = tokio::process::Command::new(&request.command);
        cmd.args(&request.args);
        cmd.kill_on_drop(true);

        for env_var in &request.env {
            cmd.env(&env_var.name, &env_var.value);
        }

        if let Some(cwd) = &request.cwd {
            cmd.current_dir(cwd);
        }

        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("terminal/create: failed to spawn '{}': {}", request.command, e);
                return responder.respond_with_error(agent_client_protocol::Error::internal_error());
            }
        };

        let output = Arc::new(Mutex::new(String::new()));
        let output_byte_limit = request.output_byte_limit;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let output_clone = output.clone();
        let limit = output_byte_limit;
        tokio::spawn(async move {
            let mut buf = Vec::new();
            if let Some(mut stdout) = stdout {
                let _ = stdout.read_to_end(&mut buf).await;
            }
            if let Some(mut stderr) = stderr {
                let _ = stderr.read_to_end(&mut buf).await;
            }
            let text = String::from_utf8_lossy(&buf).into_owned();
            let mut out = output_clone.lock().await;
            out.push_str(&text);
            if let Some(limit) = limit {
                if out.len() > limit as usize {
                    let start = out.len() - limit as usize;
                    *out = out[start..].to_string();
                }
            }
        });

        let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);

        let terminals = self.terminals.clone();
        let tid = terminal_id.clone();
        tokio::spawn(async move {
            let exit_status = tokio::select! {
                status = child.wait() => {
                    match status {
                        Ok(s) => TerminalExitStatus::new()
                            .exit_code(s.code().map(|c| c as u32)),
                        Err(_) => TerminalExitStatus::new(),
                    }
                }
                _ = kill_rx.recv() => {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    TerminalExitStatus::new()
                }
            };

            let mut map = terminals.lock().await;
            if let Some(proc) = map.get_mut(&tid) {
                proc.exit_status = Some(exit_status.clone());
                for waiter in proc.exit_waiters.drain(..) {
                    let _ = waiter.send(exit_status.clone());
                }
            }
        });

        let proc = TerminalProcess {
            kill_tx,
            output,
            output_byte_limit,
            exit_status: None,
            exit_waiters: Vec::new(),
        };

        self.terminals.lock().await.insert(terminal_id.clone(), proc);

        responder.respond(CreateTerminalResponse::new(TerminalId::new(terminal_id)))
    }

    pub async fn handle_output(
        &self,
        request: TerminalOutputRequest,
        responder: Responder<TerminalOutputResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        let tid = request.terminal_id.0.to_string();
        let map = self.terminals.lock().await;

        match map.get(&tid) {
            Some(proc) => {
                let output = proc.output.lock().await.clone();
                let truncated = proc
                    .output_byte_limit
                    .is_some_and(|limit| output.len() >= limit as usize);
                responder.respond(
                    TerminalOutputResponse::new(output, truncated)
                        .exit_status(proc.exit_status.clone()),
                )
            }
            None => responder.respond(TerminalOutputResponse::new(String::new(), false)),
        }
    }

    pub async fn handle_kill(
        &self,
        request: KillTerminalRequest,
        responder: Responder<KillTerminalResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        let tid = request.terminal_id.0.to_string();
        let map = self.terminals.lock().await;

        if let Some(proc) = map.get(&tid) {
            let _ = proc.kill_tx.send(()).await;
        }

        responder.respond(KillTerminalResponse::new())
    }

    pub async fn handle_release(
        &self,
        request: ReleaseTerminalRequest,
        responder: Responder<ReleaseTerminalResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        let tid = request.terminal_id.0.to_string();
        let mut map = self.terminals.lock().await;

        if let Some(proc) = map.remove(&tid) {
            let _ = proc.kill_tx.send(()).await;
        }

        responder.respond(ReleaseTerminalResponse::new())
    }

    pub async fn handle_wait_for_exit(
        &self,
        request: WaitForTerminalExitRequest,
        responder: Responder<WaitForTerminalExitResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        let tid = request.terminal_id.0.to_string();
        let mut map = self.terminals.lock().await;

        match map.get_mut(&tid) {
            Some(proc) => {
                if let Some(status) = proc.exit_status.clone() {
                    return responder.respond(WaitForTerminalExitResponse::new(status));
                }
                let (tx, rx) = oneshot::channel();
                proc.exit_waiters.push(tx);
                drop(map);

                match rx.await {
                    Ok(status) => responder.respond(WaitForTerminalExitResponse::new(status)),
                    Err(_) => {
                        responder.respond(WaitForTerminalExitResponse::new(
                            TerminalExitStatus::new(),
                        ))
                    }
                }
            }
            None => responder.respond(WaitForTerminalExitResponse::new(
                TerminalExitStatus::new(),
            )),
        }
    }

    pub async fn kill_all(&self) {
        let mut map = self.terminals.lock().await;
        for (_, proc) in map.drain() {
            let _ = proc.kill_tx.send(()).await;
        }
    }
}
