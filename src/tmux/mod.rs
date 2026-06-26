pub mod agent_hooks;
pub mod agent_state;
pub mod hooks;

use anyhow::{anyhow, Result};
use std::fs;
use tokio::process::Command;
use tracing::{debug, warn};

use crate::tmux::agent_state::{AgentKind, AgentSnapshot};

/// Create a new detached tmux session with an optional startup command.
///
/// If `command` is provided and detected as a supported agent CLI, the command
/// is augmented with hook configuration flags, the `@omniterm_agent` option is
/// initialized, and the augmented command is sent via `send-keys`.
///
/// Returns whether hooks were injected.
pub async fn new_session(name: &str, cwd: &str, command: Option<&str>) -> Result<bool> {
    use crate::tmux::agent_hooks;

    // 1. Create the tmux session (plain shell)
    let output = Command::new("tmux")
        .args([
            "new-session",
            "-d",
            "-s", name,
            "-c", cwd,
            "-x", "200",
            "-y", "50",
        ])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("tmux new-session failed: {}", stderr));
    }

    // 2. Enable mouse support
    let mouse_out = Command::new("tmux")
        .args(["set-option", "-t", name, "mouse", "on"])
        .output()
        .await?;
    if !mouse_out.status.success() {
        warn!(
            "failed to enable mouse for session {}: {}",
            name,
            String::from_utf8_lossy(&mouse_out.stderr)
        );
    }

    // 3. If an agent command is provided, detect agent, inject hooks, and send command
    let mut hook_injected = false;
    if let Some(cmd) = command {
        if let Some(kind) = agent_hooks::detect_agent_kind(cmd) {
            // Initialize agent option before launching agent
            let initial_value = agent_hooks::initial_agent_option_value(kind);
            let opt_out = Command::new("tmux")
                .args(["set-option", "-t", name, "@omniterm_agent", &initial_value])
                .output()
                .await?;
            if !opt_out.status.success() {
                warn!(
                    "failed to set @omniterm_agent for session {}: {}",
                    name,
                    String::from_utf8_lossy(&opt_out.stderr)
                );
            } else {
                debug!("initialized @omniterm_agent for session {}: {}", name, initial_value);
            }

            // Augment the command with hook configuration
            let augmented = agent_hooks::augment_agent_command(cmd)
                .unwrap_or_else(|| cmd.to_string());

            // Send the augmented command via send-keys
            send_keys(name, &augmented).await?;
            hook_injected = true;
            debug!("sent agent command to session {}: {}", name, augmented);
        } else {
            // Non-agent command — just send it as-is
            send_keys(name, cmd).await?;
        }
    }

    debug!("created tmux session: {} (cwd: {}, hook_injected: {})", name, cwd, hook_injected);
    Ok(hook_injected)
}

/// Kill a tmux session.
pub async fn kill_session(name: &str) -> Result<()> {
    let output = Command::new("tmux")
        .args(["kill-session", "-t", name])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        warn!("tmux kill-session failed: {}", stderr);
    }

    debug!("killed tmux session: {}", name);
    Ok(())
}

/// List all tmux sessions (name, attached status, window count, created, agent state).
///
/// Uses `|` as the format separator (unified). The session name is the last field
/// and re-joined from remaining parts after the fixed fields — this handles names
/// that contain `|` characters.
pub async fn list_sessions() -> Result<Vec<TmuxSessionInfo>> {
    let output = Command::new("tmux")
        .args([
            "list-sessions",
            "-F",
            "#{session_attached}|#{session_windows}|#{session_created}|#{@omniterm_agent}|#{session_name}",
        ])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "no server running" is not an error — just means no sessions
        if stderr.contains("no server running") {
            return Ok(vec![]);
        }
        return Err(anyhow!("tmux list-sessions failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let sessions = stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('|').collect();
            // Minimum: attached, windows, created, agent_value, name = 5 fields
            if parts.len() >= 5 {
                let attached = parts[0] != "0";
                let windows: u32 = parts[1].parse().unwrap_or(1);
                let created = parts[2].to_string();

                // Parse agent option value
                let agent_val = parts[3];
                let agent_snapshot = agent_state::parse_agent_value(agent_val);
                let (agent_kind, agent_state, attention_reason, agent_event, agent_nonce) =
                    if let Some(snap) = agent_snapshot {
                        (
                            Some(snap.agent_kind.as_str().to_string()),
                            Some(snap.agent_state.as_str().to_string()),
                            snap.attention_reason.map(|r| r.as_str().to_string()),
                            snap.agent_event,
                            snap.agent_nonce,
                        )
                    } else {
                        (None, None, None, None, None)
                    };

                // Session name: rejoin remaining parts with |
                let name = parts[4..].join("|");

                Some(TmuxSessionInfo {
                    name,
                    attached,
                    windows,
                    created,
                    agent_kind,
                    agent_state,
                    attention_reason,
                    agent_event,
                    agent_nonce,
                })
            } else {
                None
            }
        })
        .collect();

    Ok(sessions)
}

/// Check if a tmux session exists.
pub async fn session_exists(name: &str) -> bool {
    Command::new("tmux")
        .args(["has-session", "-t", name])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Send keys to a tmux session (useful for automation).
pub async fn send_keys(session: &str, keys: &str) -> Result<()> {
    let output = Command::new("tmux")
        .args(["send-keys", "-t", session, keys, "Enter"])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("tmux send-keys failed: {}", stderr));
    }

    Ok(())
}

/// Get the current working directory of a tmux pane.
pub async fn pane_cwd(session: &str) -> Result<String> {
    let output = Command::new("tmux")
        .args([
            "display-message",
            "-t", session,
            "-p",
            "#{pane_current_path}",
        ])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("tmux display-message failed: {}", stderr));
    }

    let cwd = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if cwd.is_empty() {
        return Err(anyhow!("tmux session '{}' not found or has no pane", session));
    }
    Ok(cwd)
}

/// Capture the last N lines of a tmux pane's content.
pub async fn capture_pane(session: &str, lines: usize) -> Result<String> {
    let output = Command::new("tmux")
        .args([
            "capture-pane",
            "-t", session,
            "-p",
            "-S", &format!("-{}", lines),
        ])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("tmux capture-pane failed: {}", stderr));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Query the `@omniterm_agent` tmux session option for a single session.
///
/// Returns `None` if the option is not set or empty.
pub async fn get_session_agent_option(session_name: &str) -> Result<Option<AgentSnapshot>> {
    let output = Command::new("tmux")
        .args(["show-options", "-t", session_name, "@omniterm_agent"])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Option not set is not an error
        if stderr.contains("unknown option") || stderr.contains("no such option") {
            return Ok(None);
        }
        return Err(anyhow!("tmux show-options failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Output format: "@omniterm_agent <value>"
    let value = stdout
        .strip_prefix("@omniterm_agent ")
        .map(|v| v.trim())
        .unwrap_or("");

    Ok(agent_state::parse_agent_value(value))
}

/// Detect if a known agent CLI process is running in the given tmux session.
///
/// Gets pane PIDs via `tmux list-panes`, then walks the process tree from each
/// pane PID checking `/proc/<pid>/cmdline` against known agent CLIs.
pub async fn detect_agent_in_session(session_name: &str) -> Option<AgentKind> {
    let output = Command::new("tmux")
        .args(["list-panes", "-t", session_name, "-F", "#{pane_pid}"])
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let pid: i32 = match line.trim().parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        if let Some(kind) = walk_process_tree(pid) {
            return Some(kind);
        }
    }

    None
}

/// Walk the process tree from `pid` looking for agent processes.
///
/// Checks the process itself and its immediate children via
/// `/proc/<pid>/task/<tid>/children`.
fn walk_process_tree(pid: i32) -> Option<AgentKind> {
    // Check the process itself
    if let Some(kind) = read_process_cmdline(pid) {
        return Some(kind);
    }

    // Check immediate children via /proc/<pid>/task/<tid>/children
    let children_path = format!("/proc/{}/task/{}/children", pid, pid);
    if let Ok(children_str) = fs::read_to_string(children_path) {
        for child_pid_str in children_str.split_whitespace() {
            if let Ok(child_pid) = child_pid_str.parse::<i32>() {
                if let Some(kind) = read_process_cmdline(child_pid) {
                    return Some(kind);
                }
            }
        }
    }

    None
}

/// Read a process's cmdline from `/proc/<pid>/cmdline` and match against known agent CLIs.
fn read_process_cmdline(pid: i32) -> Option<AgentKind> {
    let cmdline_path = format!("/proc/{}/cmdline", pid);
    let content = fs::read_to_string(cmdline_path).ok()?;
    if content.is_empty() {
        return None;
    }
    // /proc/<pid>/cmdline uses null bytes as argument delimiters
    let cmdline = content.replace('\0', " ");
    agent_hooks::detect_agent_kind(cmdline.trim())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TmuxSessionInfo {
    pub name: String,
    pub attached: bool,
    pub windows: u32,
    pub created: String,
    pub agent_kind: Option<String>,
    pub agent_state: Option<String>,
    pub attention_reason: Option<String>,
    pub agent_event: Option<String>,
    pub agent_nonce: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_read_process_cmdline_current_process() {
        // Read the current process's cmdline — should not match any agent
        let current_pid = std::process::id() as i32;
        let result = read_process_cmdline(current_pid);
        // The test runner is cargo/rustc — not an agent CLI
        assert!(result.is_none(), "current process should not be detected as agent");
    }

    #[test]
    fn test_read_process_cmdline_invalid_pid() {
        // A very large PID that shouldn't exist
        let result = read_process_cmdline(99999999);
        assert!(result.is_none(), "invalid PID should return None");
    }

    #[test]
    fn test_walk_process_tree_current_process() {
        // Walk the tree from the current process — should not match any agent
        let current_pid = std::process::id() as i32;
        let result = walk_process_tree(current_pid);
        assert!(result.is_none(), "current process tree should not be detected as agent");
    }

    #[test]
    fn test_read_process_cmdline_matches_claude() {
        // This simulates what read_process_cmdline does internally
        // by calling detect_agent_kind with a known claude command
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
        // No agent commands should not match
        assert_eq!(agent_hooks::detect_agent_kind("sleep 30"), None);
        assert_eq!(agent_hooks::detect_agent_kind("bash"), None);
        assert_eq!(agent_hooks::detect_agent_kind("zsh"), None);
        assert_eq!(agent_hooks::detect_agent_kind("vim"), None);
        assert_eq!(agent_hooks::detect_agent_kind("ls -la"), None);
    }

    #[test]
    fn test_read_process_cmdline_handles_null_bytes() {
        // Simulate /proc/<pid>/cmdline format with null bytes
        let simulated_cmdline = "claude\0--dangerously-skip-permissions\0";
        let cmdline = simulated_cmdline.replace('\0', " ");
        assert_eq!(
            agent_hooks::detect_agent_kind(cmdline.trim()),
            Some(AgentKind::Claude)
        );
    }
}
