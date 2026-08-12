//! pty 会话工作目录采样（`pane_current_path` 的自管等价）。
//!
//! 多实现差异（计划 §4）：Linux 走 `/proc/<pid>/cwd`；macOS 需 libproc
//! （切片 C 引入）；Windows 无可靠等价 → 返回 None，调用方回退
//! workspace_path / DB `last_cwd`。

/// 进程当前工作目录（OS 真相，见 integration-checklist §A.1）。
#[cfg(target_os = "linux")]
pub fn process_cwd(pid: u32) -> Option<std::path::PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
}

#[cfg(not(target_os = "linux"))]
pub fn process_cwd(_pid: u32) -> Option<std::path::PathBuf> {
    None
}

/// 会话当前工作目录：优先前台进程（用户 `cd` 后的 shell/程序），
/// 回退会话 shell 本身。`shell_pid` 为 spawn 时记录的 child pid。
#[cfg(unix)]
pub fn session_cwd(shell_pid: Option<u32>) -> Option<std::path::PathBuf> {
    let shell_pid = shell_pid?;
    if let Some(fg) = crate::agent::process::foreground_pid(shell_pid)
        && let Some(cwd) = process_cwd(fg)
    {
        return Some(cwd);
    }
    process_cwd(shell_pid)
}

#[cfg(not(unix))]
pub fn session_cwd(_shell_pid: Option<u32>) -> Option<std::path::PathBuf> {
    None
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn process_cwd_matches_self() {
        let cwd = process_cwd(std::process::id());
        assert_eq!(cwd, Some(std::env::current_dir().unwrap()));
    }

    #[test]
    fn process_cwd_none_for_dead_pid() {
        // pid 0 非法 / 不存在进程的 cwd 采样必须 None 而不是 panic
        assert_eq!(process_cwd(u32::MAX), None);
    }
}
