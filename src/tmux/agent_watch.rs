//! 全局 agent 屏幕检测轮询器。
//!
//! 单个后台任务按 [`TICK_INTERVAL`] 轮询所有 tmux 会话：
//! 1. 一次 `tmux list-panes -a` 拿到全部会话的活动 pane（pid/活动时间戳/标题）
//! 2. 前台进程识别 agent 种类（`process_info::foreground_pid` + cmdline 匹配，
//!    回退进程树扫描）——无 agent 的会话不做屏幕扫描
//! 3. `capture-pane` 取可见屏 → [`agent_detect::evaluate`] → [`Debounce`] 防抖
//! 4. 结果存内存 map，由 `api::sessions::list_sessions` 回填到会话响应
//!    （前端沿用既有 3s 轮询通道，无新增推送通道）
//!
//! 跳扫描优化：`#{window_activity}` 未变且已发布 Idle 时跳过 capture
//! （herdr 内容序号优化的 tmux 等价物）。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::RwLock;
use tracing::debug;

use crate::tmux::agent_detect::{self, Debounce};
use crate::tmux::agent_state::{AgentKind, AgentState};
use crate::tmux::process_info;

/// 轮询间隔。herdr 用 300ms（进程内读屏）；OmniTerm 走 tmux 子进程，1s 够用
/// （前端消费端本身是 3s 轮询）。
pub const TICK_INTERVAL: Duration = Duration::from_secs(1);

/// tmux -F 字段分隔符。不能用控制字符（tmux 会把格式串里的非打印字节
/// 八进制转义为字面 `\037` 输出）；':' 安全：tmux 会话名禁止含 ':'（
/// session_check_name 会替换为 '_'），中间字段均为数字，自由文本的
/// pane_title 放最后由 splitn 整体保留。
const FIELD_SEP: char = ':';

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
    /// 当前所有被检测会话的 (tmux 会话名 → agent 状态) 快照。
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
pub fn spawn(watcher: AgentWatcher) {
    tokio::spawn(async move {
        loop {
            tick(&watcher).await;
            tokio::time::sleep(TICK_INTERVAL).await;
        }
    });
}

struct PaneInfo {
    session: String,
    pane_pid: u32,
    activity: String,
    title: String,
}

async fn list_active_panes() -> Vec<PaneInfo> {
    let format = format!(
        "#{{session_name}}{s}#{{window_active}}{s}#{{pane_active}}{s}#{{pane_pid}}{s}#{{window_activity}}{s}#{{pane_title}}",
        s = FIELD_SEP
    );
    let output = match Command::new("tmux").args(["list-panes", "-a", "-F", &format]).output().await
    {
        Ok(o) if o.status.success() => o,
        _ => return vec![],
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(6, FIELD_SEP).collect();
            if parts.len() < 6 || parts[1] != "1" || parts[2] != "1" {
                return None;
            }
            Some(PaneInfo {
                session: parts[0].to_string(),
                pane_pid: parts[3].parse().ok()?,
                activity: parts[4].to_string(),
                title: parts[5].to_string(),
            })
        })
        .collect()
}

/// 识别 pane 里前台运行的 agent：优先前台进程组（tpgid），回退子进程树。
fn identify_agent(pane_pid: u32) -> Option<AgentKind> {
    if let Some(kind) =
        process_info::foreground_pid(pane_pid).and_then(process_info::read_process_cmdline)
    {
        return Some(kind);
    }
    process_info::walk_process_tree(pane_pid)
}

async fn tick(watcher: &AgentWatcher) {
    let panes = list_active_panes().await;
    if panes.is_empty() && watcher.inner.read().await.is_empty() {
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

    for pane in panes {
        let Some(kind) = identify_agent(pane.pane_pid) else { continue };

        let prev = old.remove(&pane.session).filter(|e| e.kind == kind);

        // 跳扫描：窗口无新输出 + 已发布 Idle → 状态不可能变化，省一次 capture
        if let Some(prev_entry) = prev {
            if prev_entry.last_activity == pane.activity
                && prev_entry.debounce.published() == AgentState::Idle
            {
                new_map.insert(pane.session, prev_entry);
                continue;
            }
            old.insert(pane.session.clone(), prev_entry);
        }
        let prev = old.remove(&pane.session);

        let screen = match crate::tmux::capture_screen(&pane.session).await {
            Ok(s) => s,
            Err(_) => continue, // 会话可能刚被 kill；下个 tick 自然收敛
        };

        let detection = agent_detect::evaluate(kind, &screen, &pane.title);
        let mut debounce = prev.map(|e| e.debounce).unwrap_or_default();
        let published = debounce.advance(&detection);
        debug!(
            "agent_watch: {} kind={} rule={} raw={:?} published={}",
            pane.session,
            kind.as_str(),
            detection.rule_id,
            detection.state,
            published.as_str()
        );

        new_map.insert(pane.session, Entry { kind, debounce, last_activity: pane.activity });
    }

    *watcher.inner.write().await = new_map;
}
