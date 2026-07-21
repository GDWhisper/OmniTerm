use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::acp::client::AcpClient;

#[derive(Clone, Default)]
pub struct AcpSupervisor {
    clients: Arc<Mutex<HashMap<String, Arc<AcpClient>>>>,
}

impl AcpSupervisor {
    pub async fn insert(&self, session_id: String, client: Arc<AcpClient>) {
        self.clients.lock().await.insert(session_id, client);
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
        self.clients.lock().await.remove(session_id)
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
