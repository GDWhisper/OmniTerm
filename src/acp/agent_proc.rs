//! ACP agent 子进程的 spawn 包装（cwd + pid 自报）与进程组击杀。
//!
//! # 为什么需要这个模块
//!
//! `agent-client-protocol` 的 `AcpAgent::spawn_process` 有两个 omniterm 必须
//! 绕开的限制：
//!
//! 1. **不设 current_dir** —— agent 子进程的 OS cwd 是后端进程的 cwd 而非
//!    session workspace（实测 PID 1838360 的 `/proc/PID/cwd` 指向仓库根而非
//!    `/home/pax/home`）。故用 `sh -c "cd <ws> && exec <cmd>"` 包装。
//! 2. **不把子进程句柄交给调用方** —— omniterm 拿不到 `Child`，无法直接终止
//!    agent。原 `AcpClient::shutdown()` 只发优雅信号，杀进程依赖 crate 内部
//!    task_actor 自然结束后 `ChildGuard::drop` 的 killpg；**连接 poll 卡死时
//!    该路径永远走不到**（2026-09-21 CPU 尖峰事故，见
//!    `docs/dev/plans/2026-09-21-acp-agent-connection-cpu-spin.md`）。
//!
//! 本模块补上 omniterm 侧直接可控的两样东西：
//!
//! - **pid 捕获（计划 D1）**：wrapper `echo $$ > <pid 文件>` 自报为主路径
//!   （`$$` 是 wrapper sh 自身 pid，`exec` 后同 pid 成为 agent，也正是 crate
//!   设的进程组 leader）；`/proc/self/task/*/children` spawn 前后 diff 为兜底
//!   （仅 Linux；并发 spawn 时按 `/proc/<pid>/cwd` 匹配 workspace 消歧）。
//! - **进程组击杀（计划 D2）**：`kill(-pid, SIGKILL)`。crate 的 spawn_process
//!   已把 agent（wrapper sh）设为独立进程组 leader（`process_group(0)`），负
//!   pid 即 killpg，覆盖 wrapper launcher（`npx → node`）的孙进程场景；与
//!   crate `ChildGuard::drop` 的 killpg 重复执行无副作用（`ESRCH` 忽略）。
//!
//! 多实现差异（AGENTS.md §8）：非 Unix 平台既无 `sh` wrapper 也无 `/proc`，
//! pid 恒不可得 → 击杀降级为仅优雅信号（= 修复前现状），由调用方 WARN 留痕；
//! 非 Linux 的 Unix（macOS）pid 文件主路径仍可用，但无 `/proc` 归属校验，
//! killpg 与 crate `ChildGuard::drop` 同口径直接执行。

#[cfg(unix)]
use std::collections::HashSet;
#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::path::{Path, PathBuf};

#[cfg(unix)]
use uuid::Uuid;

// ---------------------------------------------------------------------------
// POSIX shell 包装：cwd 修复 + pid 自报
// ---------------------------------------------------------------------------

/// POSIX shell 单引号转义。
///
/// 将字符串安全嵌入 `sh -c '...'` 的单引号片段中：
/// - 空串 → `''`
/// - 不含单引号 → 原样包裹在单引号内
/// - 含单引号 → 按 POSIX 模式 `'...'\''...'` 分段转义
#[cfg(unix)]
pub fn sh_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if !s.contains('\'') {
        return format!("'{s}'");
    }
    // 含单引号：分段拼接  '...'\''...'
    let mut quoted = String::new();
    quoted.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            // 结束当前单引号段、插入转义单引号、重新开始单引号段
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

/// pid 自报文件路径：`temp_dir/omniterm-acp-<uuid>.pid`，每次 spawn 一个。
///
/// 用 uuid 而非 session id：create 路径 spawn 时 DB session 行尚未生成；restore
/// 与 create、探针可能并发 spawn，共享路径会互相覆盖。读取后立即删除（见
/// [`remove_pid_file`]），连接未建成的错误路径也 best-effort 清理——唯一残留
/// 场景是 omniterm 在「spawn 后、读取前」崩溃，单个几十字节文件，可接受。
#[cfg(unix)]
pub fn new_pid_file() -> PathBuf {
    std::env::temp_dir().join(format!("omniterm-acp-{}.pid", Uuid::new_v4()))
}

/// 删除 pid 自报文件（幂等；`NotFound` 不视为错误）。
#[cfg(unix)]
pub fn remove_pid_file(path: &Path) {
    if let Err(e) = std::fs::remove_file(path)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        tracing::debug!(path = %path.display(), error = %e, "清理 ACP pid 自报文件失败");
    }
}

/// pid 自报文件的 RAII 清理守卫（P2-3）：Drop 时删除文件（幂等）。
///
/// 存在的理由：连接任务的终结路径不止「正常读完」一种——探针 15s 超时会 drop
/// 掉外层 spawn future，`abort_tx` 随之释放、crash watcher abort 连接任务
/// （Phase 1 D4 兜底，crate 的 `ChildGuard::drop` 负责 killpg 进程组），闭包
/// 侧代码（含外层 future 的 `conn_rx` Err 分支）都来不及跑。由本守卫在任务
/// 结束（返回 / abort / panic）时统一收尾。成功路径上 `capture_agent_pid`
/// 读后即删，Drop 为 no-op。
#[cfg(unix)]
pub(crate) struct PidFileCleanup(PathBuf);

#[cfg(unix)]
impl PidFileCleanup {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self(path)
    }
}

#[cfg(unix)]
impl Drop for PidFileCleanup {
    fn drop(&mut self) {
        remove_pid_file(&self.0);
    }
}

/// 读取并删除 pid 自报文件。有界读取（32 字节）：内容由 wrapper 的 `echo $$`
/// 产生，正常仅几字节；有界防止异常内容把整文件读进内存（§P1 外部输入）。
#[cfg(unix)]
pub fn read_and_clear_pid_file(path: &Path) -> Option<u32> {
    let parsed = match std::fs::File::open(path) {
        Ok(mut f) => {
            let mut buf = [0u8; 32];
            match f.read(&mut buf) {
                Ok(n) => {
                    std::str::from_utf8(&buf[..n]).ok().and_then(|s| s.trim().parse::<u32>().ok())
                }
                Err(_) => None,
            }
        }
        Err(_) => None,
    };
    // 读失败（文件在/内容坏）也尝试删除，避免 /tmp 累积
    remove_pid_file(path);
    parsed
}

/// 生成 shell wrapper 命令，使 agent 子进程以正确的 workspace 作为 OS cwd，
/// 并（`pid_file` 为 `Some` 时）自报 pid。
///
/// POSIX-only; ACP 暂不支持 Windows。
///
/// 返回 `["-c", "cd <workspace> [&& echo $$ > <pid 文件>] && exec <agent_cmd> <arg1> …>"]`，
/// 调用方应将其附加到 `/bin/sh` 之后：
///
/// ```ignore
/// let mut cmd = std::process::Command::new("/bin/sh");
/// cmd.args(wrap_agent_with_cwd(&cmd_path, &args, &workspace, Some(&pid_file)));
/// ```
///
/// 使用 `exec` 替换 shell 进程，确保：
/// - agent 进程直接接收信号（不会因 shell 而屏蔽/延迟）
/// - 进程组清理工作正常
/// - 额外 shell 进程不会残留
///
/// pid 自报（`echo $$`）：`$$` 是 wrapper（sh）自身 pid，`exec` 后原 pid 成为
/// agent——crate 的 `spawn_process` 对该 pid 设了 `process_group(0)`，它同时
/// 就是 D2 killpg 的进程组 leader。放在 `cd` 成功之后：workspace 不可用时
/// 不写文件，调用方据此走 `/proc` 扫描兜底。
///
/// 所有动态值均通过 [`sh_quote`] 安全转义，防止 shell 注入。
#[cfg(unix)]
pub fn wrap_agent_with_cwd(
    agent_cmd: &str,
    agent_args: &[String],
    workspace: &Path,
    pid_file: Option<&Path>,
) -> Vec<String> {
    let mut script = format!("cd {} && ", sh_quote(&workspace.to_string_lossy()));
    if let Some(f) = pid_file {
        script.push_str(&format!("echo $$ > {} && ", sh_quote(&f.to_string_lossy())));
    }
    script.push_str(&format!("exec {}", sh_quote(agent_cmd)));
    // 用 fold 避免预分配：每个 arg 单独 sh_quote，空格分隔拼入 shell 脚本
    let shell_script = agent_args.iter().fold(script, |acc, arg| acc + " " + &sh_quote(arg));
    vec!["-c".to_string(), shell_script]
}

// ---------------------------------------------------------------------------
// /proc 兜底扫描（仅 Linux；主路径是上面的 pid 自报文件）
// ---------------------------------------------------------------------------

/// 快照 omniterm 自身全部直接子进程 pid。
///
/// `/proc/self/task/*/children` 每线程一份（fork/posix_spawn 的父线程视角），
/// 跨线程汇总去重才是完整集合。spawn 前取一次、连接建成后取一次，diff 出的
/// 新增 pid 即候选 agent（crate 在 `connect_with` 内部才真正 spawn 子进程，
/// 故「前」快照必须紧贴 spawn 点取）。
#[cfg(all(unix, target_os = "linux"))]
pub fn snapshot_direct_children() -> HashSet<u32> {
    let mut set = HashSet::new();
    let Ok(entries) = std::fs::read_dir("/proc/self/task") else {
        return set;
    };
    for entry in entries.flatten() {
        if let Ok(content) = std::fs::read_to_string(entry.path().join("children")) {
            for pid in content.split_whitespace() {
                if let Ok(pid) = pid.parse::<u32>() {
                    set.insert(pid);
                }
            }
        }
    }
    set
}

/// 连接建成后捕获 agent pid（D1）：主路径读 wrapper 自报文件（平台无关，
/// POSIX `echo $$` + 读文件）；缺失/非法时（workspace 不可用致 `cd` 失败等）
/// 回退 spawn 前后直接子进程 diff——**仅 Linux 可用**（`/proc` 专属），非
/// Linux Unix（macOS）无自报即放弃。两者都失败返回 `None`——调用方降级为
/// 仅 signal（修复前现状），失败原因已 WARN。
#[cfg(unix)]
pub fn capture_agent_pid(
    pid_file: &Path,
    children_before: &HashSet<u32>,
    workspace: &Path,
) -> Option<u32> {
    if let Some(pid) = read_and_clear_pid_file(pid_file) {
        return Some(pid);
    }
    tracing::debug!("ACP pid 自报文件缺失或非法，回退直接子进程扫描");
    // 兜底扫描分平台：/proc diff 是 Linux 专属，与 kill_agent_process_group
    // 的非 Linux Unix 分支同口径——无自报即放弃，由调用方 WARN 降级为仅信号。
    #[cfg(target_os = "linux")]
    let fallback = resolve_child_pid(children_before, workspace);
    #[cfg(not(target_os = "linux"))]
    let fallback = {
        let _ = (children_before, workspace);
        tracing::warn!("非 Linux Unix 无 /proc 直接子进程扫描且 pid 自报缺失，放弃 pid 捕获");
        None
    };
    fallback
}

/// spawn 前后 diff 直接子进程，取本次 spawn 的 agent pid。决策逻辑见
/// [`select_new_child_pid`]（与 /proc 读取分离以便确定性单测）。
#[cfg(all(unix, target_os = "linux"))]
pub fn resolve_child_pid(children_before: &HashSet<u32>, workspace: &Path) -> Option<u32> {
    let new_pids: Vec<u32> =
        snapshot_direct_children().difference(children_before).copied().collect();
    select_new_child_pid(&new_pids, workspace)
}

/// 从 diff 出的新增 pid 中选出本次 spawn 的 agent：
///
/// 单个新 pid 直接返回；多个（restore + create + 探针并发 spawn）按
/// `/proc/<pid>/cwd` 匹配 workspace 消歧；仍不唯一或为空则放弃（`None`）——
/// 误杀风险不可接受，宁缺勿滥（降级路径由调用方 WARN 兜底）。
///
/// 单独成函数的原因：空集/单元素快路径若以「spawn 一个子进程再断言独占」的
/// 集成形态测试，隐含假设「测试期间同一二进制内无任何其它用例 spawn 子进程」，
/// 而套件并未提供该保证（实测与 control_mode 假 tmux 客户端测试并发时 diff
/// 集合被污染而偶发红灯）。决策逻辑纯化后可对伪造 pid 列表做确定性断言。
#[cfg(all(unix, target_os = "linux"))]
fn select_new_child_pid(new_pids: &[u32], workspace: &Path) -> Option<u32> {
    if new_pids.is_empty() {
        tracing::warn!("spawn 前后直接子进程 diff 为空，agent pid 捕获失败");
        return None;
    }
    if new_pids.len() == 1 {
        return Some(new_pids[0]);
    }
    let canon_ws = workspace.canonicalize().ok();
    let matched: Vec<u32> = new_pids
        .iter()
        .copied()
        .filter(|pid| {
            let Ok(cwd) = std::fs::read_link(format!("/proc/{pid}/cwd")) else {
                return false;
            };
            canon_ws.as_ref() == Some(&cwd) || *workspace == cwd
        })
        .collect();
    match matched.as_slice() {
        [pid] => Some(*pid),
        [] => {
            tracing::warn!(
                ?new_pids,
                "多个新直接子进程且无一 cwd 匹配 workspace，pid 归属不确定，放弃捕获"
            );
            None
        }
        _ => {
            tracing::warn!(
                ?matched,
                "多个新直接子进程 cwd 均匹配 workspace，pid 归属不确定，放弃捕获"
            );
            None
        }
    }
}

// ---------------------------------------------------------------------------
// 进程组击杀（D2）
// ---------------------------------------------------------------------------

/// pid 是否仍是 omniterm 的直接子进程（ppid == 本进程）。
/// agent 经 `exec` 后同 pid 仍是直接子进程；已退出并被 reap 后读不到 → false。
///
/// ppid 读取走 [`crate::process_identity`] 共享真源（AGENTS 工程准则 7①：与
/// tmux 控制客户端登记表对账、pidfile kill 校验同型「防 PID 复用误杀」判断，
/// 勿再各自解析 `/proc/<pid>/stat`）。
#[cfg(all(unix, target_os = "linux"))]
fn is_direct_child(pid: u32) -> bool {
    crate::process_identity::process_identity(pid)
        .is_some_and(|ident| ident.ppid == std::process::id())
}

/// 进程是否仍存活（僵尸也算存活——未被收割前 pid 还在）。
/// EPERM 表示进程存在但无权限发信号，同样视为存活。
#[cfg(all(unix, target_os = "linux"))]
fn pid_alive(pid: u32) -> bool {
    crate::process_identity::pid_alive(pid)
}

/// 进程组是否仍有成员（`kill(-pgid, 0)`：ESRCH = 组已空）。
#[cfg(all(unix, target_os = "linux"))]
fn process_group_alive(pgid: u32) -> bool {
    let r = unsafe { libc::kill(-(pgid as i32), 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// killpg 前的归属校验，防 pid 复用误杀：
///
/// 1. pid 仍是直接子进程（含僵尸）→ 就是我们的 agent（`exec` 后同 pid）；
/// 2. 直接子进程已退出（wrapper launcher 场景：`npx` leader 退而真 agent 孙
///    进程仍持有继承的 stdio）→ 只要进程组仍非空就 killpg——crate 的
///    `ChildGuard::drop` 同样无条件 killpg；残余风险（旧组空后 pid 复用进
///    新组）与 crate 同口径，接受；
/// 3. pid 活着但已不是直接子进程 → pid 被复用，跳过（WARN 由调用方记）。
#[cfg(all(unix, target_os = "linux"))]
fn should_kill_group(pid: u32) -> bool {
    is_direct_child(pid) || (!pid_alive(pid) && process_group_alive(pid))
}

/// 对 agent 进程组发 SIGKILL（D2）。`pid` 为 `None`（D1 降级路径）时记 WARN
/// 并返回——退化为仅 signal（= 修复前现状），不静默。
///
/// kill 使 crate 内部 pidfd 等待路径的 `try_wait` 立即返回退出状态，从根上
/// 打破连接 poll 空转（2026-09-21 CPU 尖峰止血，见模块文档）。与 crate
/// `ChildGuard::drop` 的 killpg 重复执行无副作用（`ESRCH` 忽略）→ 幂等。
pub fn kill_agent_process_group(pid: Option<u32>) {
    #[cfg(unix)]
    {
        let Some(pid) = pid else {
            tracing::warn!(
                "ACP agent pid 未捕获（D1 降级路径）：仅发送优雅关闭信号，agent 进程组可能残留"
            );
            return;
        };
        #[cfg(target_os = "linux")]
        if !should_kill_group(pid) {
            tracing::warn!(
                pid,
                "agent pid 归属校验未通过（已退出且组空 / pid 可能被复用），跳过进程组击杀"
            );
            return;
        }
        // 负 pid = killpg：crate spawn_process 已把 agent（wrapper sh）设为独立
        // 进程组 leader（process_group(0)）。非 Linux Unix 无 /proc 归属校验，
        // 与 crate ChildGuard::drop 同口径直接 killpg。
        let r = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        if r != 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::ESRCH) {
                tracing::warn!(pid, error = %err, "killpg agent 进程组失败");
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        tracing::warn!(
            "非 Unix 平台无进程组语义：agent 进程组击杀不可用，仅发送优雅关闭信号（进程可能残留）"
        );
    }
}

/// 串行化「spawn 子进程 + /proc diff」类测试的进程级互斥锁：cargo test 同一
/// 二进制内多线程并行，别的用例 spawn 的子进程会污染 diff 集合（并发归属本就是
/// 生产风险点，测试里必须先排除）。crate 内测试模块共用（`agent_proc::tests`
/// 与 `fake_agent_tests` 的 agent spawn 互相污染）。
///
/// 用 tokio Mutex：async 测试（`fake_agent_tests`）需要跨 await 持有本锁，
/// std Mutex 的 guard 跨 await 持有可能取消不安全且触发 clippy
/// `await_holding_lock`。poisoned 时取回 inner 继续跑，不让一个用例的 panic
/// 拖垮后续全部。
#[cfg(all(test, target_os = "linux"))]
static SPAWN_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 同步测试上下文取锁（`agent_proc::tests` 的 `#[test]` 用例）。
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn spawn_test_lock() -> tokio::sync::MutexGuard<'static, ()> {
    SPAWN_TEST_LOCK.blocking_lock()
}

/// async 测试上下文取锁（`fake_agent_tests` 的 `#[tokio::test]` 用例）。
#[cfg(all(test, target_os = "linux"))]
pub(crate) async fn spawn_test_lock_async() -> tokio::sync::MutexGuard<'static, ()> {
    SPAWN_TEST_LOCK.lock().await
}

#[cfg(all(test, unix))]
mod tests {
    use super::spawn_test_lock;
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "omniterm-agent-proc-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create unique test dir");
        dir
    }

    // ── sh_quote：POSIX shell 单引号转义 ────────────────────────────────

    #[test]
    fn sh_quote_empty_string() {
        assert_eq!(sh_quote(""), "''");
    }

    #[test]
    fn sh_quote_plain_path() {
        assert_eq!(sh_quote("/home/user/project"), "'/home/user/project'");
    }

    #[test]
    fn sh_quote_no_special_chars_passes_through() {
        // 不含单引号 → 直接单引号包裹
        assert_eq!(sh_quote("hello world"), "'hello world'");
        assert_eq!(sh_quote("--acp"), "'--acp'");
    }

    #[test]
    fn sh_quote_with_single_quote_splits_segments() {
        // POSIX 转义规则：'foo'bar' → 'foo'\''bar'
        assert_eq!(sh_quote("foo'bar"), "'foo'\\''bar'");
    }

    #[test]
    fn sh_quote_only_single_quote() {
        // 极端情况：只有单引号
        // 实现逻辑：开单引号 → 对 `'` 字符插入 '然后转义'再开单引号 → 关单引号
        // 输入 `'` → `' '' \' '' '` 收敛为 `''\'''`
        // shell 解析：`''`(空) + `\'` (literal `'`) + `''`(空) = `'` ✓
        assert_eq!(sh_quote("'"), "''\\'''");
    }

    #[test]
    fn sh_quote_does_not_inject_shell_metacharacters() {
        // 含 `;` `&&` `$()` 都不应让 sh 误解析：单引号包裹下全部字面化
        let dangerous = "a; rm -rf /; $(echo bad); `id`";
        let quoted = sh_quote(dangerous);
        assert_eq!(quoted, format!("'{dangerous}'"));
    }

    // ── wrap_agent_with_cwd：shell wrapper 构造 ─────────────────────────

    #[test]
    fn wrap_returns_cd_then_exec_form() {
        let args = wrap_agent_with_cwd(
            "codebuddy",
            &["--acp".into()],
            Path::new("/home/user/project"),
            None,
        );
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], "-c");
        // cd 必须是 cd '/home/user/project' && exec 'codebuddy' '--acp'
        assert_eq!(args[1], "cd '/home/user/project' && exec 'codebuddy' '--acp'");
    }

    #[test]
    fn wrap_escapes_workspace_with_spaces_and_quotes() {
        let workspace = Path::new("/home/user/it's a 'project'");
        let args = wrap_agent_with_cwd("agent", &[], workspace, None);
        // workspace 路径里同时含空格和单引号，单引号必须被 '\\'' 分段转义
        assert!(args[1].contains("'/home/user/it'\\''s a '\\''project'\\'''"));
    }

    #[test]
    fn wrap_with_no_args_emits_cd_exec_only() {
        let args = wrap_agent_with_cwd("/usr/bin/myagent", &[], Path::new("/tmp"), None);
        assert_eq!(args[1], "cd '/tmp' && exec '/usr/bin/myagent'");
    }

    #[test]
    fn wrap_with_pid_file_inserts_echo_before_exec() {
        let args = wrap_agent_with_cwd(
            "codebuddy",
            &["--acp".into()],
            Path::new("/home/user/project"),
            Some(Path::new("/tmp/omniterm-acp-x.pid")),
        );
        // pid 自报必须夹在 cd 与 exec 之间：cd 失败（workspace 不可用）时不写
        assert_eq!(
            args[1],
            "cd '/home/user/project' && echo $$ > '/tmp/omniterm-acp-x.pid' && exec 'codebuddy' '--acp'"
        );
    }

    // ── pid 自报文件：有界读写 + 读后即删 ──────────────────────────────

    #[test]
    fn pid_file_roundtrip_reads_and_removes() {
        let dir = unique_dir("pidfile");
        let path = dir.join("agent.pid");
        std::fs::write(&path, "123456\n").expect("write pid file");
        assert_eq!(read_and_clear_pid_file(&path), Some(123456));
        assert!(!path.exists(), "读取后必须删除，否则 /tmp 累积");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pid_file_garbage_or_missing_yields_none() {
        let dir = unique_dir("pidfile-bad");
        let path = dir.join("agent.pid");
        std::fs::write(&path, "not-a-pid").expect("write garbage");
        assert_eq!(read_and_clear_pid_file(&path), None);
        assert!(!path.exists(), "内容非法也要删除");
        assert_eq!(read_and_clear_pid_file(&path), None, "文件已不存在 → None");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 端到端：wrapper 自报的 pid 必须等于 exec 后的 agent pid ─────────

    /// `echo $$` 写在 `exec` 之前：wrapper sh 的 pid 即 exec 后 agent 的 pid，
    /// 也正是 crate 设的进程组 leader pid（D2 killpg 的目标）。
    #[tokio::test]
    async fn wrapped_subprocess_reports_own_pid_via_file() {
        let dir = unique_dir("pidreport");
        let workspace = dir.join("ws");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        let pid_file = dir.join("agent.pid");

        let wrapped = wrap_agent_with_cwd("pwd", &[], &workspace, Some(&pid_file));
        let mut child = Command::new("/bin/sh")
            .args(&wrapped)
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn wrapped sh");
        let status = child.wait().expect("wait wrapped sh");
        assert!(status.success(), "wrapped sh 应正常退出: {status:?}");

        let reported = read_and_clear_pid_file(&pid_file).expect("wrapper 应自报 pid");
        assert_eq!(reported, child.id(), "自报 pid 必须等于 wrapper（= exec 后 agent）pid");
        assert!(reported > 1 && reported != std::process::id());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端回归（从 client.rs 随 wrapper 一起迁入）：spawn 出的子进程 cwd
    /// 必须等于 session workspace——`/proc/<pid>/cwd` 行为，单测字符串拼接
    /// 覆盖不到。
    #[tokio::test]
    async fn wrapped_subprocess_has_session_workspace_as_cwd() {
        let workspace = unique_dir("cwd");
        let workspace_str = workspace.to_string_lossy().to_string();

        let wrapped = wrap_agent_with_cwd("pwd", &[], &workspace, None);
        let output = Command::new("/bin/sh")
            .args(&wrapped)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .expect("spawn sh");
        assert!(
            output.status.success(),
            "sh exited with {}: stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        assert_eq!(
            stdout, workspace_str,
            "subprocess cwd was {stdout:?}, expected {workspace_str:?} — wrap_agent_with_cwd \
             is not actually changing the OS cwd. This is the regression \
             the fix targets: agent-client-protocol's AcpAgent::spawn_process \
             does NOT call Command::current_dir, so the spawned agent runs \
             in the backend's cwd rather than the session's workspace_path."
        );
        let _ = std::fs::remove_dir_all(&workspace);
    }

    /// workspace 路径含空格的端到端：`cd` 仍能正确切换。
    #[tokio::test]
    async fn wrapped_subprocess_workspaces_with_spaces() {
        let parent = std::env::temp_dir();
        let workspace = parent.join(format!(
            "omniterm cwd test {}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&workspace).expect("create temp workspace with space");
        let workspace_str = workspace.to_string_lossy().to_string();
        assert!(
            workspace_str.contains(' '),
            "test setup must use a workspace with spaces; got {workspace_str}"
        );

        let wrapped = wrap_agent_with_cwd("pwd", &[], &workspace, None);
        let output = Command::new("/bin/sh")
            .args(&wrapped)
            .stdout(Stdio::piped())
            .output()
            .expect("spawn sh");
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        assert_eq!(
            stdout, workspace_str,
            "subprocess cwd with spaces-in-path didn't survive sh -c wrap"
        );
        let _ = std::fs::remove_dir_all(&workspace);
    }

    /// 验证 exec 替换 shell：子进程正常退出、无残留 shell 进程。
    #[tokio::test]
    async fn wrapped_subprocess_exits_normally() {
        let workspace = std::env::temp_dir().join("omniterm-exec-test");
        let _ = std::fs::create_dir_all(&workspace);

        let wrapped = wrap_agent_with_cwd("true", &[], &workspace, None);
        let output = Command::new("/bin/sh").args(&wrapped).output().expect("spawn sh");
        assert!(output.status.success(), "wrapped exit != 0");

        let _ = std::fs::remove_dir_all(&workspace);
    }

    // ── /proc 扫描兜底（仅 Linux）────────────────────────────────────────

    #[cfg(target_os = "linux")]
    fn wait_until_dead(pid: u32, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if !pid_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        !pid_alive(pid)
    }

    #[cfg(target_os = "linux")]
    fn wait_until_registered(pid: u32) -> bool {
        for _ in 0..100 {
            if snapshot_direct_children().contains(&pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn snapshot_direct_children_includes_spawned_child() {
        let _guard = spawn_test_lock();
        let before = snapshot_direct_children();
        let mut child = Command::new("sleep").arg("5").spawn().expect("spawn sleep");
        assert!(
            wait_until_registered(child.id()),
            "spawn 出的子进程应出现在 /proc/self/task/*/children"
        );
        assert!(!before.contains(&child.id()));
        let _ = child.kill();
        let _ = child.wait();
    }

    /// 快路径（单个新 pid 直接归属）：纯决策单测，不 spawn、不依赖进程全局
    /// 互斥——原 `resolve_child_pid_single_new_child` 集成形态隐含「测试期间
    /// 全二进制无人 spawn 子进程」的假设，实测与 control_mode 假 tmux 客户端
    /// 测试并发时 diff 集合被污染（≥2 个新 pid 且无一 cwd 匹配 temp_dir）
    /// 而偶发红灯（2026-09-22 v0.2.24 发版 CI）。单元素分支不读 /proc，
    /// 伪造 pid 即可确定性断言。
    #[cfg(target_os = "linux")]
    #[test]
    fn select_single_new_pid_fast_path() {
        assert_eq!(select_new_child_pid(&[424242], &std::env::temp_dir()), Some(424242));
    }

    /// 空 diff → 放弃（宁缺勿滥）：同上，纯决策单测替代集成形态
    /// （原 `resolve_child_pid_no_new_child_yields_none` 的快照窗口内任何
    /// 并发 spawn 都会把它打红）。
    #[cfg(target_os = "linux")]
    #[test]
    fn select_empty_new_pids_yields_none() {
        assert_eq!(select_new_child_pid(&[], &std::env::temp_dir()), None);
    }

    /// 端到端（snapshot + diff + 选择）：断言「能找回本次 spawn 的子进程」
    /// 而非「集合里只有它」。子进程落在唯一 cwd 目录下，即使其它用例并发
    /// spawn 污染 diff 集合，也无论走单元素快路径还是 cwd 消歧路径，结果
    /// 都确定是本子进程——对污染免疫，不再依赖全局互斥。
    #[cfg(target_os = "linux")]
    #[test]
    fn resolve_child_pid_finds_spawned_child_among_strangers() {
        let dir = unique_dir("resolve-single");
        let before = snapshot_direct_children();
        let mut child =
            Command::new("sleep").arg("5").current_dir(&dir).spawn().expect("spawn sleep");
        assert!(wait_until_registered(child.id()));
        let resolved = resolve_child_pid(&before, &dir).expect("应归属到本子进程");
        assert_eq!(resolved, child.id());
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn resolve_child_pid_disambiguates_concurrent_spawns_by_cwd() {
        let _guard = spawn_test_lock();
        let dir_a = unique_dir("cwd-a");
        let dir_b = unique_dir("cwd-b");
        let before = snapshot_direct_children();
        let mut a = Command::new("sleep").arg("5").current_dir(&dir_a).spawn().expect("spawn a");
        let mut b = Command::new("sleep").arg("5").current_dir(&dir_b).spawn().expect("spawn b");
        assert!(wait_until_registered(a.id()) && wait_until_registered(b.id()));
        let resolved =
            resolve_child_pid(&before, &dir_a).expect("应按 cwd 匹配到 a，而非放弃或误取 b");
        assert_eq!(resolved, a.id());
        for c in [&mut a, &mut b] {
            let _ = c.kill();
            let _ = c.wait();
        }
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
    }

    // ── 进程组击杀（D2）────────────────────────────────────────────────

    #[cfg(target_os = "linux")]
    #[test]
    fn kill_agent_process_group_kills_child_and_is_idempotent() {
        let _guard = spawn_test_lock();
        use std::os::unix::process::CommandExt;
        let mut child = Command::new("sleep")
            .arg("30")
            .process_group(0) // 复刻 crate spawn_process 的 process_group(0)
            .spawn()
            .expect("spawn sleep");

        kill_agent_process_group(Some(child.id()));
        // 注意：直接子进程被杀后先变僵尸（未被 reap 前 kill(pid,0) 仍成功），
        // 故用 try_wait 收割判定死亡，而非 pid_alive。
        let mut reaped = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            if child.try_wait().expect("try_wait").is_some() {
                reaped = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(reaped, "killpg 应击杀直接子进程");
        // 幂等：再杀一次（含 crate ChildGuard::drop 的重复 killpg）无副作用
        kill_agent_process_group(Some(child.id()));
        let _ = child.wait();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn kill_agent_process_group_reaches_grandchild_after_leader_exit() {
        // wrapper launcher 场景（npx → node）：直接子进程（leader）已退出被
        // reap，真 agent（孙进程）仍持有继承的 stdio 活在同进程组。此时
        // is_direct_child 为假，但 killpg 必须仍然生效——crate 的
        // ChildGuard::drop 同样无条件 killpg。
        let _guard = spawn_test_lock();
        use std::os::unix::process::CommandExt;
        let dir = unique_dir("grandchild");
        let pid_file = dir.join("grandchild.pid");

        let script =
            format!("sleep 30 & echo $! > {} ; exit 0", sh_quote(&pid_file.to_string_lossy()));
        let mut sh = Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .process_group(0)
            .spawn()
            .expect("spawn wrapper sh");
        let leader = sh.id();
        let status = sh.wait().expect("wait wrapper sh");
        assert!(status.success(), "wrapper 应正常退出: {status:?}");

        let grandchild: u32 = std::fs::read_to_string(&pid_file)
            .expect("wrapper 应留下孙进程 pid")
            .trim()
            .parse()
            .expect("孙进程 pid 应可解析");
        assert_ne!(grandchild, leader);
        assert!(pid_alive(grandchild), "孙进程应仍在（同进程组，未单独杀）");
        assert!(!is_direct_child(leader), "leader 已被 reap，不再是直接子进程");
        assert!(should_kill_group(leader), "leader 退但组非空 → 应 killpg");

        kill_agent_process_group(Some(leader));
        assert!(
            wait_until_dead(grandchild, Duration::from_secs(2)),
            "killpg 必须带走 leader 退出后残留的孙进程"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn should_kill_group_rejects_dead_reaped_pid() {
        let _guard = spawn_test_lock();
        use std::os::unix::process::CommandExt;
        let mut child = Command::new("true").process_group(0).spawn().expect("spawn true");
        let dead = child.id();
        child.wait().expect("reap true"); // reap 后 /proc/<pid> 消失、组已空
        assert!(!pid_alive(dead));
        assert!(!should_kill_group(dead), "组已空的死 pid 不应杀（pid 复用防护）");
        kill_agent_process_group(Some(dead)); // no-op，不 panic
    }

    #[test]
    fn kill_agent_process_group_none_pid_is_noop() {
        // D1 降级路径：pid 缺失时只 WARN 不杀（测试内不断言日志，仅验证不 panic）
        kill_agent_process_group(None);
    }
}
