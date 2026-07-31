use std::collections::HashMap;
use std::sync::Arc;

use agent_client_protocol::Responder;
use agent_client_protocol::schema::v1::{
    PermissionOptionId, RequestPermissionOutcome, RequestPermissionRequest,
    RequestPermissionResponse, SelectedPermissionOutcome,
};
use serde::Serialize;
use tokio::sync::{Mutex, broadcast};
use uuid::Uuid;

#[derive(Clone, Debug, Serialize)]
pub struct PermissionRequestEvent {
    pub id: String,
    pub request: serde_json::Value,
}

/// 未决审批：应答句柄 + 原始请求（供 WS 重连时重放 banner）。
struct PendingEntry {
    responder: Responder<RequestPermissionResponse>,
    request: serde_json::Value,
}

pub struct PermissionManager {
    pending: Arc<Mutex<HashMap<String, PendingEntry>>>,
    request_tx: broadcast::Sender<PermissionRequestEvent>,
    /// 审批解决（用户应答 / cancel_all）时广播其 id：审批可能由另一条 WS
    /// 连接（其他标签页/设备）应答，所有连接都要即时清除对应 banner。
    resolved_tx: broadcast::Sender<String>,
}

impl PermissionManager {
    pub fn new() -> Self {
        let (request_tx, _) = broadcast::channel(16);
        let (resolved_tx, _) = broadcast::channel(16);
        Self { pending: Arc::new(Mutex::new(HashMap::new())), request_tx, resolved_tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<PermissionRequestEvent> {
        self.request_tx.subscribe()
    }

    /// 订阅审批解决事件（载荷为审批 id）。
    pub fn resolved_subscribe(&self) -> broadcast::Receiver<String> {
        self.resolved_tx.subscribe()
    }

    /// 当前未决（等待用户响应）的权限请求数量。用于活跃度守卫判断 agent
    /// 是否处于 requires_action 状态。
    pub async fn pending_count(&self) -> usize {
        self.pending.lock().await.len()
    }

    /// 登记权限请求并广播给前端，等待用户经 [`Self::resolve`] 应答。
    ///
    /// 不设超时自动应答：ACP 规范规定 `Cancelled` outcome 仅用于响应
    /// `session/cancel`（见 [`Self::cancel_all`]），审批必须等真人决策。
    /// 长期无人应答的兜底回收由 reaper 负责（30 分钟 cancel + disconnect）。
    pub async fn handle_request(
        &self,
        request: RequestPermissionRequest,
        responder: Responder<RequestPermissionResponse>,
    ) -> Result<(), agent_client_protocol::Error> {
        let id = Uuid::new_v4().to_string();
        let request = serde_json::to_value(&request).unwrap_or_default();

        let event = PermissionRequestEvent { id: id.clone(), request: request.clone() };

        self.pending.lock().await.insert(id, PendingEntry { responder, request });
        let _ = self.request_tx.send(event);

        Ok(())
    }

    /// 所有未决审批的事件快照（WS 连接/重连时重放，恢复前端 banner）。
    pub async fn pending_events(&self) -> Vec<PermissionRequestEvent> {
        self.pending
            .lock()
            .await
            .iter()
            .map(|(id, entry)| PermissionRequestEvent {
                id: id.clone(),
                request: entry.request.clone(),
            })
            .collect()
    }

    /// 以 `Cancelled` outcome 应答所有未决权限请求。
    ///
    /// ACP 规范：client 发送 `session/cancel` 后 MUST 用 `Cancelled` 回复
    /// 所有 pending 的 `session/request_permission`。由 `AcpClient::cancel`
    /// 在发出 CancelNotification 时调用。
    pub async fn cancel_all(&self) {
        let mut map = self.pending.lock().await;
        for (id, entry) in map.drain() {
            let _ = entry
                .responder
                .respond(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled));
            let _ = self.resolved_tx.send(id);
        }
    }

    pub async fn resolve(&self, id: &str, option_id: &str) -> bool {
        let mut map = self.pending.lock().await;
        if let Some(entry) = map.remove(id) {
            let _ = entry.responder.respond(RequestPermissionResponse::new(
                RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(
                    PermissionOptionId::new(option_id),
                )),
            ));
            let _ = self.resolved_tx.send(id.to_string());
            true
        } else {
            false
        }
    }
}
