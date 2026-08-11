//! 全局 agent 屏幕检测轮询器（引擎无关）。
//!
//! 单个后台任务按 [`TICK_INTERVAL`] 轮询所有引擎的活动会话：
//! 1. 经 [`EngineRegistry::watch_targets`] 枚举活动目标
//!    （pid/活动时间戳/标题，枚举源由各引擎提供）
//! 2. 前台进程识别 agent 种类（`process::foreground_pid` + cmdline 匹配，
//!    回退进程树扫描）——无 agent 的会话不做屏幕扫描
//! 3. 经 [`EngineRegistry::capture_screen`] 取可见屏 → [`detect::evaluate`]
//!    → [`Debounce`] 防抖
//! 4. 结果存内存 map，由 `api::sessions::list_sessions` 回填到会话响应
//!    （前端沿用既有 3s 轮询通道，无新增推送通道）
//!
//! 跳扫描优化：活动戳未变且已发布 Idle 时跳过 capture（herdr 内容序号
//! 优化的等价物）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::RwLock;
use tracing::debug;

use crate::agent::detect::{self, Debounce};
use crate::agent::process;
use crate::agent::state::{AgentKind, AgentState};
use crate::engine::EngineRegistry;

/// 轮询间隔。herdr 用 300ms（进程内读屏）；OmniTerm 走子进程读屏，1s 够用
/// （前端消费端本身是 3s 轮询）。
pub const TICK_INTERVAL: Duration = Duration::from_secs(1);

/// 屏幕检测得到的单会话 agent 状态。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScreenAgent {
    pub kind: AgentKind,
    pub state: AgentState,
}

struct Entry {
    kind: AgentKind,
    debounce: Debounce,
    last_activity: String,
}

/// 检测结果注册表。Clone 共享同一底层 map。
#[derive(Clone, Default)]
pub struct AgentWatcher {
    inner: Arc<RwLock<HashMap<String, Entry>>>,
}

impl AgentWatcher {
    /// 当前所有被检测会话的 (会话名 → agent 状态) 快照。
    pub async fn snapshot(&self) -> HashMap<String, ScreenAgent> {
        self.inner
            .read()
            .await
            .iter()
            .map(|(name, e)| {
                (name.clone(), ScreenAgent { kind: e.kind, state: e.debounce.published() })
            })
            .collect()
    }
}

/// 启动全局检测循环（main.rs 调用一次）。
pub fn spawn(watcher: AgentWatcher, engines: EngineRegistry) {
    tokio::spawn(async move {
        loop {
            tick(&watcher, &engines).await;
            tokio::time::sleep(TICK_INTERVAL).await;
        }
    });
}

/// 识别 pane 里前台运行的 agent：优先前台进程组（tpgid），回退子进程树。
fn identify_agent(pane_pid: u32) -> Option<AgentKind> {
    if let Some(kind) = process::foreground_pid(pane_pid).and_then(process::read_process_cmdline) {
        return Some(kind);
    }
    process::walk_process_tree(pane_pid)
}

async fn tick(watcher: &AgentWatcher, engines: &EngineRegistry) {
    let targets = engines.watch_targets().await;
    if targets.is_empty() && watcher.inner.read().await.is_empty() {
        return;
    }

    // 取上一轮状态的克隆，新 map 构建完成后整体替换——期间读者始终看到完整快照
    let mut old: HashMap<String, Entry> = watcher
        .inner
        .read()
        .await
        .iter()
        .map(|(name, e)| {
            (
                name.clone(),
                Entry {
                    kind: e.kind,
                    debounce: e.debounce.clone(),
                    last_activity: e.last_activity.clone(),
                },
            )
        })
        .collect();
    let mut new_map: HashMap<String, Entry> = HashMap::new();

    for target in targets {
        let Some(kind) = identify_agent(target.pane_pid) else { continue };

        let prev = old.remove(&target.session).filter(|e| e.kind == kind);

        // 跳扫描：窗口无新输出 + 已发布 Idle → 状态不可能变化，省一次 capture
        if let Some(prev_entry) = prev {
            if prev_entry.last_activity == target.activity
                && prev_entry.debounce.published() == AgentState::Idle
            {
                new_map.insert(target.session, prev_entry);
                continue;
            }
            old.insert(target.session.clone(), prev_entry);
        }
        let prev = old.remove(&target.session);

        let screen = match engines.capture_screen(target.kind, &target.session).await {
            Ok(s) => s,
            Err(_) => continue, // 会话可能刚被 kill；下个 tick 自然收敛
        };

        let detection = detect::evaluate(kind, &screen, &target.title);
        let mut debounce = prev.map(|e| e.debounce).unwrap_or_default();
        let published = debounce.advance(&detection);
        debug!(
            "agent_watch: {} kind={} rule={} raw={:?} published={}",
            target.session,
            kind.as_str(),
            detection.rule_id,
            detection.state,
            published.as_str()
        );

        new_map.insert(target.session, Entry { kind, debounce, last_activity: target.activity });
    }

    *watcher.inner.write().await = new_map;
}
