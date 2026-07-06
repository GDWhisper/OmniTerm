use crate::tmux::agent_hooks;
use crate::tmux::agent_state::AgentKind;

/// Read a process's command line and match against known agent CLIs.
///
/// Returns `None` if the process doesn't exist, can't be read, or doesn't match.
pub fn read_process_cmdline(pid: u32) -> Option<AgentKind> {
    read_cmdline_impl(pid).and_then(|cmdline| agent_hooks::detect_agent_kind(cmdline.trim()))
}

/// Walk the process tree from `pid` looking for agent processes.
///
/// Checks the process itself and its descendants up to a platform-appropriate depth.
pub fn walk_process_tree(pid: u32) -> Option<AgentKind> {
    if let Some(kind) = read_process_cmdline(pid) {
        return Some(kind);
    }
    walk_children(pid, 1)
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::fs;

    pub(super) fn read_cmdline_impl(pid: u32) -> Option<String> {
        let cmdline_path = format!("/proc/{}/cmdline", pid);
        let content = fs::read_to_string(cmdline_path).ok()?;
        if content.is_empty() {
            return None;
        }
        Some(content.replace('\0', " "))
    }

    pub(super) fn walk_children(pid: u32, max_depth: u32) -> Option<AgentKind> {
        if max_depth == 0 {
            return None;
        }

        let children_path = format!("/proc/{}/task/{}/children", pid, pid);
        let children_str = fs::read_to_string(children_path).ok()?;
        for child_pid_str in children_str.split_whitespace() {
            if let Ok(child_pid) = child_pid_str.parse::<u32>() {
                if let Some(kind) = read_process_cmdline(child_pid) {
                    return Some(kind);
                }
                if let Some(kind) = walk_children(child_pid, max_depth - 1) {
                    return Some(kind);
                }
            }
        }

        None
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use sysinfo::{Pid, System};

    pub(super) fn read_cmdline_impl(pid: u32) -> Option<String> {
        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let process = sys.process(Pid::from_u32(pid))?;
        let cmdline = process.cmd().to_string_lossy().into_owned();
        if cmdline.is_empty() {
            None
        } else {
            Some(cmdline)
        }
    }

    pub(super) fn walk_children(pid: u32, max_depth: u32) -> Option<AgentKind> {
        if max_depth == 0 {
            return None;
        }

        let mut sys = System::new();
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

        let children: Vec<u32> = sys
            .processes()
            .iter()
            .filter_map(|(p_pid, proc)| {
                if proc.parent().map(|pp| pp.as_u32()) == Some(pid) {
                    Some(p_pid.as_u32())
                } else {
                    None
                }
            })
            .collect();

        for child_pid in children {
            if let Some(kind) = read_process_cmdline(child_pid) {
                return Some(kind);
            }
            if let Some(kind) = walk_children(child_pid, max_depth - 1) {
                return Some(kind);
            }
        }

        None
    }
}

use platform::{read_cmdline_impl, walk_children};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_process_cmdline_current_process() {
        let current_pid = std::process::id();
        let result = read_process_cmdline(current_pid);
        assert!(result.is_none(), "current process should not be detected as agent");
    }

    #[test]
    fn test_read_process_cmdline_invalid_pid() {
        let result = read_process_cmdline(u32::MAX);
        assert!(result.is_none(), "invalid PID should return None");
    }

    #[test]
    fn test_walk_process_tree_current_process() {
        let current_pid = std::process::id();
        let result = walk_process_tree(current_pid);
        assert!(result.is_none(), "current process tree should not be detected as agent");
    }

    #[test]
    fn test_read_process_cmdline_matches_claude() {
        assert_eq!(
            agent_hooks::detect_agent_kind("/usr/local/bin/claude"),
            Some(AgentKind::Claude)
        );
        assert_eq!(
            agent_hooks::detect_agent_kind("claude --dangerously-skip-permissions"),
            Some(AgentKind::Claude)
        );
        assert_eq!(
            agent_hooks::detect_agent_kind("codex"),
            Some(AgentKind::Codex)
        );
    }

    #[test]
    fn test_read_process_cmdline_sleep_not_agent() {
        assert_eq!(agent_hooks::detect_agent_kind("sleep 30"), None);
        assert_eq!(agent_hooks::detect_agent_kind("bash"), None);
        assert_eq!(agent_hooks::detect_agent_kind("zsh"), None);
        assert_eq!(agent_hooks::detect_agent_kind("vim"), None);
        assert_eq!(agent_hooks::detect_agent_kind("ls -la"), None);
    }

    #[cfg(unix)]
    #[test]
    fn test_read_process_cmdline_handles_null_bytes() {
        let simulated_cmdline = "claude\0--dangerously-skip-permissions\0";
        let cmdline = simulated_cmdline.replace('\0', " ");
        assert_eq!(
            agent_hooks::detect_agent_kind(cmdline.trim()),
            Some(AgentKind::Claude)
        );
    }
}
