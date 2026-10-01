use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, broadcast};

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
        Self { clients: Arc::new(Mutex::new(HashMap::new())), events }
    }
}

impl AcpSupervisor {
    pub async fn insert(&self, session_id: String, client: Arc<AcpClient>) {
        self.clients.lock().await.insert(session_id.clone(), client);
        let _ = self.events.send(AcpProcessEvent { session_id, alive: true });
    }

    pub async fn get(&self, session_id: &str) -> Option<Arc<AcpClient>> {
        self.clients.lock().await.get(session_id).cloned()
    }

    /// 返回当前所有注册 client 的快照（session_id, Arc<AcpClient>）。
    /// 供空闲回收看护任务（reaper）遍历判定，不暴露内部 HashMap。
    pub async fn snapshot(&self) -> Vec<(String, Arc<AcpClient>)> {
        self.clients.lock().await.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    pub async fn dispose(&self, session_id: &str) -> Option<Arc<AcpClient>> {
        let removed = self.clients.lock().await.remove(session_id);
        if removed.is_some() {
            let _ = self
                .events
                .send(AcpProcessEvent { session_id: session_id.to_string(), alive: false });
        }
        removed
    }

    /// 订阅进程存活事件（类比 `AcpClient::session_update_subscribe`）。
    /// WS handler 用于向对应会话连接转发 `process_alive` 帧。
    pub fn process_event_subscribe(&self) -> broadcast::Receiver<AcpProcessEvent> {
        self.events.subscribe()
    }

    pub async fn shutdown_all(&self) {
        // 通过 Arc 引用调用 shutdown()，不依赖 try_unwrap（可能因 WS handler
        // 仍持有引用而失败，导致 agent 子进程变孤儿）。
        let clients: Vec<_> = self.clients.lock().await.drain().collect();
        for (_, client) in clients {
            client.shutdown().await;
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::acp::agent_proc::spawn_test_lock_async;
    use crate::acp::test_support::{
        KILL_TIMEOUT, agent_for, proc_dead, proc_reaped, spawn_connect, unique_dir, wait_until,
        write_fake_agent,
    };

    /// 注册/查询/快照/释放全链路 + 进程存活事件广播（前端指示灯的事件驱动源）。
    #[tokio::test]
    async fn insert_get_snapshot_dispose_broadcasts_lifecycle_events() {
        let _guard = spawn_test_lock_async().await;
        let dir = unique_dir("sup-lifecycle");
        let workspace = dir.join("ws");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let script = write_fake_agent(&dir);

        let client = Arc::new(spawn_connect(agent_for(&script, "live", &dir), workspace).await);
        let sup = AcpSupervisor::default();
        let mut events = sup.process_event_subscribe();

        sup.insert("s1".to_string(), client.clone()).await;
        let got = sup.get("s1").await.expect("insert 后 get 应命中");
        assert!(Arc::ptr_eq(&got, &client), "get 应返回同一 client 实例");
        let snap = sup.snapshot().await;
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].0, "s1");

        let ev = events.try_recv().expect("insert 应广播 alive=true 事件");
        assert_eq!(ev.session_id, "s1");
        assert!(ev.alive);

        let removed = sup.dispose("s1").await;
        assert!(removed.is_some(), "dispose 应返回被移除的 client");
        assert!(sup.get("s1").await.is_none(), "dispose 后 get 应为 None");
        assert!(sup.snapshot().await.is_empty(), "dispose 后快照应为空");

        let ev = events.try_recv().expect("dispose 应广播 alive=false 事件");
        assert_eq!(ev.session_id, "s1");
        assert!(!ev.alive);

        // 释放不存在的项不得广播（否则前端会收到幻觉会话的灯灭事件）。
        assert!(sup.dispose("s1").await.is_none());
        assert!(events.try_recv().is_err(), "dispose 未命中不应广播事件");

        client.shutdown().await;
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// shutdown_all：排空注册表并杀掉全部 agent 进程（后端重启/手动重启路径）。
    #[tokio::test]
    async fn shutdown_all_drains_clients_and_kills_agents() {
        let _guard = spawn_test_lock_async().await;
        let dir = unique_dir("sup-shutdown");
        let workspace = dir.join("ws");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let script = write_fake_agent(&dir);

        let sup = AcpSupervisor::default();
        let mut pids = Vec::new();
        for id in ["a", "b"] {
            let client =
                Arc::new(spawn_connect(agent_for(&script, "live", &dir), workspace.clone()).await);
            pids.push(client.agent_pid().expect("D1：live 模式必须捕获 pid"));
            sup.insert(id.to_string(), client).await;
        }
        assert_eq!(sup.snapshot().await.len(), 2);

        sup.shutdown_all().await;

        assert!(sup.snapshot().await.is_empty(), "shutdown_all 后注册表应排空");
        for pid in pids {
            assert!(
                wait_until(|| proc_dead(pid), KILL_TIMEOUT).await,
                "shutdown_all 后 pid {pid} 未在 {KILL_TIMEOUT:?} 内死亡"
            );
            assert!(
                wait_until(|| proc_reaped(pid), crate::acp::test_support::REAP_TIMEOUT).await,
                "shutdown_all 后 pid {pid} 未被回收（僵尸残留）"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
