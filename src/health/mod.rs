//! 引擎无关的 tmux server 健康模块（计划 P1-1 聋 server 检测/自愈 + P1-2 孤儿
//! 堆积监控；落点决策 ADR D4：**不解冻** `src/engine/tmux/` 冻结边界，探测/分类/
//! 统计/自愈全部在本模块）。
//!
//! - [`classify`]：四态分类纯函数（`Healthy / NoServer / Deaf / Other`）+ 签名常量；
//! - [`probe`]：健康探针（`tmux list-sessions` + socket 探针复核）；
//! - [`heal`]：内建自愈「重建 tmux server」（重探针 → 单飞 → inode 反查 →
//!   SIGKILL → 删 stale socket；ADR D3）；
//! - [`orphan`]：孤儿 `tmux -C` 堆积统计（P1-2 先兆指标）。
//!
//! # 累积结构 P1 三问（`docs/dev/performance-and-safety.md`）
//!
//! - **上限**：[`HealthState`] / [`HealthSnapshot`] 恒定大小（4 个固定字段，无
//!   Vec/String/map 累积）；唯一累积量「连续 Deaf 计数」以 [`CONSECUTIVE_DEAF_CAP`]
//!   命名常量封顶。orphan 统计每 tick 重建瞬态缓冲、不跨 tick 累积（见
//!   [`orphan::count_orphans`]）。
//! - **超限策略**：计数饱和（[`next_deaf_streak`]，不回绕——回绕会把「持续聋」
//!   误显示为 0 并跳过复告）。
//! - **守限单测**：`tests::deaf_streak_saturates_at_cap`。

pub mod classify;
pub mod heal;
pub mod orphan;
pub mod probe;

#[cfg(test)]
pub(crate) mod test_support;

use std::sync::{Arc, Mutex, OnceLock};

use chrono::{DateTime, Utc};
use tracing::{debug, info, warn};

use classify::ServerHealth;

/// 聋 server 周期探针间隔（P1-1 命名常量）。
pub const DEAF_PROBE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// 连续 Deaf 确认次数：达到即 `tracing::warn` 立哨（P1-1 命名常量）。
pub const DEAF_CONFIRM_COUNT: u32 = 3;

/// 孤儿堆积告警阈值：超过即 warn（P1-2 先兆指标，命名常量）。
pub const ORPHAN_WARN_THRESHOLD: u32 = 5;

/// 连续 Deaf 计数上限（P1 三问之「上限」）。计数只用于展示/告警判据，超过
/// [`DEAF_CONFIRM_COUNT`] 后数值无行为意义——封顶到 `u32` 满值（饱和策略见
/// [`next_deaf_streak`]，守限单测 `tests::deaf_streak_saturates_at_cap`）。
pub const CONSECUTIVE_DEAF_CAP: u32 = u32::MAX;

/// 健康快照（恒定大小，P1 三问答卷见模块文档）。
#[derive(Debug, Clone)]
pub struct HealthSnapshot {
    /// 最近一轮探针的四态。初始值 [`ServerHealth::Other`]（尚未探测：不触发
    /// 任何动作，首 tick 立即覆盖）。
    pub state: ServerHealth,
    /// 连续判聋次数（非 Deaf 即清零；饱和封顶 [`CONSECUTIVE_DEAF_CAP`]）。
    pub consecutive_deaf: u32,
    /// 最后一次判聋的时刻（RFC3339 输出；`null` = 从未判聋。恢复后**保留**——
    /// 它是「最近一次出事时间」的历史标记，进行中语义看 `consecutive_deaf`）。
    pub last_deaf_at: Option<DateTime<Utc>>,
    /// 最近一轮孤儿堆积数。
    pub orphan_count: u32,
}

impl Default for HealthSnapshot {
    fn default() -> Self {
        Self {
            state: ServerHealth::Other,
            consecutive_deaf: 0,
            last_deaf_at: None,
            orphan_count: 0,
        }
    }
}

/// 健康状态单例句柄（廉价克隆）：快照 + 自愈单飞锁。
pub struct HealthState {
    inner: Arc<Inner>,
}

struct Inner {
    snap: Mutex<HealthSnapshot>,
    /// 自愈单飞锁（heal 全程持锁；第二次触发立即 `in_progress`，见 [`heal`]）。
    heal_lock: tokio::sync::Mutex<()>,
}

impl Clone for HealthState {
    fn clone(&self) -> Self {
        Self { inner: Arc::clone(&self.inner) }
    }
}

impl HealthState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Inner {
                snap: Mutex::new(HealthSnapshot::default()),
                heal_lock: tokio::sync::Mutex::new(()),
            }),
        }
    }

    /// 当前快照。
    pub fn snapshot(&self) -> HealthSnapshot {
        self.inner.snap.lock().expect("健康状态锁中毒").clone()
    }

    /// 记录一轮探针结果并做阈值告警（返回更新后快照）。
    pub fn record(&self, health: ServerHealth, orphan_count: u32) -> HealthSnapshot {
        let mut snap = self.inner.snap.lock().expect("健康状态锁中毒");
        let prev_orphan = snap.orphan_count;
        snap.state = health;
        if health == ServerHealth::Deaf {
            snap.consecutive_deaf = next_deaf_streak(snap.consecutive_deaf);
            snap.last_deaf_at = Some(Utc::now());
            // 连续 DEAF_CONFIRM_COUNT 次 Deaf ⇒ 告警立哨；此后每 DEAF_CONFIRM_COUNT
            // 次复告一次（无人值守下持续聋不能只留一条告警沉进日志海）。
            if snap.consecutive_deaf.is_multiple_of(DEAF_CONFIRM_COUNT) {
                warn!(
                    stage = "monitor",
                    consecutive_deaf = snap.consecutive_deaf,
                    orphan_count,
                    "tmux server 连续 {} 次探针判聋（deaf server 半死态）：server_exit=1，所有新 tmux 命令会失败且无人值守下无限期持续；\
                     用 POST /api/v1/tmux/rebuild 重建 tmux server 自愈",
                    snap.consecutive_deaf
                );
            }
        } else {
            snap.consecutive_deaf = 0;
        }
        snap.orphan_count = orphan_count;
        // 孤儿堆积超阈值（且较上轮增长才复告，避免每 tick 刷屏）⇒ 先兆告警：
        // 堆积的孤儿控制客户端正是「一 SIGTERM 就假死」高危态的元凶（计划 §3.3/§3.4）。
        if orphan_count > ORPHAN_WARN_THRESHOLD && orphan_count > prev_orphan {
            warn!(
                stage = "monitor",
                orphan_count,
                threshold = ORPHAN_WARN_THRESHOLD,
                "tmux -C 孤儿客户端堆积超阈值（{} > {}）：tmux server 已进入「一 SIGTERM 就假死」高危态——\
                 停止 drain 的孤儿会把下一次 SIGTERM 后的 server 关闭流程冻结成聋 server（先兆指标，尽快清理）",
                orphan_count,
                ORPHAN_WARN_THRESHOLD
            );
        }
        snap.clone()
    }

    /// 自愈单飞锁（[`heal`] 全程持有）。
    pub fn heal_mutex(&self) -> &tokio::sync::Mutex<()> {
        &self.inner.heal_lock
    }
}

impl Default for HealthState {
    fn default() -> Self {
        Self::new()
    }
}

/// 连续 Deaf 计数推进（P1 三问之「超限策略」：到 [`CONSECUTIVE_DEAF_CAP`] 封顶
/// 保持、不回绕——回绕会把「持续聋」误显示为 0 并跳过复告）。
fn next_deaf_streak(prev: u32) -> u32 {
    if prev == CONSECUTIVE_DEAF_CAP { CONSECUTIVE_DEAF_CAP } else { prev.saturating_add(1) }
}

static GLOBAL: OnceLock<HealthState> = OnceLock::new();

/// 初始化进程级健康状态（`main.rs` `Start` 调用一次；风格同
/// `client_registry::init_global`）。
pub fn init_global() -> HealthState {
    let state = HealthState::new();
    let _ = GLOBAL.set(state.clone());
    state
}

/// 进程级健康状态（未初始化时 `None`）。
pub fn global() -> Option<HealthState> {
    GLOBAL.get().cloned()
}

/// 启动常驻健康监控周期任务（`main.rs` `Start` 调用一次）。未先
/// [`init_global`] 时自建默认单例，不 panic。
pub fn spawn_monitor() {
    let state = global().unwrap_or_else(init_global);
    info!(
        interval_secs = DEAF_PROBE_INTERVAL.as_secs(),
        confirm_count = DEAF_CONFIRM_COUNT,
        orphan_warn_threshold = ORPHAN_WARN_THRESHOLD,
        "启动 tmux server 健康监控（聋 server 检测 + 孤儿堆积先兆；docs/dev/plans/2026-09-22-tmux-server-shutdown-hang.md P1-1/P1-2）"
    );
    tokio::spawn(async move {
        loop {
            monitor_tick(&state).await;
            tokio::time::sleep(DEAF_PROBE_INTERVAL).await;
        }
    });
}

async fn monitor_tick(state: &HealthState) {
    let probe = probe::probe().await;
    let orphans = orphan::count_orphans();
    debug!(
        stage = "monitor",
        health = %probe.health,
        success = ?probe.command.as_ref().map(|c| c.success),
        exit_code = ?probe.command.as_ref().and_then(|c| c.exit_code),
        stdout = ?probe.command.as_ref().map(|c| c.stdout.as_str()),
        stderr = ?probe.command.as_ref().map(|c| c.stderr.as_str()),
        socket = ?probe.socket,
        orphan_count = orphans.total,
        tracked = orphans.tracked,
        untracked = orphans.untracked,
        scan_degraded = orphans.scan_degraded,
        "tmux 健康巡检"
    );
    state.record(probe.health, orphans.total);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 连续 Deaf 计数到确认阈值、非 Deaf 清零；last_deaf_at 记录且恢复后保留。
    #[test]
    fn deaf_streak_counts_to_threshold_and_resets() {
        let state = HealthState::new();
        let snap = state.snapshot();
        assert_eq!(snap.consecutive_deaf, 0);
        assert!(snap.last_deaf_at.is_none(), "初始未判聋");
        assert_eq!(snap.state, ServerHealth::Other, "未探测初始值不触发任何动作");

        for i in 1..=DEAF_CONFIRM_COUNT {
            let snap = state.record(ServerHealth::Deaf, 0);
            assert_eq!(snap.consecutive_deaf, i);
        }
        assert!(state.snapshot().last_deaf_at.is_some(), "判聋须留时间戳");

        let before = state.snapshot().last_deaf_at;
        let snap = state.record(ServerHealth::Healthy, 0);
        assert_eq!(snap.consecutive_deaf, 0, "非 Deaf 清零");
        assert_eq!(snap.last_deaf_at, before, "last_deaf_at 是历史标记，恢复后保留");
        assert_eq!(snap.state, ServerHealth::Healthy);
    }

    /// P1 三问之「守限单测」：超上限输入下计数恰为上限（饱和不回绕）。
    #[test]
    fn deaf_streak_saturates_at_cap() {
        assert_eq!(next_deaf_streak(0), 1);
        assert_eq!(
            next_deaf_streak(CONSECUTIVE_DEAF_CAP),
            CONSECUTIVE_DEAF_CAP,
            "超限策略 = 饱和，不回绕"
        );
    }

    /// orphan_count 快照更新（告警行为由 warn 日志承载，这里守住状态位）。
    #[test]
    fn record_updates_orphan_count() {
        let state = HealthState::new();
        let snap = state.record(ServerHealth::NoServer, ORPHAN_WARN_THRESHOLD + 3);
        assert_eq!(snap.orphan_count, ORPHAN_WARN_THRESHOLD + 3);
        assert_eq!(snap.state, ServerHealth::NoServer);
    }
}
