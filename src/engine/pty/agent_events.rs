//! pty hook 信道状态库（计划 D7）：会话专属 token 注册表、hook 上报 KV、
//! watch 变更门铃。HTTP 端点见 `crate::api::agent_events`，hook 命令模板见
//! [`super::agent_hooks`]。
//!
//! 仲裁（HookAuthority）：hook 存活（最近一次上报在 [`HOOK_ALIVE_WINDOW`]
//! 内）时为状态权威，屏幕检测降级 fallback——读口收敛在
//! `PtyEngine::agent_snapshot`（过期返回 `None`）。tmux 会话沿用
//! `@omniterm_agent` option 信道（冻结不改）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::watch;
use tracing::warn;
use uuid::Uuid;

use crate::agent::state::AgentSnapshot;

/// hook 存活判定窗口：最近一次上报在此窗口内时 hook 为状态权威，
/// 否则 `agent_snapshot` 返回 `None`、由屏幕检测接管（fallback）。
/// 生命周期 hook 事件流不完整（见 backend.md「Agent 屏幕状态检测」），
/// 窗口取短，过期状态尽快交还给屏幕真相。
pub const HOOK_ALIVE_WINDOW: Duration = Duration::from_secs(60);

/// 单条上报 body 上限（`kind:state:reason:event:nonce` 远小于此，P4 入口防线）。
pub const MAX_HOOK_BODY_BYTES: usize = 1024;

/// KV/ token 表条目上限（P1 有界）：正常规模 = 存活 pty 会话数（注销即清理），
/// 上限只兜异常残留；超限按接收时间淘汰最旧。
pub const MAX_HOOK_ENTRIES: usize = 256;

/// 一条 hook 上报的落地记录。
#[derive(Debug, Clone)]
pub struct HookEntry {
    pub snapshot: AgentSnapshot,
    pub received_at: Instant,
}

struct Inner {
    /// 会话专属 token → 引擎会话键。
    by_token: Mutex<HashMap<String, String>>,
    /// 引擎会话键 → 最近一次上报。
    entries: Mutex<HashMap<String, HookEntry>>,
    /// 变更门铃（单调递增计数）：WS 订阅者被唤醒后回读 KV 取自己会话的最新值，
    /// 门铃本身不携带状态，跨会话覆盖不影响正确性。
    doorbell: watch::Sender<u64>,
}

/// hook 信道状态库。Clone 共享同一份状态。
#[derive(Clone)]
pub struct AgentEventStore {
    inner: Arc<Inner>,
}

impl AgentEventStore {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                by_token: Mutex::new(HashMap::new()),
                entries: Mutex::new(HashMap::new()),
                doorbell: watch::channel(0).0,
            }),
        }
    }

    /// 为会话注册专属 token（spawn 时调用；env 注入 `OMNITERM_HOOK_URL` 用）。
    /// 同名会话重建时先清旧 token，保证表规模 = 存活会话数（P1）。
    pub fn register(&self, key: &str) -> String {
        let token = Uuid::new_v4().simple().to_string();
        let mut by_token = self.inner.by_token.lock().unwrap();
        by_token.retain(|_, k| k != key);
        by_token.insert(token.clone(), key.to_string());
        token
    }

    /// 会话注销/kill 时清理 token 与上报记录（幂等）。
    pub fn unregister(&self, key: &str) {
        self.inner.entries.lock().unwrap().remove(key);
        self.inner.by_token.lock().unwrap().retain(|_, k| k != key);
    }

    /// token → 会话键（HTTP 端点鉴权用）。
    pub fn key_for_token(&self, token: &str) -> Option<String> {
        self.inner.by_token.lock().unwrap().get(token).cloned()
    }

    /// 落一条上报。按 source 幂等去重：nonce 与会话最近一次相同视为重放，
    /// 丢弃（返回 `false`）。超限按接收时间淘汰最旧（P1）。
    pub fn record(&self, key: &str, snapshot: AgentSnapshot) -> bool {
        let mut entries = self.inner.entries.lock().unwrap();
        if entries
            .get(key)
            .is_some_and(|e| e.snapshot.agent_nonce.as_deref() == snapshot.agent_nonce.as_deref())
        {
            return false;
        }
        if entries.len() >= MAX_HOOK_ENTRIES
            && let Some(oldest) =
                entries.iter().min_by_key(|(_, e)| e.received_at).map(|(k, _)| k.clone())
        {
            warn!("agent hook store full ({}), evicting oldest: {oldest}", entries.len());
            entries.remove(&oldest);
        }
        entries.insert(key.to_string(), HookEntry { snapshot, received_at: Instant::now() });
        drop(entries);
        self.inner.doorbell.send_modify(|c| *c += 1);
        true
    }

    /// 最近一次上报（不论新鲜度；新鲜度判定见 [`Self::fresh_snapshot`]）。
    pub fn snapshot(&self, key: &str) -> Option<HookEntry> {
        self.inner.entries.lock().unwrap().get(key).cloned()
    }

    /// hook 存活时的权威快照（HookAuthority 读口）；过期返回 `None`。
    pub fn fresh_snapshot(&self, key: &str) -> Option<AgentSnapshot> {
        self.snapshot(key)
            .filter(|e| e.received_at.elapsed() < HOOK_ALIVE_WINDOW)
            .map(|e| e.snapshot)
    }

    /// 订阅变更门铃（WS 推送用）。
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.inner.doorbell.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::state::{AgentKind, AgentState};

    fn snap(event: &str, nonce: &str) -> AgentSnapshot {
        AgentSnapshot {
            agent_kind: AgentKind::Claude,
            agent_state: AgentState::Running,
            attention_reason: None,
            agent_event: Some(event.to_string()),
            agent_nonce: Some(nonce.to_string()),
        }
    }

    #[test]
    fn record_and_read_back() {
        let store = AgentEventStore::new();
        let token = store.register("s1");
        assert_eq!(store.key_for_token(&token).as_deref(), Some("s1"));
        assert!(store.record("s1", snap("PreToolUse", "1.1")));
        let entry = store.snapshot("s1").expect("entry");
        assert_eq!(entry.snapshot.agent_event.as_deref(), Some("PreToolUse"));
        assert!(store.fresh_snapshot("s1").is_some());
    }

    #[test]
    fn duplicate_nonce_is_dropped() {
        let store = AgentEventStore::new();
        store.register("s1");
        assert!(store.record("s1", snap("PreToolUse", "1.1")));
        assert!(!store.record("s1", snap("PostToolUse", "1.1")));
        // nonce 未前进 → 仍是旧事件
        assert_eq!(
            store.snapshot("s1").unwrap().snapshot.agent_event.as_deref(),
            Some("PreToolUse")
        );
        assert!(store.record("s1", snap("PostToolUse", "1.2")));
        assert_eq!(
            store.snapshot("s1").unwrap().snapshot.agent_event.as_deref(),
            Some("PostToolUse")
        );
    }

    #[test]
    fn unregister_clears_token_and_entry() {
        let store = AgentEventStore::new();
        let token = store.register("s1");
        store.record("s1", snap("Stop", "2.1"));
        store.unregister("s1");
        assert!(store.key_for_token(&token).is_none());
        assert!(store.snapshot("s1").is_none());
    }

    #[test]
    fn capacity_bound_evicts_oldest() {
        let store = AgentEventStore::new();
        for i in 0..MAX_HOOK_ENTRIES {
            store.register(&format!("s{i}"));
            store.record(&format!("s{i}"), snap("PreToolUse", &format!("{i}.1")));
            // 拉开 received_at 顺序（Instant 精度内可分辨）
            std::thread::sleep(Duration::from_micros(50));
        }
        assert_eq!(store.inner.entries.lock().unwrap().len(), MAX_HOOK_ENTRIES);
        // 再多一条 → 总量仍为上限，最旧（s0）被淘汰
        store.register("overflow");
        store.record("overflow", snap("PreToolUse", "999.1"));
        let entries = store.inner.entries.lock().unwrap();
        assert_eq!(entries.len(), MAX_HOOK_ENTRIES);
        assert!(entries.contains_key("overflow"));
        assert!(!entries.contains_key("s0"));
    }

    #[test]
    fn doorbell_notifies_subscribers() {
        let store = AgentEventStore::new();
        let rx = store.subscribe();
        store.register("s1");
        store.record("s1", snap("Stop", "3.1"));
        rx.has_changed().expect("doorbell should have fired");
    }
}
