pub mod hooks;

use anyhow::{anyhow, Result};
use tokio::process::Command;
use tracing::{debug, warn};

/// Create a new detached tmux session.
pub async fn new_session(name: &str, cwd: &str) -> Result<()> {
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

    // Enable mouse support so scroll wheel events are forwarded to tmux
    // (without this, the wheel only scrolls xterm.js's own scrollback buffer)
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

    debug!("created tmux session: {} (cwd: {})", name, cwd);
    Ok(())
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

/// List all tmux sessions (name, attached status, window count).
pub async fn list_sessions() -> Result<Vec<TmuxSessionInfo>> {
    let output = Command::new("tmux")
        .args([
            "list-sessions",
            "-F",
            "#{session_name}\t#{session_attached}\t#{session_windows}\t#{session_created}",
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
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() >= 4 {
                Some(TmuxSessionInfo {
                    name: parts[0].to_string(),
                    attached: parts[1] != "0",
                    windows: parts[2].parse().unwrap_or(1),
                    created: parts[3].to_string(),
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct TmuxSessionInfo {
    pub name: String,
    pub attached: bool,
    pub windows: u32,
    pub created: String,
}
