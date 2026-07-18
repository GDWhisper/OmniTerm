use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tracing::{error, info};

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
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
enum AcpServerMessage<'a> {
    #[serde(rename = "error")]
    Error { message: &'a str },
    #[serde(rename = "session_update")]
    SessionUpdate { data: serde_json::Value },
    #[serde(rename = "prompt_done")]
    PromptDone { stop_reason: &'a str },
    #[serde(rename = "prompt_error")]
    PromptError { message: &'a str },
}

async fn handle_acp_ws(socket: WebSocket, session_id: String, state: AppState) {
    let client = match state.acp_supervisor.get(&session_id).await {
        Some(c) => {
            info!("ACP WS connected: session_id={} (supervisor hit)", session_id);
            c
        }
        None => {
            info!("ACP WS rejected: session_id={} not in supervisor", session_id);
            let (mut ws_tx, _) = socket.split();
            let msg = serde_json::to_string(&AcpServerMessage::Error {
                message: "ACP session not found",
            })
            .unwrap();
            let _ = ws_tx.send(Message::Text(msg.into())).await;
            return;
        }
    };

    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut rx = client.session_update_subscribe();

    let client_for_recv = client.clone();
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::channel::<Message>(64);

    let notify_tx_spawn = notify_tx.clone();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(notification) => {
                    let data = serde_json::to_value(&notification).unwrap_or_default();
                    let msg = serde_json::to_string(&AcpServerMessage::SessionUpdate { data })
                        .unwrap_or_default();
                    if notify_tx_spawn
                        .send(Message::Text(msg.into()))
                        .await
                        .is_err()
                    {
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

    loop {
        tokio::select! {
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<AcpClientMessage>(&text) {
                            Ok(AcpClientMessage::Prompt { text: prompt_text }) => {
                                let client = client_for_recv.clone();
                                let tx = notify_tx.clone();
                                tokio::spawn(async move {
                                    match client.send_prompt(&prompt_text).await {
                                        Ok(resp) => {
                                            let reason = format!("{:?}", resp.stop_reason);
                                            let msg = serde_json::to_string(
                                                &AcpServerMessage::PromptDone {
                                                    stop_reason: &reason,
                                                },
                                            )
                                            .unwrap_or_default();
                                            let _ = tx.send(Message::Text(msg.into())).await;
                                        }
                                        Err(e) => {
                                            let err_msg = format!("{}", e);
                                            let msg = serde_json::to_string(
                                                &AcpServerMessage::PromptError {
                                                    message: &err_msg,
                                                },
                                            )
                                            .unwrap_or_default();
                                            let _ = tx.send(Message::Text(msg.into())).await;
                                        }
                                    }
                                });
                            }
                            Ok(AcpClientMessage::Cancel) => {
                                if let Err(e) = client_for_recv.cancel() {
                                    error!("ACP cancel failed: {}", e);
                                }
                            }
                            Err(e) => {
                                let err_msg = format!("invalid message: {}", e);
                                let msg = serde_json::to_string(&AcpServerMessage::Error {
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
