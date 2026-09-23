//! 孤儿 `tmux -C` 控制客户端堆积统计（P1-2，引擎无关）。
//!
//! # 背景（计划 §3.4）
//!
//! omniterm 崩溃路径不收尸，孤儿控制客户端「停止 drain 又不退出」，堆积到一定
//! 数量后，任何一次对 tmux server 的 SIGTERM 都会把关闭流程冻结成聋 server——
//! 孤儿堆积是 tmux server 进入「一 SIGTERM 就假死」高危态的**先兆指标**。
//!
//! # 谓词（与登记表共享真源，工程准则 7①）
//!
//! - **已登记条目**（`client_registry::is_orphaned_tracked_client`）：argv 结构化
//!   前缀 `["tmux","-C"]` ∧ 当前 ppid ≠ spawn_ppid ∧ start_key 未变；
//! - **未登记进程**（[`is_untracked_orphan`]）：argv 结构化前缀 ∧ **ppid == 1 近似**。
//!   盲区如实注明：孤儿也可能被 subreaper 收养（ppid ≠ 1），而未登记条目没有
//!   spawn_ppid 可比对，这类孤儿会被**漏计**（已登记条目走 ppid ≠ spawn_ppid
//!   判据，无此盲区）。近似判据不会误计（假阳性）——只可能少计，监控语义可接受。
//!
//! # 实施偏差（实测结论，2026-09-22，kernel 7.0，如实记录）
//!
//! 计划原文还要求「socket 归属本机 tmux server 反查」（`/proc/<pid>/fd` →
//! `socket:[inode]` 与 server 监听 socket 配对）来限定统计范围，**实测不可实现**：
//! `/proc/net/unix` 里已连接 socket 的**客户端侧条目没有 Path 字段**（只有 server
//! 侧 accept 出的 socket 带路径），客户端↔server 无法从 /proc 配对。故按 argv
//! 谓词实现（统计范围 = 本机全部 `tmux -C` 客户端）。
//!
//! # 平台差异（工程准则 8）
//!
//! 未登记进程扫描依赖 `/proc`：**仅 Linux 完整**；macOS/Windows 降级为仅统计
//! 已登记条目（`scan_degraded = true` + WARN 一次性），不静默假装成功。

use crate::engine::tmux::client_registry::{
    ClientEntry, TMUX_CONTROL_ARGV_PREFIX, is_orphaned_tracked_client,
};
use crate::process_identity::{ProcessIdentity, argv_has_prefix, process_identity};
use tracing::warn;

/// 孤儿堆积计数（恒定大小，无累积结构——P1 三问见 [`count_orphans`]）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrphanCount {
    /// tracked + untracked。
    pub total: u32,
    /// 已登记条目里满足孤儿谓词的数量。
    pub tracked: u32,
    /// 未登记进程里满足近似谓词的数量（与 tracked 按 pid 去重）。
    pub untracked: u32,
    /// true = 平台降级（无 /proc）：未登记扫描不可用，total 只含已登记条目。
    pub scan_degraded: bool,
}

/// 未登记 `tmux -C` 孤儿谓词（近似，盲区见模块文档）：argv 结构化前缀 ∧
/// ppid == 1。
pub fn is_untracked_orphan(ident: &ProcessIdentity) -> bool {
    argv_has_prefix(&ident.argv, TMUX_CONTROL_ARGV_PREFIX) && ident.ppid == 1
}

/// 周期统计入口（`health` 监控每 [`super::DEAF_PROBE_INTERVAL`] 调一次）。
///
/// P1 三问：
/// - **上限**：本函数无跨 tick 累积结构（[`HealthSnapshot`](super::HealthSnapshot)
///   恒定大小）；瞬态 `Vec` 是每 tick 重建的工作缓冲、不跨 tick 增长，条目数受
///   OS 进程表约束；计数 `saturating_add` 不回绕。
/// - **超限策略**：计数饱和（`u32` 封顶）；瞬态缓冲不设限（重建型，非累积型）。
/// - **守限单测**：`tests::count_orphans_from_dedups_and_applies_predicates` 断言
///   计数/去重边界；饱和语义由 `saturating_add` 自证。
pub fn count_orphans() -> OrphanCount {
    let entries = crate::engine::tmux::client_registry::global()
        .map(|registry| registry.entries())
        .unwrap_or_default();
    let tracked: Vec<(ClientEntry, ProcessIdentity)> = entries
        .into_iter()
        .filter_map(|entry| process_identity(entry.pid).map(|ident| (entry, ident)))
        .collect();
    let (candidates, scan_degraded) = scan_tmux_control_clients();
    count_orphans_from(&tracked, &candidates, scan_degraded)
}

/// 纯计数（单测入口）：登记条目走 [`is_orphaned_tracked_client`]，其余走
/// [`is_untracked_orphan`]；登记条目 pid 已覆盖的候选**按 pid 去重**不重复计。
pub fn count_orphans_from(
    tracked: &[(ClientEntry, ProcessIdentity)],
    candidates: &[ProcessIdentity],
    scan_degraded: bool,
) -> OrphanCount {
    let mut tracked_orphans = 0u32;
    for (entry, ident) in tracked {
        if is_orphaned_tracked_client(ident, entry) {
            tracked_orphans = tracked_orphans.saturating_add(1);
        }
    }
    let mut untracked_orphans = 0u32;
    for ident in candidates {
        let covered = tracked.iter().any(|(entry, _)| entry.pid == ident.pid);
        if !covered && is_untracked_orphan(ident) {
            untracked_orphans = untracked_orphans.saturating_add(1);
        }
    }
    OrphanCount {
        total: tracked_orphans.saturating_add(untracked_orphans),
        tracked: tracked_orphans,
        untracked: untracked_orphans,
        scan_degraded,
    }
}

/// 扫描本机 argv 结构化前缀为 `["tmux","-C"]` 的进程（登记与否都进候选，
/// 去重在 [`count_orphans_from`]）。
#[cfg(target_os = "linux")]
fn scan_tmux_control_clients() -> (Vec<ProcessIdentity>, bool) {
    let Ok(proc_dir) = std::fs::read_dir("/proc") else {
        warn!("读 /proc 失败：未登记 tmux -C 孤儿扫描降级（不静默假装成功）");
        return (Vec::new(), true);
    };
    let mut found = Vec::new();
    for dirent in proc_dir.flatten() {
        let Ok(pid) = dirent.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        if let Some(ident) = process_identity(pid)
            && argv_has_prefix(&ident.argv, TMUX_CONTROL_ARGV_PREFIX)
        {
            found.push(ident);
        }
    }
    (found, false)
}

/// 非 Linux（macOS/Windows）无 `/proc`：未登记扫描不可用 ⇒ 明确降级 + WARN
/// （一次性，避免每 30s 巡检刷屏），仅统计已登记条目（模块文档平台差异）。
#[cfg(not(target_os = "linux"))]
fn scan_tmux_control_clients() -> (Vec<ProcessIdentity>, bool) {
    static WARN_ONCE: std::sync::Once = std::sync::Once::new();
    WARN_ONCE.call_once(|| {
        warn!("非 Linux 平台无 /proc，未登记 tmux -C 孤儿扫描不可用：降级为仅统计已登记条目（孤儿总数偏低）");
    });
    (Vec::new(), true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::test_support::{spawn_fake_tmux_control, wait_argv0};

    fn ident(argv: &[&str], pid: u32, ppid: u32) -> ProcessIdentity {
        ProcessIdentity {
            pid,
            ppid,
            start_key: format!("k{pid}"),
            argv: argv.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// 未登记谓词：argv 结构化前缀 ∧ ppid == 1（盲区：subreaper 收养的孤儿漏计，
    /// 如实注明在断言里）。
    #[test]
    fn untracked_predicate_needs_argv_prefix_and_ppid_one() {
        assert!(is_untracked_orphan(&ident(&["tmux", "-C", "attach-session"], 42, 1)));
        assert!(
            !is_untracked_orphan(&ident(&["tmux", "-C", "attach-session"], 42, 2345)),
            "盲区如实注明：subreaper 收养（ppid ≠ 1）的未登记孤儿被漏计"
        );
        assert!(!is_untracked_orphan(&ident(&["vim", "tmux -C.md"], 42, 1)), "结构化前缀拒子串");
        assert!(
            !is_untracked_orphan(&ident(&["echo", "tmux", "-C"], 42, 1)),
            "argv[0] 不等不得命中"
        );
        assert!(!is_untracked_orphan(&ident(&["tmux", "ls"], 42, 1)));
    }

    /// 纯计数：已登记孤儿 / 活跃客户端 / 未登记孤儿三类判定 + pid 去重 + 降级位。
    #[test]
    fn count_orphans_from_dedups_and_applies_predicates() {
        // 已登记孤儿：spawn_ppid=100，当前 ppid=1（被收养），start_key 未变。
        let tracked_orphan = ClientEntry::new(10, 100, "k10".into(), "lt_a");
        // 活跃客户端：ppid 未变（= spawn_ppid），不得计。
        let live_client = ClientEntry::new(11, 500, "k11".into(), "lt_b");
        // PID 复用嫌疑：start_key 已变，不得计（is_orphaned_tracked_client 三条件）。
        let reused = ClientEntry::new(12, 100, "STALE".into(), "lt_c");
        let tracked = [
            (tracked_orphan, ident(&["tmux", "-C"], 10, 1)),
            (live_client, ident(&["tmux", "-C"], 11, 500)),
            (reused, ident(&["tmux", "-C"], 12, 1)),
        ];
        // 候选：pid 10 已被登记覆盖（不得重复计）+ 一个未登记孤儿 + 一个非孤儿。
        let candidates = [
            ident(&["tmux", "-C"], 10, 1),
            ident(&["tmux", "-C"], 20, 1),
            ident(&["tmux", "-C"], 21, 900),
        ];
        let count = count_orphans_from(&tracked, &candidates, true);
        assert_eq!(count.tracked, 1);
        assert_eq!(count.untracked, 1, "登记条目覆盖的 pid 不得重复计");
        assert_eq!(count.total, 2);
        assert!(count.scan_degraded);
    }

    /// Linux 实扫：假 `tmux -C` 进程（bash 保 argv 形状的假进程技巧）按 argv
    /// 结构化前缀被扫到。
    #[cfg(target_os = "linux")]
    #[test]
    fn scan_finds_fake_control_client_by_argv() {
        let mut child = spawn_fake_tmux_control(60);
        let pid = child.id();
        wait_argv0(pid, "tmux"); // 等 execv 换影完成（spawn 返回 ≠ argv 就位）

        let (found, degraded) = scan_tmux_control_clients();
        assert!(!degraded, "Linux 不应降级");
        assert!(
            found
                .iter()
                .any(|i| i.pid == pid && argv_has_prefix(&i.argv, TMUX_CONTROL_ARGV_PREFIX)),
            "扫描应按 argv 结构化前缀找到假 tmux -C 客户端"
        );

        let _ = child.kill();
        let _ = child.wait();
    }
}
