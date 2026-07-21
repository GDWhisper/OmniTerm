use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{broadcast, Mutex};

use crate::acp::client::AcpClient;

/// 进程存活状态变化事件：后端 supervisor 在 ACP agent 子进程注册（insert）
/// 或释放（dispose）时广播，供 WS handler 转发给对应会话的前端连接，
/// 替代前端对 `acp_process_alive` 的 3 秒轮询（事件驱动、即时更新指示灯）。
///
/// `session_id` 为 OmniTerm 的 DB session id（与 supervisor 的 HashMap key 一致），
/// 非 ACP 协议级 session id。
#[derive(Clone, Debug)]
pub struct AcpProcessEvent {
    pub session_id: String,
    pub alive: bool,
}

#[derive(Clone)]
pub struct AcpSupervisor {
    clients: Arc<Mutex<HashMap<String, Arc<AcpClient>>>>,
    /// 进程存活事件广播频道；insert/dispose 时 send，WS handler 订阅后转发。
    events: broadcast::Sender<AcpProcessEvent>,
}

impl Default for AcpSupervisor {
    fn default() -> Self {
        // broadcast::Sender 无 Default，手动构造频道（容量 64 足够并发连接数）。
        let (events, _) = broadcast::channel(64);
        Self {
            clients: Arc::new(Mutex::new(HashMap::new())),
            events,
        }
    }
}

impl AcpSupervisor {
    pub async fn insert(&self, session_id: String, client: Arc<AcpClient>) {
        self.clients.lock().await.insert(session_id.clone(), client);
        let _ = self
            .events
            .send(AcpProcessEvent { session_id, alive: true });
    }

    pub async fn get(&self, session_id: &str) -> Option<Arc<AcpClient>> {
        self.clients.lock().await.get(session_id).cloned()
    }

    /// 返回当前所有注册 client 的快照（session_id, Arc<AcpClient>）。
    /// 供空闲回收看护任务（reaper）遍历判定，不暴露内部 HashMap。
    pub async fn snapshot(&self) -> Vec<(String, Arc<AcpClient>)> {
        self.clients
            .lock()
            .await
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub async fn dispose(&self, session_id: &str) -> Option<Arc<AcpClient>> {
        let removed = self.clients.lock().await.remove(session_id);
        if removed.is_some() {
            let _ = self.events.send(AcpProcessEvent {
                session_id: session_id.to_string(),
                alive: false,
            });
        }
        removed
    }

    /// 订阅进程存活事件（类比 `AcpClient::session_update_subscribe`）。
    /// WS handler 用于向对应会话连接转发 `process_alive` 帧。
    pub fn process_event_subscribe(&self) -> broadcast::Receiver<AcpProcessEvent> {
        self.events.subscribe()
    }

    pub async fn shutdown_all(&self) {
        let mut map = self.clients.lock().await;
        for (_, client) in map.drain() {
            let c = Arc::try_unwrap(client).ok();
            if let Some(c) = c {
                c.disconnect().await;
            }
        }
    }
}
