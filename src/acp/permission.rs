use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    PermissionOptionId, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome,
};
use agent_client_protocol::Responder;
use serde::Serialize;
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

const PERMISSION_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize)]
pub struct PermissionRequestEvent {
    pub id: String,
    pub request: serde_json::Value,
}

pub struct PermissionManager {
    pending: Arc<Mutex<HashMap<String, Responder<RequestPermissionResponse>>>>,
    request_tx: broadcast::Sender<PermissionRequestEvent>,
}

impl PermissionManager {
    pub fn new() -> Self {
        let (request_tx, _) = broadcast::channel(16);
        Self {
            pending: Arc::new(Mutex::new(HashMap::new())),
            request_tx,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PermissionRequestEvent> {
        self.request_tx.subscribe()
    }

    /// 当前未决（等待用户响应）的权限请求数量。用于活跃度守卫判断 agent
    /// 是否处于 requires_action 状态。
    pub async fn pending_count(&self) -> usize {
        self.pending.lock().await.len()
    }

    pub async fn handle_request(
        &self,
        request: RequestPermissionRequest,
        responder: Responder<RequestPermissionResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        let id = Uuid::new_v4().to_string();

        let event = PermissionRequestEvent {
            id: id.clone(),
            request: serde_json::to_value(&request).unwrap_or_default(),
        };

        self.pending.lock().await.insert(id.clone(), responder);
        let _ = self.request_tx.send(event);

        let pending = self.pending.clone();
        let timeout_id = id;
        tokio::spawn(async move {
            tokio::time::sleep(PERMISSION_TIMEOUT).await;
            let mut map = pending.lock().await;
            if let Some(responder) = map.remove(&timeout_id) {
                let _ = responder.respond(RequestPermissionResponse::new(
                    RequestPermissionOutcome::Cancelled,
                ));
            }
        });

        Ok(())
    }

    pub async fn resolve(&self, id: &str, option_id: &str) -> bool {
        let mut map = self.pending.lock().await;
        if let Some(responder) = map.remove(id) {
            let _ = responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    PermissionOptionId::new(option_id),
                )),
            ));
            true
        } else {
            false
        }
    }
}
