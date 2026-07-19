use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{error, info};

use crate::acp::chat_persistence;
use crate::acp::permission::PermissionRequestEvent;
use crate::acp::AcpClient;
use crate::api::agents::load_agent;
use crate::AppState;

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
    Prompt { text: String },
    #[serde(rename = "cancel")]
    Cancel,
    #[serde(rename = "load_session")]
    LoadSession,
    #[serde(rename = "permission_response")]
    PermissionResponse { id: String, option_id: String },
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
    SessionUpdate { data: serde_json::Value },
    #[serde(rename = "prompt_done")]
    PromptDone { stop_reason: &'a str },
    #[serde(rename = "prompt_error")]
    PromptError { message: &'a str },
    #[serde(rename = "replay_start")]
    ReplayStart,
    #[serde(rename = "replay_end")]
    ReplayEnd,
    #[serde(rename = "permission_request")]
    PermissionRequest {
        id: &'a str,
        request: &'a serde_json::Value,
    },
}

fn extract_text_from_notification(data: &serde_json::Value) -> Option<String> {
    let update = data.get("update")?;
    let obj = update.as_object()?;

    let chunk = if let Some(c) = obj.get("AgentMessageChunk") {
        c
    } else if obj.get("sessionUpdate").and_then(|v| v.as_str())
        == Some("agent_message_chunk")
    {
        update
    } else {
        return None;
    };

    let content = chunk.get("content")?;
    if let Some(text_obj) = content.get("Text").or_else(|| content.get("text")) {
        if let Some(t) = text_obj.get("text").and_then(|v| v.as_str()) {
            return Some(t.to_string());
        }
    }
    if let Some(t) = content.get("text").and_then(|v| v.as_str()) {
        return Some(t.to_string());
    }
    if let Some(t) = chunk.get("text").and_then(|v| v.as_str()) {
        return Some(t.to_string());
    }
    None
}

async fn spawn_notify_task(
    mut rx: tokio::sync::broadcast::Receiver<agent_client_protocol::schema::v1::SessionNotification>,
    notify_tx: tokio::sync::mpsc::Sender<Message>,
    buf: Arc<Mutex<String>>,
) {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(notification) => {
                    let data = serde_json::to_value(&notification).unwrap_or_default();
                    if let Some(text) = extract_text_from_notification(&data) {
                        buf.lock().await.push_str(&text);
                    }
                    let msg = serde_json::to_string(&AcpServerMessage::SessionUpdate { data })
                        .unwrap_or_default();
                    if notify_tx.send(Message::Text(msg.into())).await.is_err() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("ACP WS subscriber lagged by {} messages", n);
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
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
            }
        }
    });
}

async fn handle_acp_ws(socket: WebSocket, session_id: String, state: AppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::channel::<Message>(64);
    let assistant_buf: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

    let mut client: Option<Arc<AcpClient>> = match state.acp_supervisor.get(&session_id).await {
        Some(c) => {
            info!("ACP WS connected: session_id={} (supervisor hit)", session_id);
            let rx = c.session_update_subscribe();
            spawn_notify_task(rx, notify_tx.clone(), assistant_buf.clone()).await;
            let perm_rx = c.permission_subscribe();
            spawn_permission_task(perm_rx, notify_tx.clone()).await;
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

    let db = state.db.clone();
    let sid = session_id.clone();

    loop {
        tokio::select! {
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<AcpClientMessage>(&text) {
                            Ok(AcpClientMessage::Prompt { text: prompt_text }) => {
                                let Some(ref c) = client else {
                                    let msg = serde_json::to_string(&AcpServerMessage::Error {
                                        code: Some("session_not_found"),
                                        message: "no active ACP session",
                                    }).unwrap_or_default();
                                    let _ = ws_tx.send(Message::Text(msg.into())).await;
                                    continue;
                                };

                                let _ = chat_persistence::insert_message(
                                    &db, &sid, "user", &prompt_text,
                                ).await;

                                let c = c.clone();
                                let tx = notify_tx.clone();
                                let db2 = db.clone();
                                let sid2 = sid.clone();
                                let buf2 = assistant_buf.clone();
                                tokio::spawn(async move {
                                    match c.send_prompt(&prompt_text).await {
                                        Ok(resp) => {
                                            tokio::task::yield_now().await;
                                            let assistant_text = buf2.lock().await.drain(..).collect::<String>();
                                            if !assistant_text.is_empty() {
                                                let _ = chat_persistence::insert_message(
                                                    &db2, &sid2, "assistant", &assistant_text,
                                                ).await;
                                            }
                                            let reason = format!("{:?}", resp.stop_reason);
                                            let msg = serde_json::to_string(
                                                &AcpServerMessage::PromptDone { stop_reason: &reason },
                                            ).unwrap_or_default();
                                            let _ = tx.send(Message::Text(msg.into())).await;
                                        }
                                        Err(e) => {
                                            buf2.lock().await.clear();
                                            let err_msg = format!("{}", e);
                                            let msg = serde_json::to_string(
                                                &AcpServerMessage::PromptError { message: &err_msg },
                                            ).unwrap_or_default();
                                            let _ = tx.send(Message::Text(msg.into())).await;
                                        }
                                    }
                                });
                            }
                            Ok(AcpClientMessage::Cancel) => {
                                if let Some(ref c) = client {
                                    if let Err(e) = c.cancel() {
                                        error!("ACP cancel failed: {}", e);
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

                                        state.acp_supervisor.insert(sid.clone(), new_client.clone()).await;

                                        let rx = new_client.session_update_subscribe();
                                        spawn_notify_task(rx, notify_tx.clone(), assistant_buf.clone()).await;
                                        let perm_rx = new_client.permission_subscribe();
                                        spawn_permission_task(perm_rx, notify_tx.clone()).await;
                                        client = Some(new_client.clone());

                                        let replay_msg = serde_json::to_string(&AcpServerMessage::ReplayStart).unwrap_or_default();
                                        let _ = ws_tx.send(Message::Text(replay_msg.into())).await;

                                        let tx = notify_tx.clone();
                                        tokio::spawn(async move {
                                            let result = new_client.load_session(&acp_sid, cwd).await;
                                            let msg = match result {
                                                Ok(()) => serde_json::to_string(&AcpServerMessage::ReplayEnd).unwrap_or_default(),
                                                Err(e) => serde_json::to_string(&AcpServerMessage::Error {
                                                    code: Some("load_failed"),
                                                    message: &format!("session/load failed: {}", e),
                                                }).unwrap_or_default(),
                                            };
                                            let _ = tx.send(Message::Text(msg.into())).await;
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
                    _ => {}
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
        }
    }
}
