//! `tmux -C` 控制客户端登记表 + 启动对账（P0-2，
//! `docs/dev/plans/2026-09-22-tmux-server-shutdown-hang.md`）。
//!
//! # 背景
//!
//! omniterm 崩溃（panic-abort / SIGKILL / OOM）时 `ControlModeClient::stop()` /
//! `Drop` 的清理不执行，`tmux -C attach-session` 子进程被 init 收养成孤儿；
//! 孤儿控制客户端停止 drain 又不退出，任何一次对 tmux server 的 SIGTERM 都会
//! 把关闭流程冻结成「聋 server」（事故实录见计划 §3.3/§3.4）。本模块把每个
//! 控制客户端的身份登记到 `~/.omniterm/<实例>-<pid>.clients`（tmp+rename 原子
//! 写），启动时扫描**全部**登记文件对账杀掉残留孤儿（载体决策见计划 D2：DB
//! 按 `--db` 实例隔离，覆盖不到跨实例残留）。
//!
//! # kill 谓词（与 `crate::process_identity` 共享真源，AGENTS 工程准则 7①）
//!
//! 只杀同时满足以下三条的登记进程（[`is_orphaned_tracked_client`]）：
//! 1. argv **结构化相等** `argv[0..2] == ["tmux", "-C"]`（拒绝子串匹配）；
//! 2. 当前 ppid **≠ spawn_ppid**（孤儿判据——不用「PPID=1」：孤儿可能被
//!    subreaper 收养）；
//! 3. start_key 未变（PID 复用检测；变了 ⇒ 不是当年那个进程，**跳过不误杀**）。
//!
//! kill 通道 [`crate::process_identity::kill_pid`]：Linux 走 pidfd（内核级免疫
//! PID 复用，收口 check-then-kill 的 TOCTOU）。
//!
//! # 登记表上限（`docs/dev/performance-and-safety.md` §P1 三问）
//!
//! - **上限**：[`MAX_TRACKED_CLIENTS`] = 256 条。单条大小由
//!   [`MAX_SESSION_BYTES`]（255 字节，UTF-8 边界截断）封顶 ⇒ 文件总量 ≤
//!   256 × ~320B ≈ 80KB 有界（「N × 单条最大」可算得出）。
//! - **超限策略**：先清已死条目（pid 不存活），仍超限则**拒登新 spawn** 并
//!   `tracing::warn` 降级——父死兜底是 P0-1（PDEATHSIG），登记缺失不构成泄漏。
//! - **守限单测**：`tests` 模块 `registry_cap_rejects_overflow_after_pruning_dead`。
//!
//! # 增删对称性
//!
//! 登记挂 spawn，注销挂**两条**路径：reap 任务观测到子进程退出（覆盖自然死亡 /
//! Drop 强杀，不依赖谁调用 `stop()`）+ `stop()` 收尾（覆盖 ensure_session 死连接
//! 重建的替换路径）。两条都按 pid 幂等删除，实例内死条目不会滞留累积。
//! 进程级退出的注销挂显式 shutdown 路径（`main.rs` 优雅退出删自己的文件）；
//! 就算漏删，启动对账天然幂等、可重复收敛（计划 P0-2）。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::process_identity::{ProcessIdentity, argv_has_prefix, process_identity};

/// 登记表条目上限（见模块文档「登记表上限」三问）。
pub const MAX_TRACKED_CLIENTS: usize = 256;

/// session 名登记时的字节上限（UTF-8 边界安全截断）——单条最大尺寸的封顶来源。
pub const MAX_SESSION_BYTES: usize = 255;

/// 孤儿登记文件回收的最小年龄（秒）。文件内容自带 `born_at`，不依赖 mtime。
/// 「超期」判据：内容已空 ∧ 文件头里的实例 pid 已死 ∧ 存活 ≥ 本阈值。
pub const ORPHAN_FILE_MIN_AGE_SECS: u64 = 300;

/// tmux 控制客户端的结构化 argv 前缀（结构化相等，见 [`argv_has_prefix`]）。
pub const TMUX_CONTROL_ARGV_PREFIX: &[&str] = &["tmux", "-C"];

/// 一条登记：控制客户端的身份三元组 + 目标 session（计划 P0-2 登记内容）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientEntry {
    pub pid: u32,
    /// spawn 时的父进程 pid（= 实例 pid）。当前 ppid ≠ 它 ⇒ 孤儿。
    pub spawn_ppid: u32,
    /// 启动时刻标识（PID 复用检测，见 `crate::process_identity`）。
    pub start_key: String,
    /// 目标 tmux session 名（诊断用；写入前按 [`MAX_SESSION_BYTES`] 截断）。
    pub session: String,
}

impl ClientEntry {
    pub fn new(pid: u32, spawn_ppid: u32, start_key: String, session: &str) -> Self {
        Self { pid, spawn_ppid, start_key, session: truncate_utf8(session, MAX_SESSION_BYTES) }
    }
}

/// UTF-8 边界安全截断（切在多字节字符中间会 panic——按 floor 边界切，见
/// `performance-and-safety.md` §P1 截断硬要求）。
fn truncate_utf8(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// 登记文件内容（v1）。`born_at` 供孤儿文件「超期回收」判据使用（文件被
/// tmp+rename 整体重写，born_at 首次创建时固定）。
#[derive(Debug, Serialize, Deserialize)]
struct RegistryFile {
    v: u32,
    born_at: u64,
    entries: Vec<ClientEntry>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 登记结果。超限拒登 = [`RegisterOutcome::RefusedFull`]（调用方 WARN 降级）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterOutcome {
    Registered,
    RefusedFull,
}

/// 单个实例的登记表句柄（廉价克隆）。进程级单例经 [`init_global`] / [`global`]。
#[derive(Clone)]
pub struct ClientRegistry {
    inner: Arc<Inner>,
}

struct Inner {
    path: PathBuf,
    entries: Mutex<Vec<ClientEntry>>,
    /// 首次创建时刻（写入文件的 `born_at`；文件已存在则沿用其值）。
    born_at: u64,
}

static GLOBAL: OnceLock<ClientRegistry> = OnceLock::new();

/// 初始化进程级登记表（`main.rs` `Start` 调用一次）。
/// 文件名 `<instance_stem>-<instance_pid>.clients`（stem = 实例身份，
/// dev.sh 场景即 `BRANCH_BINARY_NAME`，见计划 D2）。
pub fn init_global(instance_stem: &str, instance_pid: u32) -> ClientRegistry {
    let path = registry_dir().join(format!("{instance_stem}-{instance_pid}.clients"));
    let registry = ClientRegistry::open(path);
    let _ = GLOBAL.set(registry.clone());
    registry
}

/// 进程级登记表（未初始化时 `None`——spawn/reap 侧降级为不登记，不 panic）。
pub fn global() -> Option<ClientRegistry> {
    GLOBAL.get().cloned()
}

/// `~/.omniterm/`（与 db / jwt_secret / pidfile 同目录）。
fn registry_dir() -> PathBuf {
    crate::omniterm_data_dir()
}

/// 启动对账入口（`main.rs` `Start` 调用）：扫描默认登记目录下全部 `*.clients`。
pub fn reconcile_all() -> ReconcileReport {
    reconcile_dir(&registry_dir())
}

impl ClientRegistry {
    /// 打开（或创建）指定路径的登记表。已存在的文件沿用其 `born_at`。
    pub fn open(path: PathBuf) -> Self {
        let born_at = load_file(&path).map(|f| f.born_at).unwrap_or_else(now_secs);
        Self { inner: Arc::new(Inner { path, entries: Mutex::new(Vec::new()), born_at }) }
    }

    /// 登记文件路径（诊断/测试用）。
    #[allow(dead_code)] // 待接线：P1-2 孤儿监控诊断输出（见 docs/dev/plans/backlog/dead-code-triage.md）
    pub fn path(&self) -> &Path {
        &self.inner.path
    }

    /// 登记一个控制客户端。超限时先清已死条目，仍超限拒登（见模块文档三问）。
    pub fn register(&self, entry: ClientEntry) -> RegisterOutcome {
        let mut entries = self.inner.entries.lock().expect("登记表锁中毒");
        entries.retain(is_live_entry);
        if entries.len() >= MAX_TRACKED_CLIENTS {
            warn!(
                tracked = entries.len(),
                "tmux 控制客户端登记表已满（MAX_TRACKED_CLIENTS={}），拒绝登记 pid={}；\
                 父死兜底由 PDEATHSIG 承担，登记缺失不构成泄漏",
                MAX_TRACKED_CLIENTS,
                entry.pid
            );
            return RegisterOutcome::RefusedFull;
        }
        // 同 pid 重复登记（重建竞态）：先注销旧条目，保持增删对称（计划 P0-2）。
        entries.retain(|e| e.pid != entry.pid);
        entries.push(entry);
        self.save_locked(&entries);
        RegisterOutcome::Registered
    }

    /// 注销（按 pid 幂等；reap 与 stop 两条路径都调）。
    pub fn deregister(&self, pid: u32) {
        let mut entries = self.inner.entries.lock().expect("登记表锁中毒");
        let before = entries.len();
        entries.retain(|e| e.pid != pid);
        if entries.len() != before {
            self.save_locked(&entries);
        }
    }

    /// 当前登记快照（P1-2 孤儿监控读口，`health/orphan.rs` 消费）。
    pub fn entries(&self) -> Vec<ClientEntry> {
        self.inner.entries.lock().expect("登记表锁中毒").clone()
    }

    /// 优雅退出路径：删除本实例的登记文件（显式 shutdown 路径，不挂 Drop——
    /// axum 关闭是否 drop `AppState` 未验证，见计划 §7 风险表）。
    pub fn remove_file(&self) {
        let _ = std::fs::remove_file(&self.inner.path);
    }

    fn save_locked(&self, entries: &[ClientEntry]) {
        if let Err(e) = save_file(&self.inner.path, self.inner.born_at, entries) {
            warn!(path = %self.inner.path.display(), error = %e, "写 tmux 控制客户端登记文件失败");
        }
    }
}

/// 登记进程是否仍存活（身份可读 = 进程还在；已死条目在 register 时被清）。
fn is_live_entry(entry: &ClientEntry) -> bool {
    process_identity(entry.pid).is_some()
}

/// 启动对账 kill 谓词（计划 P0-2）：结构化 argv 相等 ∧ 已孤儿 ∧ start_key 未变。
pub fn is_orphaned_tracked_client(ident: &ProcessIdentity, entry: &ClientEntry) -> bool {
    argv_has_prefix(&ident.argv, TMUX_CONTROL_ARGV_PREFIX)
        && ident.ppid != entry.spawn_ppid
        && ident.start_key == entry.start_key
}

/// 对账结果（结构化日志 + 单测断言用）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReconcileReport {
    /// 已被 SIGKILL 的残留孤儿数。
    pub killed: u32,
    /// 进程已消亡、条目清理数。
    pub cleared: u32,
    /// start_key 已变（PID 复用嫌疑）安全跳过数。
    pub skipped_reuse: u32,
    /// argv 不符（非 tmux -C）安全跳过数。
    pub skipped_mismatch: u32,
    /// 仍归 spawn 父进程所有（活跃实例的正常客户端）保留数。
    pub kept: u32,
    /// 已回收的孤儿登记文件数。
    pub files_removed: u32,
}

fn save_file(path: &Path, born_at: u64, entries: &[ClientEntry]) -> std::io::Result<()> {
    let file = RegistryFile { v: 1, born_at, entries: entries.to_vec() };
    let json = serde_json::to_vec_pretty(&file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    // tmp + rename 原子写（与 pty scrollback 同口径）：并发读者永不看到半截文件。
    let tmp = path.with_extension("clients.tmp");
    std::fs::write(&tmp, &json)?;
    std::fs::rename(&tmp, path)
}

fn load_file(path: &Path) -> Option<RegistryFile> {
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

/// 启动对账：扫描 `dir` 下**全部** `*.clients` 登记文件（覆盖上一实例与其他
/// 实例残留——D2 的跨实例覆盖面），杀掉谓词全通过的残留孤儿，回收超期空文件。
pub fn reconcile_dir(dir: &Path) -> ReconcileReport {
    let mut report = ReconcileReport::default();
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return report;
    };
    for dirent in read_dir.flatten() {
        let path = dirent.path();
        if path.extension().is_none_or(|ext| ext != "clients") {
            continue;
        }
        reconcile_file(&path, &mut report);
    }
    report
}

fn reconcile_file(path: &Path, report: &mut ReconcileReport) {
    let Some(file) = load_file(path) else {
        // 读不出 = 写坏/不认识的版本：不动（不误删别人的文件），WARN 留痕。
        warn!(path = %path.display(), "tmux 控制客户端登记文件不可解析，跳过对账");
        return;
    };

    for entry in &file.entries {
        match process_identity(entry.pid) {
            None => {
                report.cleared += 1; // 进程已消亡（含登记后从未跑起来的）
            }
            Some(ident) if ident.start_key != entry.start_key => {
                // PID 已被复用：不是当年那个进程——跳过不误杀（验收 §9）。
                warn!(
                    pid = entry.pid,
                    "登记的 tmux 控制客户端 pid 已被复用（start_key 不符），跳过击杀"
                );
                report.skipped_reuse += 1;
            }
            Some(ident) if !argv_has_prefix(&ident.argv, TMUX_CONTROL_ARGV_PREFIX) => {
                warn!(pid = entry.pid, argv = ?ident.argv, "登记 pid 的 argv 不是 tmux -C，跳过击杀");
                report.skipped_mismatch += 1;
            }
            Some(ident) if ident.ppid == entry.spawn_ppid => {
                report.kept += 1; // 仍归 spawn 父进程（活跃实例的正常客户端）
            }
            Some(ident) if is_orphaned_tracked_client(&ident, entry) => {
                info!(
                    pid = entry.pid,
                    session = %entry.session,
                    spawn_ppid = entry.spawn_ppid,
                    "启动对账：击杀残留 tmux -C 孤儿客户端"
                );
                match crate::process_identity::kill_pid_forced(entry.pid) {
                    Ok(()) => report.killed += 1,
                    Err(e) => warn!(pid = entry.pid, error = %e, "击杀残留孤儿失败"),
                }
            }
            Some(ident) => {
                // is_orphaned_tracked_client 内部三条件在此 match 链后必已穷尽，
                // 逻辑上不可达；防御性保留（宁可不杀）。
                warn!(pid = entry.pid, ?ident, "登记进程身份不满足击杀谓词，跳过");
                report.skipped_mismatch += 1;
            }
        }
    }

    // 孤儿文件超期回收：内容已空 ∧ 文件头实例 pid 已死 ∧ 超龄（计划 P0-2）。
    let owner_pid = file_owner_pid(path);
    let owner_dead = owner_pid.is_some_and(|pid| !crate::process_identity::pid_alive(pid));
    let overage = now_secs().saturating_sub(file.born_at) >= ORPHAN_FILE_MIN_AGE_SECS;
    let all_resolved = report_file_entries_resolved(&file);
    if all_resolved && owner_dead && overage {
        let _ = std::fs::remove_file(path);
        report.files_removed += 1;
    }
}

/// 本次扫描中该文件的条目是否全部不需保留（无 kept 类残留）。
fn report_file_entries_resolved(file: &RegistryFile) -> bool {
    file.entries.iter().all(|e| match process_identity(e.pid) {
        None => true,
        Some(ident) => ident.start_key != e.start_key || ident.ppid != e.spawn_ppid,
    })
}

/// 从文件名 `<stem>-<pid>.clients` 解析实例 pid。
fn file_owner_pid(path: &Path) -> Option<u32> {
    let stem = path.file_stem()?.to_str()?;
    stem.rsplit_once('-')?.1.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omniterm_registry_test_{tag}_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn entry_of(pid: u32, spawn_ppid: u32, start_key: &str) -> ClientEntry {
        ClientEntry::new(pid, spawn_ppid, start_key.to_string(), "lt_test")
    }

    /// 起一个 argv 结构化等于 `tmux -C …` 的假客户端，父进程 = 测试进程
    /// （ppid == spawn_ppid 场景）。
    ///
    /// 载体用 `bash`：argv 前缀要恰为 `["tmux","-C"]`，而 `sleep`/`cat` 等会把
    /// `-C` 当非法选项秒退——bash 把 `-C`(noclobber) 吃成自己的标志，argv[0..2]
    /// 与真实 `tmux -C` 完全同形。命令体必须是**复合命令**（`sleep N & wait`）：
    /// `bash -c '单条简单命令'` 会被 bash 直接 exec 顶替、argv 换成子命令（实测
    /// `bash -c 'sleep 60'` 最终进程 cmdline = `sleep 60`，谓词匹配不到）。
    fn spawn_fake_tmux_control_direct(sleep_secs: u32) -> std::process::Child {
        Command::new("python3")
            .args([
                "-c",
                &format!(
                    "import os; os.execv('/bin/bash', ['tmux', '-C', '-c', 'sleep {sleep_secs} & wait'])"
                ),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn fake tmux -C")
    }

    /// 起一个**孤儿**假客户端：`sh` 产孙进程（stdio 全部 /dev/null，否则 sh 的
    /// stdout 管道被孙进程拖住、`wait_with_output` 等满整个 sleep）后立即退出，
    /// 孙进程被 init 收养（ppid ≠ spawn_ppid），返回 `(孙 pid, sh 的 pid)`。
    fn spawn_fake_tmux_control_orphan(sleep_secs: u32) -> (u32, u32) {
        let child = Command::new("sh")
            .arg("-c")
            .arg(format!(
                "python3 -c \"import os; os.execv('/bin/bash', ['tmux', '-C', '-c', 'sleep {sleep_secs} & wait'])\" \
                 >/dev/null 2>&1 & echo $!; exit 0"
            ))
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn orphan maker");
        let sh_pid = child.id();
        let output = child.wait_with_output().expect("wait orphan maker");
        let grandchild: u32 =
            String::from_utf8_lossy(&output.stdout).trim().parse().expect("grandchild pid");
        (grandchild, sh_pid)
    }

    fn wait_gone(pid: u32, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline {
            if process_identity(pid).is_none() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        false
    }

    fn start_key_of(pid: u32) -> String {
        process_identity(pid).expect("identity").start_key
    }

    /// 有界等待 `execv` 换影完成：`spawn()` 返回 ≠ 新镜像 argv 已就位（竞态下
    /// reconcile 会读到 python3 的 argv 而误判 mismatch）。按目标 argv[0] 轮询
    /// 到就绪再继续，杜绝时序 flaky。
    fn wait_argv0(pid: u32, argv0: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let ident = process_identity(pid).expect("identity");
            if ident.argv.first().map(String::as_str) == Some(argv0) {
                return;
            }
            assert!(Instant::now() < deadline, "execv 换影超时：argv={:?}", ident.argv);
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn register_deregister_roundtrip_writes_file_atomically() {
        let dir = temp_dir("roundtrip");
        let reg = ClientRegistry::open(dir.join("omniterm-dev-4242.clients"));

        let mut child = spawn_fake_tmux_control_direct(30);
        let pid = child.id();
        assert_eq!(
            reg.register(entry_of(pid, std::process::id(), &start_key_of(pid))),
            RegisterOutcome::Registered
        );

        let file = load_file(reg.path()).expect("登记文件应已写出（tmp+rename）");
        assert_eq!(file.v, 1);
        assert_eq!(file.entries.len(), 1);
        assert_eq!(file.entries[0].pid, pid);
        assert_eq!(file.entries[0].spawn_ppid, std::process::id());
        assert!(!file.entries[0].start_key.is_empty());
        assert!(!reg.path().with_extension("clients.tmp").exists(), "tmp 文件应已被 rename 消费");

        reg.deregister(pid);
        assert!(reg.entries().is_empty());
        assert_eq!(load_file(reg.path()).expect("文件仍在").entries.len(), 0);

        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P1 三问之「守上限的单测」（计划 §9 超限用例）：满额后先清死条目再拒登——
    /// 断言长度恰为上限、超限项被拒（RefusedFull）且不落表、死条目被顺手清理。
    #[test]
    fn registry_cap_rejects_overflow_after_pruning_dead() {
        let dir = temp_dir("cap");
        let reg = ClientRegistry::open(dir.join("omniterm-dev-1.clients"));

        // 注入 MAX-1 条「身份可读」条目（pid = 测试进程自身，is_live_entry 必真）
        // + 1 条已死条目（`true` 进程退出后登记）。
        let dead = Command::new("true").spawn().expect("spawn true");
        let dead_pid = dead.id();
        let mut dead_child = dead;
        let _ = dead_child.wait();
        {
            let mut entries = reg.inner.entries.lock().unwrap();
            for i in 0..MAX_TRACKED_CLIENTS - 1 {
                entries.push(entry_of(std::process::id(), 0, &format!("fake-{i}")));
            }
            entries.push(entry_of(dead_pid, 0, "dead"));
        }

        // 死条目被清（255 < 256）→ 新登记放行，长度恰为上限。
        let mut first = spawn_fake_tmux_control_direct(30);
        let first_pid = first.id();
        let outcome =
            reg.register(entry_of(first_pid, std::process::id(), &start_key_of(first_pid)));
        assert_eq!(outcome, RegisterOutcome::Registered, "清死条目后有空位应放行");
        assert_eq!(reg.entries().len(), MAX_TRACKED_CLIENTS, "长度恰为上限");
        assert!(!reg.entries().iter().any(|e| e.pid == dead_pid), "死条目应被顺手清理");

        // 满额（无可清）→ 拒登新 spawn 并保持上限。
        let mut second = spawn_fake_tmux_control_direct(30);
        let second_pid = second.id();
        let outcome =
            reg.register(entry_of(second_pid, std::process::id(), &start_key_of(second_pid)));
        assert_eq!(outcome, RegisterOutcome::RefusedFull, "超限必须拒登新 spawn");
        let entries = reg.entries();
        assert_eq!(entries.len(), MAX_TRACKED_CLIENTS, "登记长度不得超过上限");
        assert!(!entries.iter().any(|e| e.pid == second_pid), "超限项必须被拒（不落表）");
        let file = load_file(reg.path()).expect("文件应已写");
        assert!(file.entries.len() <= MAX_TRACKED_CLIENTS);

        let _ = first.kill();
        let _ = first.wait();
        let _ = second.kill();
        let _ = second.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn session_names_are_truncated_on_utf8_boundary() {
        let long = "会话名".repeat(200); // 多字节字符，600 字符 > 255 字节
        let entry = ClientEntry::new(1, 1, "k".into(), &long);
        assert!(entry.session.len() <= MAX_SESSION_BYTES);
        assert!(!entry.session.is_empty(), "截断不得清空到不可读");
    }

    /// 启动对账正例：谓词全通过的残留孤儿被 SIGKILL（计划 §9）。
    #[test]
    fn reconcile_kills_fully_matching_orphan() {
        let dir = temp_dir("kill");
        let (orphan_pid, sh_pid) = spawn_fake_tmux_control_orphan(120);
        wait_argv0(orphan_pid, "tmux"); // 等 execv 换影完成（见 wait_argv0）
        std::thread::sleep(Duration::from_millis(100)); // 等 sh 退出、孙进程被收养
        let key = start_key_of(orphan_pid);
        let reg =
            ClientRegistry::open(dir.join(format!("omniterm-dev-{}.clients", std::process::id())));
        reg.register(entry_of(orphan_pid, sh_pid, &key));

        let report = reconcile_dir(&dir);
        assert_eq!(report.killed, 1, "谓词全通过的孤儿应被击杀: {report:?}");
        assert!(wait_gone(orphan_pid, Duration::from_secs(5)), "孤儿应在时限内消失");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 反例 1（PID 复用）：start_key 已变的条目被安全跳过、不误杀（计划 §9）。
    #[test]
    fn reconcile_skips_pid_reuse_without_killing() {
        let dir = temp_dir("reuse");
        let mut child = spawn_fake_tmux_control_direct(120);
        let pid = child.id();
        // 故意登记错误 start_key，模拟「登记后 pid 被复用」。
        let reg =
            ClientRegistry::open(dir.join(format!("omniterm-dev-{}.clients", std::process::id())));
        reg.register(entry_of(pid, 0, "bogus-start-key"));

        let report = reconcile_dir(&dir);
        assert_eq!(report.killed, 0, "start_key 不符不得击杀: {report:?}");
        assert_eq!(report.skipped_reuse, 1);
        assert!(process_identity(pid).is_some(), "进程必须存活（不误杀）");

        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 反例 2（活跃实例）：ppid 未变 = 仍归 spawn 父进程所有，保留（计划 §9
    /// 「healthy 不得被命中」同族防护）。
    #[test]
    fn reconcile_keeps_clients_still_owned_by_live_parent() {
        let dir = temp_dir("keep");
        let mut child = spawn_fake_tmux_control_direct(120);
        let pid = child.id();
        wait_argv0(pid, "tmux"); // 等 execv 换影完成（见 wait_argv0）
        let reg =
            ClientRegistry::open(dir.join(format!("omniterm-dev-{}.clients", std::process::id())));
        reg.register(entry_of(pid, std::process::id(), &start_key_of(pid)));

        let report = reconcile_dir(&dir);
        assert_eq!(report.killed, 0, "活跃父进程的客户端不得被击杀: {report:?}");
        assert_eq!(report.kept, 1);
        assert!(process_identity(pid).is_some(), "进程必须存活（不误杀）");

        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 反例 3（argv 不符）：`vim 'tmux -C.md'` 型误配不得被杀（结构化相等）。
    /// 假进程 argv[0] = `tmux -C.md`——**含** `tmux -C` 子串但元素边界不同，
    /// 子串匹配会误杀、结构化相等必须拒绝。
    #[test]
    fn reconcile_skips_non_control_argv() {
        let dir = temp_dir("argv");
        let mut child = Command::new("python3")
            .args([
                "-c",
                "import os; os.execv('/bin/bash', ['tmux -C.md', '-c', 'sleep 120 & wait'])",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn fake vim arg");
        let pid = child.id();
        wait_argv0(pid, "tmux -C.md"); // 等 execv 换影完成（见 wait_argv0）
        let reg =
            ClientRegistry::open(dir.join(format!("omniterm-dev-{}.clients", std::process::id())));
        reg.register(entry_of(pid, 0, &start_key_of(pid)));

        let report = reconcile_dir(&dir);
        assert_eq!(report.killed, 0, "argv 不符不得击杀: {report:?}");
        assert_eq!(report.skipped_mismatch, 1);
        assert!(process_identity(pid).is_some(), "进程必须存活（不误杀）");

        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 孤儿登记文件超期回收：内容已空 ∧ 实例 pid 已死 ∧ 超龄 ⇒ 文件被删。
    #[test]
    fn reconcile_removes_expired_orphan_registry_file() {
        let dir = temp_dir("gc");
        // 文件名实例 pid 用必死的 `true` 进程 pid；born_at 回拨制造超龄。
        let mut true_child = Command::new("true").spawn().expect("spawn true");
        let owner_pid = true_child.id();
        let _ = true_child.wait();

        let path = dir.join(format!("omniterm-dev-{owner_pid}.clients"));
        save_file(&path, now_secs() - ORPHAN_FILE_MIN_AGE_SECS - 1, &[]).expect("write file");

        let report = reconcile_dir(&dir);
        assert_eq!(report.files_removed, 1, "超期空孤儿文件应被回收: {report:?}");
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 未超龄的空文件不动（「超期」判据真的生效）。
    #[test]
    fn reconcile_keeps_fresh_empty_file() {
        let dir = temp_dir("gc_fresh");
        let path = dir.join(format!("omniterm-dev-{}.clients", std::process::id()));
        save_file(&path, now_secs(), &[]).expect("write file");

        let report = reconcile_dir(&dir);
        assert_eq!(report.files_removed, 0, "未超龄不得回收: {report:?}");
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
