//! 进程身份真源：kill 前确认「目标还是不是当年那个进程」的共享谓词件
//! （AGENTS 工程准则 7①——同型「防 PID 复用误杀」校验 ≥2 处必须单一真源）。
//!
//! 消费方：ACP agent 进程组击杀（`acp/agent_proc.rs::should_kill_group`）、
//! tmux 控制客户端登记表启动对账（`engine/tmux/client_registry.rs`）、
//! pidfile kill 归属校验（`main.rs` `Stop` / `dev.sh` 镜像实现）、孤儿堆积
//! 监控（`health/orphan.rs`）。背景事故见
//! `docs/dev/plans/2026-09-22-tmux-server-shutdown-hang.md` §3.2 的 PID 复用盲区。
//!
//! 身份 = `(pid, ppid, start_key, argv)` 四元组：
//! - **argv 结构化相等**（逐元素前缀比较 [`argv_has_prefix`]），拒绝子串匹配——
//!   子串匹配会把 `vim 'tmux -C.md'` 之类误判成 tmux 控制客户端；
//! - **start_key** 来自 `/proc/<pid>/stat` starttime（内核启动时刻计数，PID 复用
//!   检测的硬标识）；`pid` 相同但 `start_key` 变了 ⇒ 不是当年那个进程；
//! - **ppid 变化**（≠ spawn 时记录值）即孤儿判据——**不用「PPID=1」**：孤儿可能
//!   被 subreaper 收养而非 init（2026-09-22 计划 P0-2 谓词）。
//!
//! 多实现/平台差异（AGENTS 工程准则 8）：
//! | 平台 | 身份来源 | 备注 |
//! |------|----------|------|
//! | Linux | `/proc/<pid>/stat` + `/proc/<pid>/cmdline` | 实测口径（2026-09-22） |
//! | 其余 Unix（macOS） | `ps -o pid=,ppid=,lstart=,args=` 回退 | 解析纯函数有单测；**macOS 未实测**，`args=` 丢失 argv 边界（按空白切分的弱匹配） |
//! | Windows | `sysinfo` 进程表 | `start_time` 秒级；**未实测**（发版 job 只保证编译） |
//!
//! kill 通道 [`kill_pid`]：Linux 走 `pidfd_open` + `pidfd_send_signal`（内核级
//! 免疫 PID 复用，收口 check-then-kill 的 TOCTOU）；内核过旧（<5.3 无 pidfd）
//! 及其余 Unix 回退 `kill(2)` + 事前谓词复查。

/// 一次进程身份快照（见模块文档）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// 父进程 pid（`/proc/<pid>/stat` 第 4 字段 / `ps` ppid）。
    pub ppid: u32,
    /// 启动时刻标识（Linux = stat starttime tick；ps 回退 = lstart 文本；Windows =
    /// `sysinfo` start_time 秒）。同一 pid 复用后此值必变，是比较相等性的硬标识。
    pub start_key: String,
    /// NUL 切分的 argv（元素 0 为调用方写入的 argv[0]，非内核 exe 路径）。
    pub argv: Vec<String>,
}

/// 读取 `pid` 的身份快照。进程不存在 / 无权限 / 平台无回退时返回 `None`。
pub fn process_identity(pid: u32) -> Option<ProcessIdentity> {
    platform::identity_impl(pid)
}

/// argv 结构化前缀相等：`argv[0..prefix.len()]` 逐元素 `==`。
///
/// 拒绝子串/正则匹配：`["tmux", "-C"]` 只命中真 `tmux -C …`，不命中
/// `vim 'tmux -C.md'`、`echo tmux -C` 等 argv 恰好含该词组的进程。
pub fn argv_has_prefix(argv: &[String], prefix: &[&str]) -> bool {
    argv.len() >= prefix.len() && prefix.iter().enumerate().all(|(i, want)| &argv[i] == want)
}

/// `argv[0]` 的文件名部分（`/usr/bin/omniterm` → `omniterm`；Windows 剥 `.exe`）。
#[allow(dead_code)] // 待接线：P1-3 pidfile kill 归属校验（见 docs/dev/plans/backlog/dead-code-triage.md）
pub fn argv0_basename(argv: &[String]) -> Option<&str> {
    let argv0 = argv.first()?;
    let base = argv0.rsplit(['/', '\\']).next().unwrap_or(argv0);
    Some(base.strip_suffix(".exe").unwrap_or(base))
}

/// 进程是否仍存活（僵尸也算存活——未被收割前 pid 还在）。EPERM = 存在但无权限。
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
pub fn pid_alive(pid: u32) -> bool {
    platform::identity_impl(pid).is_some()
}

/// 对 `pid` 发信号：Linux 走 pidfd（免疫 PID 复用），其余回退 `kill(2)`。
///
/// 调用方必须**先过归属谓词**再 kill——pidfd 只保证「信号打到内核认定的同一个
/// 进程」，不保证「那个进程是你以为的目标」。
#[cfg(unix)]
pub fn kill_pid(pid: u32, sig: i32) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        // SYS_pidfd_open / SYS_pidfd_send_signal 直接走 syscall：
        // glibc < 2.36 无包装函数，但内核 ≥5.3 即支持，syscall 号 ABI 稳定。
        let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0i32) };
        if pidfd < 0 {
            // 内核过旧（<5.3）：回退 kill(2)，残留 check-then-kill 窗口（谓词复查兜底）。
            return kill_signal(pid, sig);
        }
        let rc = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                pidfd as libc::c_int,
                sig,
                std::ptr::null::<libc::siginfo_t>(),
                0usize,
            )
        };
        let err = std::io::Error::last_os_error();
        unsafe { libc::close(pidfd as libc::c_int) };
        if rc < 0 { Err(err) } else { Ok(()) }
    }
    #[cfg(not(target_os = "linux"))]
    {
        kill_signal(pid, sig)
    }
}

#[cfg(unix)]
fn kill_signal(pid: u32, sig: i32) -> std::io::Result<()> {
    if unsafe { libc::kill(pid as i32, sig) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
pub fn kill_pid(_pid: u32, _sig: i32) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "kill_pid: Windows 无对应回退"))
}

/// SIGKILL 强杀（SIGKILL 常量属 unix 头，平台无关调用方走这里）。
pub fn kill_pid_forced(pid: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        kill_pid(pid, libc::SIGKILL)
    }
    #[cfg(not(unix))]
    {
        kill_pid(pid, 9)
    }
}

// ---------------------------------------------------------------------------
// 平台实现
// ---------------------------------------------------------------------------

/// 解析 `/proc/<pid>/stat` 的 `(ppid, starttime)`。
///
/// 纯函数（单测覆盖）：comm 字段可含空格/括号，先 `rsplit` 到最后一个 `)`，
/// 其后第 1 个字段是 state、第 2 个是 ppid；starttime 是 stat 全序列第 22 字段
/// （= `)` 后第 20 个字段）。
fn parse_stat_identity(stat: &str) -> Option<(u32, String)> {
    let after_comm = stat.rsplit_once(')')?.1;
    let fields: Vec<&str> = after_comm.split_whitespace().collect();
    let ppid = fields.get(1)?.parse::<u32>().ok()?;
    let starttime = (*fields.get(19)?).to_string();
    Some((ppid, starttime))
}

/// 解析 `/proc/<pid>/cmdline` 原始字节为 argv（NUL 分隔，lossy UTF-8）。
fn parse_cmdline_argv(raw: &[u8]) -> Vec<String> {
    raw.split(|&b| b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect()
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    pub fn identity_impl(pid: u32) -> Option<ProcessIdentity> {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let (ppid, start_key) = parse_stat_identity(&stat)?;
        let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
        let argv = parse_cmdline_argv(&raw);
        Some(ProcessIdentity { pid, ppid, start_key, argv })
    }
}

/// `ps -o pid=,ppid=,lstart=,args=` 输出解析（纯函数，单测覆盖）。
///
/// `lstart` 固定 5 个空白分隔字段（如 `Mon Aug 11 09:15:22 2026`），拼回作
/// `start_key`；`args=` 是空白连接的命令行，**丢失 argv 边界**（弱匹配，见模块
/// 文档平台表）。
#[cfg(all(unix, not(target_os = "linux")))]
fn parse_ps_identity(line: &str, pid: u32) -> Option<ProcessIdentity> {
    let mut it = line.split_whitespace();
    let got_pid: u32 = it.next()?.parse().ok()?;
    if got_pid != pid {
        return None;
    }
    let ppid = it.next()?.parse::<u32>().ok()?;
    let start_key: Vec<&str> = (0..5).map_while(|_| it.next()).collect();
    if start_key.len() < 5 {
        return None;
    }
    let argv: Vec<String> = it.map(str::to_string).collect();
    Some(ProcessIdentity { pid, ppid, start_key: start_key.join(" "), argv })
}

#[cfg(all(unix, not(target_os = "linux")))]
mod platform {
    use super::*;

    pub fn identity_impl(pid: u32) -> Option<ProcessIdentity> {
        let out = std::process::Command::new("ps")
            .args(["-o", "pid=,ppid=,lstart=,args=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        parse_ps_identity(&String::from_utf8_lossy(&out.stdout), pid)
    }
}

#[cfg(windows)]
mod platform {
    use super::*;

    /// Windows 经 `sysinfo`（与 `agent/process.rs` 同口径）。未实测。
    pub fn identity_impl(pid: u32) -> Option<ProcessIdentity> {
        use sysinfo::{Pid, System};
        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let process = sys.process(Pid::from_u32(pid))?;
        Some(ProcessIdentity {
            pid,
            ppid: process.parent().map(|pp| pp.as_u32()).unwrap_or(0),
            start_key: process.start_time().to_string(),
            argv: process.cmd().iter().map(|s| s.to_string_lossy().into_owned()).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// comm 含括号/空格时按最后一个 `)` 切分仍取对字段（与 `agent/process.rs`
    /// tpgid 解析同口径的历史坑）。
    #[test]
    fn parse_stat_handles_comm_with_parens_and_spaces() {
        // ')' 后字段：state ppid pgrp session tty tpgid flags minflt cminflt majflt
        // cmajflt utime stime cutime cstime priority nice num_threads itrealvalue
        // starttime vsize rss …（starttime = 第 20 个）
        let stat = "42 (tmux: server) S 7 7 7 0 -1 4194304 1 2 3 4 5 6 7 8 20 0 1 999 \
                    123456 64000000 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0";
        let (ppid, start_key) = parse_stat_identity(stat).expect("should parse");
        assert_eq!(ppid, 7, "ppid 应取 ')' 后第 2 个字段");
        assert_eq!(start_key, "123456", "starttime 应取 ')' 后第 20 个字段");
    }

    #[test]
    fn parse_stat_rejects_malformed() {
        assert!(parse_stat_identity("no parens here").is_none());
        assert!(parse_stat_identity("1 (x) S").is_none(), "字段不足应拒绝");
    }

    #[test]
    fn parse_cmdline_splits_on_nul_and_drops_empty() {
        assert_eq!(
            parse_cmdline_argv(b"tmux\0-C\0attach-session\0"),
            ["tmux", "-C", "attach-session"]
        );
        assert!(parse_cmdline_argv(b"").is_empty(), "僵尸/内核线程 cmdline 为空");
    }

    #[test]
    fn argv_prefix_is_structural_not_substring() {
        let argv: Vec<String> =
            ["tmux", "-C", "attach-session", "-t", "x"].iter().map(|s| s.to_string()).collect();
        assert!(argv_has_prefix(&argv, &["tmux", "-C"]));
        assert!(argv_has_prefix(&argv, &["tmux"]));
        assert!(
            !argv_has_prefix(&argv, &["tmux", "-C", "attach-session", "-t", "y"]),
            "尾元素不等"
        );

        // 子串陷阱：vim 打开名为 `tmux -C.md` 的文件——argv 元素边界不同，必须拒绝
        let vim: Vec<String> = ["vim", "tmux -C.md"].iter().map(|s| s.to_string()).collect();
        assert!(!argv_has_prefix(&vim, &["tmux", "-C"]));
        let echo: Vec<String> = ["echo", "tmux", "-C"].iter().map(|s| s.to_string()).collect();
        assert!(!argv_has_prefix(&echo, &["tmux", "-C"]), "argv[0] 不等，不得命中");
    }

    #[test]
    fn argv0_basename_strips_dirs_and_exe() {
        let p = |s: &str| vec![s.to_string()];
        assert_eq!(argv0_basename(&p("/usr/bin/omniterm")), Some("omniterm"));
        assert_eq!(argv0_basename(&p("C:\\bin\\omniterm.exe")), Some("omniterm"));
        assert_eq!(argv0_basename(&p("omniterm")), Some("omniterm"));
        assert_eq!(argv0_basename(&[]), None);
    }

    /// 真进程自证：自身身份可读，ppid/start_key 非空，argv[0] 以测试二进制名结尾。
    #[test]
    fn identity_of_self_is_readable() {
        let me = process_identity(std::process::id()).expect("自身身份必须可读");
        assert_eq!(me.pid, std::process::id());
        assert!(me.ppid > 0);
        assert!(!me.start_key.is_empty());
        assert!(!me.argv.is_empty());
        assert!(pid_alive(std::process::id()));
        assert!(!pid_alive(0x7fff_ffff), "哨兵 pid 不应存活");
    }

    /// macOS `ps` 回退解析（编译进该平台；本平台编译外，解析逻辑在此留证）。
    #[cfg(all(unix, not(target_os = "linux")))]
    #[test]
    fn parse_ps_identity_splits_lstart_fields() {
        let line = "  42  7 Mon Aug 11 09:15:22 2026 tmux -C attach-session -t x\n";
        let ident = parse_ps_identity(line, 42).expect("should parse");
        assert_eq!(ident.ppid, 7);
        assert_eq!(ident.start_key, "Mon Aug 11 09:15:22 2026");
        assert_eq!(ident.argv, ["tmux", "-C", "attach-session", "-t", "x"]);
    }
}
