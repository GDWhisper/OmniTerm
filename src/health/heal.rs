//! 内建自愈「重建 tmux server」（计划 P1-1 / ADR D3：内建动作，勿做成脚本——
//! 无人值守下聋 server 无限期持续，检测与恢复必须同一闭环）。
//!
//! # 流程钉死（计划 §5 P1-1，顺序即安全顺序）
//!
//! a) **重探针**：动作发生时当场再探一次，必须仍判 [`ServerHealth::Deaf`] 才继续
//!    （防陈旧状态 / 自动重建后误杀健康 server）；
//! b) **单飞互斥**：heal 全程持锁（[`HealthState::heal_mutex`]），进行中的第二次
//!    触发**立即**得到 [`HealError::InProgress`]，不排队、不并行。锁先于重探针取得
//!    ——「全程持锁」与「第二次触发立即 in_progress」两个要求同时成立；
//! c) **socket inode 反查 server PID**（[`find_socket_owner`]）：读 `/proc/net/unix`
//!    找 `Path == tmux socket 路径` 且 LISTEN 的行取 Inode，扫 `/proc/<pid>/fd` 找
//!    `socket:[Inode]` 属主，再用 `readlink /proc/<pid>/exe` 基名 == "tmux" 复核
//!    身份（tmux server 的 cmdline 可能被 setproctitle 改写成 "tmux: server"，
//!    exe readlink 才可靠）。找不到进程 / 复核不过 ⇒ **放弃击杀**并返回明确错误
//!    （绝不猜 PID）；
//! d) SIGKILL（[`crate::process_identity::kill_pid_forced`]，pidfd 免疫 PID 复用）；
//! e) 删 stale socket 文件；
//! f) 下一条 tmux 命令会自动重建 server（tmux 自身行为，无需我们拉起）。
//!
//! # 幂等论证（计划 §5）
//!
//! a) 重探针 + b) 单飞互斥保证并发双击 / 多标签重复触发不会命中已自动重建的
//! **健康新 server**：双击中的第二次要么撞上单飞锁（`in_progress`），要么重探针
//! 已看不到 Deaf（`not_deaf`），均在击杀之前被拒绝。
//!
//! # 取证日志（计划 §3.2 注记）
//!
//! 自愈动作是历史上唯一的「omniterm 向 tmux server 发信号」路径（计划 §8 例外），
//! 落地后 §3.2 的排除法前提对新版本永久失效——全程 `tracing::info!` 结构化日志
//! （字段 stage / pid / socket_path / …）是事后取证的唯一线索，勿降级为 debug。
//!
//! # 平台差异（工程准则 8）
//!
//! 步骤 c 依赖 `/proc/net/unix` + `/proc/<pid>/fd`：**仅 Linux 完整实现**；
//! macOS/Windows 反查不可用 ⇒ 明确降级（WARN + [`HealError::OwnerUnresolved`]，
//! 拒绝击杀），不静默假装成功、绝不退化为「猜 PID」。

use std::path::Path;

use tracing::{info, warn};

use super::HealthState;
use super::classify::ServerHealth;
use super::probe::{self, ProbeResult};
use crate::process_identity::kill_pid_forced;

/// 自愈动作结果（HTTP 契约 `POST /api/v1/tmux/rebuild` 200 体）。
#[derive(Debug, Clone)]
pub struct HealOutcome {
    /// 被 SIGKILL 的 tmux server pid（按契约可空；本流程成功时必有值）。
    pub server_pid: Option<u32>,
    /// stale socket 文件是否已不在（删除失败只降级为 false，不回滚击杀）。
    pub socket_removed: bool,
    pub detail: String,
}

/// 自愈失败（API 映射：`NotDeaf`/`InProgress` → 409 契约错误码，其余 → 500）。
#[derive(Debug)]
pub enum HealError {
    /// 重探针未确认聋（含并发双击后 server 已自动重建的场景）⇒ 409 `not_deaf`。
    NotDeaf(ServerHealth),
    /// 单飞占用：已有 heal 在进行中 ⇒ 409 `heal_in_progress`。
    InProgress,
    /// socket inode 反查失败 / 身份复核不过——放弃击杀（绝不猜 PID）。
    OwnerUnresolved(String),
    /// SIGKILL 失败。
    KillFailed { pid: u32, source: std::io::Error },
}

impl HealError {
    /// 人类可读原因（HTTP 500 体的 `error` 字段）。
    pub fn detail(&self) -> String {
        match self {
            HealError::NotDeaf(health) => {
                format!("re-probe did not confirm deaf (state: {health})")
            }
            HealError::InProgress => "another rebuild is already in progress".to_string(),
            HealError::OwnerUnresolved(reason) => format!("tmux server pid unresolved: {reason}"),
            HealError::KillFailed { pid, source } => {
                format!("SIGKILL tmux server pid {pid} failed: {source}")
            }
        }
    }
}

/// 反查到的 tmux server 进程（exe 身份已复核）。
#[derive(Debug, Clone)]
pub struct ServerProcess {
    pub pid: u32,
    /// `readlink /proc/<pid>/exe` 基名（= "tmux"，复核依据，日志取证用）。
    pub exe_name: String,
}

/// 生产入口：单飞 + 当场重探针 + 击杀流程（步骤见模块文档）。
/// socket 路径取 [`probe::socket_path`]（默认 socket，生产语义）。
pub async fn heal(state: &HealthState) -> Result<HealOutcome, HealError> {
    heal_at(state, probe::socket_path().as_deref(), probe::probe()).await
}

/// 流程核心（socket 路径与重探针可注入，测试恒指向临时路径——护栏：测试禁止
/// 触碰默认 tmux socket）。
async fn heal_at(
    state: &HealthState,
    socket_path: Option<&Path>,
    reprobe: impl std::future::Future<Output = ProbeResult>,
) -> Result<HealOutcome, HealError> {
    // b) 单飞互斥：try_lock 失败 = 已有 heal 在进行中，立即返回 in_progress。
    let _guard = state.heal_mutex().try_lock().map_err(|_| HealError::InProgress)?;
    // a) 重探针：动作发生时当场再探一次，必须仍判 Deaf 才继续。
    let probe = reprobe.await;
    if probe.health != ServerHealth::Deaf {
        info!(
            stage = "reprobe",
            health = %probe.health,
            "重建 tmux server 中止：重探针未确认聋（防陈旧状态/自动重建后误杀）"
        );
        return Err(HealError::NotDeaf(probe.health));
    }
    let Some(socket_path) = socket_path else {
        return Err(HealError::OwnerUnresolved(
            "本平台无 tmux socket 路径语义（Windows/psmux），反查不可用——放弃击杀".to_string(),
        ));
    };
    info!(stage = "reprobe", health = "deaf", socket_path = %socket_path.display(), "重建 tmux server：重探针确认聋，开始自愈");
    // c) socket inode 反查 server PID（找不到/复核不过 ⇒ 放弃击杀）。
    let owner = find_socket_owner(socket_path).map_err(|reason| {
        warn!(stage = "resolve", socket_path = %socket_path.display(), %reason, "重建 tmux server 放弃击杀");
        HealError::OwnerUnresolved(reason)
    })?;
    info!(
        stage = "resolve",
        pid = owner.pid,
        exe = %owner.exe_name,
        socket_path = %socket_path.display(),
        "反查到 tmux server 进程（exe 身份已复核）"
    );
    // d) SIGKILL——omniterm 向 tmux server 发信号的唯一路径（计划 §8 例外）。
    kill_pid_forced(owner.pid)
        .map_err(|source| HealError::KillFailed { pid: owner.pid, source })?;
    info!(stage = "kill", pid = owner.pid, socket_path = %socket_path.display(), "已对 tmux server 发送 SIGKILL");
    // e) 删 stale socket 文件；失败只降级 socket_removed=false（不回滚击杀事实）。
    let (socket_removed, cleanup_note) = match std::fs::remove_file(socket_path) {
        Ok(()) => (true, "stale socket removed"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (true, "stale socket already gone"),
        Err(e) => {
            warn!(
                stage = "socket_cleanup",
                pid = owner.pid,
                socket_path = %socket_path.display(),
                error = %e,
                "删除 stale socket 失败"
            );
            return Ok(HealOutcome {
                server_pid: Some(owner.pid),
                socket_removed: false,
                detail: format!(
                    "killed deaf tmux server pid {}; stale socket removal failed: {e}; next tmux command auto-rebuilds the server",
                    owner.pid
                ),
            });
        }
    };
    info!(
        stage = "socket_cleanup",
        pid = owner.pid,
        socket_path = %socket_path.display(),
        socket_removed,
        "{cleanup_note}"
    );
    // f) 下一条 tmux 命令自动重建 server（tmux 自身行为）。
    Ok(HealOutcome {
        server_pid: Some(owner.pid),
        socket_removed,
        detail: format!(
            "killed deaf tmux server pid {}; {cleanup_note}; next tmux command auto-rebuilds the server",
            owner.pid
        ),
    })
}

/// socket inode 反查持有 LISTEN socket 的 tmux server 进程（流程步骤 c）。
/// 找不到 / 复核不过 ⇒ `Err(明确原因)`——放弃击杀，绝不猜 PID。
pub fn find_socket_owner(socket_path: &Path) -> Result<ServerProcess, String> {
    platform::find_owner_impl(socket_path)
}

/// `readlink /proc/<pid>/exe` 基名 == "tmux" 的身份复核（纯函数，单测覆盖）。
/// cmdline 不可靠：tmux server 经 setproctitle 把 argv 改写成 "tmux: server"。
#[cfg(target_os = "linux")]
fn exe_is_tmux(exe_link: &str) -> bool {
    Path::new(exe_link).file_name().map(|n| n == "tmux").unwrap_or(false)
}

/// `/proc/net/unix` 行按列拆分：前 `n` 列空白分隔，剩余整段 = 末列（Path 可含
/// 空白，见 [`parse_unix_row`] 注记）。
#[cfg(target_os = "linux")]
fn split_head_columns(line: &str, n: usize) -> Option<(Vec<&str>, &str)> {
    let mut rest = line;
    let mut cols = Vec::with_capacity(n);
    for _ in 0..n {
        rest = rest.trim_start();
        if rest.is_empty() {
            return None;
        }
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        cols.push(&rest[..end]);
        rest = &rest[end..];
    }
    Some((cols, rest.trim_start()))
}

/// `/proc/net/unix` 一行 → (St, Inode, Path)（纯函数，单测覆盖）。
///
/// 列序（proc(5) 实测口径，2026-09-22）：Num RefCount Protocol Flags Type **St**
/// **Inode** Path。Path 列可含空白——`split_whitespace` 会把它拆散，故按列头
/// 截取剩余整段；路径含连续多个空白时可能拼不回（比较不相等 ⇒ 反查失败 ⇒
/// 放弃击杀，安全方向）。
#[cfg(target_os = "linux")]
fn parse_unix_row(line: &str) -> Option<(String, u64, String)> {
    let (cols, path) = split_head_columns(line, 7)?;
    let st = cols[5].to_string();
    let inode = cols[6].parse::<u64>().ok()?;
    Some((st, inode, path.to_string()))
}

/// 在 `/proc/net/unix` 全文里找 `Path == socket_path` 且 LISTEN 的行取 Inode
/// （纯函数，单测覆盖）。
///
/// 必须按 St 过滤（实测 2026-09-22，kernel 7.0）：LISTEN 行
/// `Flags=00010000 / Type=0001 / St=01`；server 侧 accept 出的**已连接** socket
/// 条目 `St=03` 且**同样带 Path**——不过滤会反查到已连接 socket 的 inode。
/// （客户端侧已连接条目则没有 Path 字段，这也是孤儿监控无法做 socket 归属配对的
/// 实测根因，见 `super::orphan` 模块文档。）
#[cfg(target_os = "linux")]
fn find_listen_inode(proc_net_unix: &str, socket_path: &str) -> Option<u64> {
    proc_net_unix
        .lines()
        .filter_map(parse_unix_row)
        .find(|(st, _inode, path)| st == UNIX_ST_LISTEN && path == socket_path)
        .map(|(_st, inode, _path)| inode)
}

/// `/proc/net/unix` 的 St 列 LISTEN 取值（实测口径 01 + ACC 标志，见
/// [`find_listen_inode`] 注记）。
#[cfg(target_os = "linux")]
const UNIX_ST_LISTEN: &str = "01";

/// tmux server 的 exe 基名（身份复核判据，[`exe_is_tmux`]）。
#[cfg(target_os = "linux")]
const TMUX_SERVER_EXE_BASENAME: &str = "tmux";

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::path::PathBuf;

    pub fn find_owner_impl(socket_path: &Path) -> Result<ServerProcess, String> {
        let text = std::fs::read_to_string("/proc/net/unix")
            .map_err(|e| format!("读 /proc/net/unix 失败：{e}"))?;
        let path_str = socket_path.to_string_lossy();
        let inode = find_listen_inode(&text, &path_str).ok_or_else(|| {
            format!("{path_str} 上无 LISTEN socket（server 已消亡或路径不符）——放弃击杀")
        })?;
        let owners = find_fd_owners(inode);
        let verified: Vec<ServerProcess> = owners
            .iter()
            .filter(|(_, exe_name)| exe_is_tmux(exe_name))
            .map(|(pid, exe_name)| ServerProcess { pid: *pid, exe_name: exe_name.clone() })
            .collect();
        match verified.as_slice() {
            [only] => Ok(only.clone()),
            [] => Err(format!(
                "socket inode {inode} 无属主进程或 exe 身份复核不过（要求 exe 基名 == \"{TMUX_SERVER_EXE_BASENAME}\"），候选 {owners:?}——放弃击杀"
            )),
            many => Err(format!(
                "socket inode {inode} 有 {} 个 tmux 身份属主，无法唯一确定——放弃击杀",
                many.len()
            )),
        }
    }

    /// 扫 `/proc/<pid>/fd` 找 `socket:[<inode>]` 的属主 (pid, exe 基名)。
    /// 无权限读的 fd 目录（其他用户进程）静默跳过——tmux server 与本进程同 uid。
    fn find_fd_owners(inode: u64) -> Vec<(u32, String)> {
        let want = format!("socket:[{inode}]");
        let Ok(proc_dir) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        let mut owners = Vec::new();
        for dirent in proc_dir.flatten() {
            let Ok(pid) = dirent.file_name().to_string_lossy().parse::<u32>() else {
                continue;
            };
            let Ok(fd_dir) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
                continue;
            };
            let holds = fd_dir
                .flatten()
                .any(|fd| std::fs::read_link(fd.path()).map(|l| l == want).unwrap_or(false));
            if holds {
                let exe_name = std::fs::read_link(format!("/proc/{pid}/exe"))
                    .unwrap_or_else(|_| PathBuf::from("?"))
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "?".to_string());
                owners.push((pid, exe_name));
            }
        }
        owners
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use super::*;

    /// macOS/Windows 无 `/proc/net/unix` + `/proc/<pid>/fd`：反查不可用 ⇒ 明确
    /// 降级（WARN + 错误，拒绝击杀），不静默假装成功、绝不猜 PID（工程准则 8）。
    pub fn find_owner_impl(socket_path: &Path) -> Result<ServerProcess, String> {
        warn!(
            socket_path = %socket_path.display(),
            "非 Linux 平台无 /proc，socket inode 反查不可用：重建 tmux server 降级为拒绝执行（不猜 PID）"
        );
        Err("socket inode lookup unavailable on this platform (requires /proc)".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::test_support::{FakeSocketHolder, temp_dir, wait_child_exit};
    use crate::health::{HealthState, probe::ProbeResult};

    /// tmux server 的 exe 基名（身份复核判据；独立字面量断言常量语义）。
    const EXE_BASENAME: &str = "tmux";

    fn deaf_probe() -> ProbeResult {
        ProbeResult { health: ServerHealth::Deaf, command: None, socket: None }
    }

    fn probe_with(health: ServerHealth) -> ProbeResult {
        ProbeResult { health, command: None, socket: None }
    }

    /// 「健康 server 不得被命中」防护（计划 §9）：重探针 ∈ {Healthy, NoServer,
    /// Other} 时 heal 必须拒绝（409 `not_deaf` 语义），持有 socket 的进程毫发无损。
    #[tokio::test]
    async fn heal_refuses_when_reprobe_not_deaf() {
        let mut holder = FakeSocketHolder::spawn("heal_refuse", EXE_BASENAME);
        for health in [ServerHealth::Healthy, ServerHealth::NoServer, ServerHealth::Other] {
            let state = HealthState::new();
            let err =
                heal_at(&state, Some(&holder.socket_path), std::future::ready(probe_with(health)))
                    .await
                    .expect_err("非 deaf 必须拒绝自愈");
            assert!(
                matches!(err, HealError::NotDeaf(h) if h == health),
                "health={health:?} got {err:?}"
            );
        }
        assert!(
            holder.child.try_wait().unwrap().is_none(),
            "健康 server 不得被命中（进程必须存活）"
        );
    }

    /// socket inode 反查正例（计划 §9：真实 unix socket + 持有进程能找到属主）
    /// + 全流程：SIGKILL 已复核身份的属主、删 stale socket；随后「第二次动作不
    /// 命中已重建的新 server」：heal 后重探针变 Healthy（tmux 自动重建）⇒ 再
    /// 触发必须 409 `not_deaf` 语义。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn heal_kills_verified_owner_removes_socket_then_refuses_rebuilt_server() {
        let mut holder = FakeSocketHolder::spawn("heal_kill", EXE_BASENAME);
        let pid = holder.child.id();
        let state = HealthState::new();

        let owner = find_socket_owner(&holder.socket_path).expect("应反查到属主");
        assert_eq!(owner.pid, pid);
        assert_eq!(owner.exe_name, EXE_BASENAME);

        let outcome = heal_at(&state, Some(&holder.socket_path), std::future::ready(deaf_probe()))
            .await
            .expect("重探针确认聋应可自愈");
        assert_eq!(outcome.server_pid, Some(pid));
        assert!(outcome.socket_removed);
        assert!(wait_child_exit(&mut holder.child), "server 应被 SIGKILL 并退出");
        assert!(!holder.socket_path.exists(), "stale socket 应被删除");

        // 幂等防护：已自动重建的新 server（重探针判 Healthy）绝不命中。
        let err = heal_at(
            &state,
            Some(&holder.socket_path),
            std::future::ready(probe_with(ServerHealth::Healthy)),
        )
        .await
        .expect_err("重建后的健康 server 不得再被命中");
        assert!(matches!(err, HealError::NotDeaf(ServerHealth::Healthy)));
    }

    /// 身份不符（exe 基名 ≠ "tmux"）⇒ 重核不过 ⇒ 放弃击杀，进程存活（绝不猜 PID）。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn heal_aborts_without_killing_when_owner_identity_mismatched() {
        let mut holder = FakeSocketHolder::spawn("heal_mismatch", "python3");
        let state = HealthState::new();
        let err = heal_at(&state, Some(&holder.socket_path), std::future::ready(deaf_probe()))
            .await
            .expect_err("身份复核不过必须放弃击杀");
        assert!(matches!(err, HealError::OwnerUnresolved(_)));
        assert!(holder.child.try_wait().unwrap().is_none(), "身份不符进程不得被杀");
    }

    /// 找不到 LISTEN socket（路径不存在）⇒ 放弃击杀 + 明确错误。
    #[tokio::test]
    async fn heal_aborts_when_socket_owner_unresolved() {
        let dir = temp_dir("heal_no_sock");
        let state = HealthState::new();
        let err =
            heal_at(&state, Some(&dir.join("missing.sock")), std::future::ready(deaf_probe()))
                .await
                .expect_err("找不到 server 必须放弃击杀");
        assert!(matches!(err, HealError::OwnerUnresolved(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 并发单飞（计划 §9）：heal 进行中第二次触发**立即** 409 `heal_in_progress`
    /// 语义（不排队、不并行）。确定性门控：first 的重探针 future 首轮 poll 时报到
    /// ——报到即证明单飞锁已被 first 持有（send 发生在 try_lock 之后）；second 在
    /// first 仍被 release 门挡住时就返回 = 「立即」。
    #[tokio::test]
    async fn heal_single_flight_rejects_concurrent_trigger_immediately() {
        let state = HealthState::new();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let first_state = state.clone();
        let first = tokio::spawn(async move {
            heal_at(&first_state, None, async move {
                let _ = started_tx.send(());
                let _ = release_rx.await;
                probe_with(ServerHealth::Other) // 放行后判 Other → NotDeaf，安全收场（不触任何进程）
            })
            .await
        });
        started_rx.await.expect("first 应已持单飞锁进入重探针");

        let second = heal_at(&state, None, std::future::ready(deaf_probe())).await;
        assert!(
            matches!(second, Err(HealError::InProgress)),
            "进行中的第二次触发必须立即 in_progress: {second:?}"
        );

        let _ = release_tx.send(());
        let first_res = first.await.expect("join first");
        assert!(matches!(first_res, Err(HealError::NotDeaf(ServerHealth::Other))));
    }

    /// `/proc/net/unix` 解析 + LISTEN 过滤（实测样本：同一 Path 有 St=01 的
    /// LISTEN 行与 St=03 的已连接行，必须取前者）。
    #[cfg(target_os = "linux")]
    #[test]
    fn find_listen_inode_filters_connected_rows_sharing_path() {
        let sample = "\
Num       RefCount Protocol Flags    Type St Inode Path
0000000000000000: 00000002 00000000 00010000 0001 01 479162424 /tmp/tmux-1000/default
0000000000000000: 00000003 00000000 00000000 0001 03 479163467 /tmp/tmux-1000/default
0000000000000000: 00000002 00000000 00010000 0001 01 32583 /var/run/docker/metrics.sock
";
        assert_eq!(find_listen_inode(sample, "/tmp/tmux-1000/default"), Some(479162424));
        assert_eq!(find_listen_inode(sample, "/var/run/docker/metrics.sock"), Some(32583));
        assert_eq!(
            find_listen_inode(sample, "/tmp/absent.sock"),
            None,
            "找不到 ⇒ None（调用方放弃击杀）"
        );
    }

    /// Path 列含空白时按「剩余整段」取，不被 split_whitespace 拆散。
    #[cfg(target_os = "linux")]
    #[test]
    fn parse_unix_row_keeps_path_with_spaces() {
        let row = "0000000000000000: 00000002 00000000 00010000 0001 01 42 /tmp/a b/s.sock";
        let (st, inode, path) = parse_unix_row(row).expect("should parse");
        assert_eq!(st, "01");
        assert_eq!(inode, 42);
        assert_eq!(path, "/tmp/a b/s.sock");
        assert!(parse_unix_row("short row").is_none());
    }

    /// exe 身份复核：基名 == "tmux" 才过（cmdline 可能被 setproctitle 改写，
    /// 只认 exe readlink）。
    #[cfg(target_os = "linux")]
    #[test]
    fn exe_identity_check_uses_basename_only() {
        assert!(exe_is_tmux("/usr/bin/tmux"));
        assert!(exe_is_tmux("tmux"));
        assert!(!exe_is_tmux("/usr/bin/tmux: server"), "setproctitle 形态不是 exe 基名判据的目标");
        assert!(!exe_is_tmux("/usr/bin/python3"));
        assert!(!exe_is_tmux(""));
    }
}
