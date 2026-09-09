pub mod agent_hooks;
pub mod control_mode;
pub mod engine;
pub mod terminal_ws;
pub mod watch_source;

use anyhow::{Result, anyhow};
use tokio::process::Command;
use tracing::{debug, warn};

use crate::agent::state::AgentSnapshot;
use crate::engine::EngineSessionInfo;
use crate::engine::pty_io::{SSH_LEAK_ENV_VARS, strip_ssh_leak_env_async};

pub use engine::TmuxEngine;

/// Platform-specific install commands for the terminal multiplexer.
#[cfg(unix)]
pub const MULTIPLEXER_INSTALL_HINTS: &[&str] =
    &["apt install tmux", "brew install tmux", "pacman -S tmux"];

#[cfg(windows)]
pub const MULTIPLEXER_INSTALL_HINTS: &[&str] =
    &["winget install psmux", "scoop install psmux", "cargo install psmux"];

/// User-facing name of the platform's terminal multiplexer. Windows 用 psmux
/// 平替 tmux（psmux 同时以 `tmux` 别名安装，因此不能靠 binary 名区分，
/// 按平台编译期确定）。前端会话创建列表等 UI 文案使用此名称。
#[cfg(unix)]
pub const MULTIPLEXER_NAME: &str = "tmux";

#[cfg(windows)]
pub const MULTIPLEXER_NAME: &str = "psmux";

/// Check whether a terminal multiplexer (tmux/psmux) is available in PATH.
///
/// Returns `Ok(())` if found, or an error with platform-specific install hints.
pub fn check_multiplexer() -> Result<()> {
    match which::which("tmux") {
        Ok(_) => {
            debug!("multiplexer (tmux) found in PATH");
            Ok(())
        }
        Err(_) => {
            #[cfg(windows)]
            {
                if which::which("psmux").is_ok() {
                    debug!("multiplexer (psmux) found in PATH");
                    return Ok(());
                }
            }
            let hints = MULTIPLEXER_INSTALL_HINTS.join("\n  ");
            Err(anyhow!("terminal multiplexer not found in PATH.\nInstall one of:\n  {}", hints))
        }
    }
}

/// Build a tmux client command with SSH 会话泄漏变量已移除的环境。
///
/// tmux server 从 SSH 会话启动时 global env 含 SSH 变量；client 连接时 tmux 的
/// `update-environment`（默认列表含 SSH_CONNECTION）用 client 环境更新 session
/// env，client 无该变量则 unset——故所有 tmux client 一律不带 SSH 泄漏变量。
/// SSH_CLIENT/SSH_TTY 不在默认 update 列表：初始 pane 由 `new_session` 的
/// STRIPPED_PANE_CMD 在命令源头剥离，session env 由 set-environment 兜底
/// （见 pty_io::SSH_LEAK_ENV_VARS 根因注释）。
fn tmux_cmd() -> Command {
    let mut cmd = Command::new("tmux");
    strip_ssh_leak_env_async(&mut cmd);
    cmd
}

/// 初始 pane 启动命令包装（unix）：tmux 的 `update-environment` 默认列表只含
/// SSH_CONNECTION，SSH_CLIENT/SSH_TTY 会随 server env 残留进 pane——agy 等 CLI
/// 见**任一** SSH_* 变量即判定 SSH 会话（实测 2026-09-08：仅剩 SSH_CLIENT 也走
/// file-based token storage）。`set-environment -u` 只影响后续新建 pane，初始
/// pane 必须在命令源头剥离：`env -u` 清变量后 exec `$SHELL`（交互 shell，与
/// tmux 默认 pane 命令行为一致；`${SHELL:-/bin/sh}` 兜底）。
#[cfg(unix)]
const STRIPPED_PANE_CMD: &str =
    "exec env -u SSH_CLIENT -u SSH_CONNECTION -u SSH_TTY \"${SHELL:-/bin/sh}\"";

/// Windows（psmux）不注入 pane 命令包装：Windows 无 GNU `env -u` 语义，psmux
/// 的 shell-command 行为未验证，保持原样（Windows SSH 泄漏场景少见，不做）。
#[cfg(windows)]
const STRIPPED_PANE_CMD: &str = "";

/// Create a new detached tmux session with an optional startup command.
///
/// If `command` is provided and detected as a supported agent CLI, the command
/// is augmented with hook configuration flags, the `@omniterm_agent` option is
/// initialized, and the augmented command is sent via `send-keys`.
///
/// Returns whether hooks were injected.
pub async fn new_session(name: &str, cwd: &str, command: Option<&str>) -> Result<bool> {
    use crate::engine::tmux::agent_hooks;

    // 1. Create the tmux session (plain shell)
    // 初始 pane 经 STRIPPED_PANE_CMD 包装启动（unix），源头剥离 SSH 泄漏变量。
    let new_args = vec![
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        cwd,
        "-x",
        "200",
        "-y",
        "50",
        #[cfg(unix)]
        STRIPPED_PANE_CMD,
    ];
    let output = tmux_cmd().args(&new_args).output().await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("tmux new-session failed: {}", stderr));
    }

    // 清 session 环境里的 SSH 泄漏变量（初始 pane 已由 STRIPPED_PANE_CMD 剥离，
    // 这里保证后续 split-window/new-window 新建的 pane 同样干净）。
    // fail-silent：session 刚创建，失败仅影响后续新 pane。
    for var in SSH_LEAK_ENV_VARS {
        let _ = tmux_cmd().args(["set-environment", "-t", name, "-u", var]).output().await;
    }

    // 2. Enable mouse support
    let mouse_out = tmux_cmd().args(["set-option", "-t", name, "mouse", "on"]).output().await?;
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
        if let Some(kind) = crate::agent::cli::detect_agent_kind(cmd) {
            // Initialize agent option before launching agent
            let initial_value = agent_hooks::initial_agent_option_value(kind);
            let opt_out = tmux_cmd()
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
            let augmented =
                agent_hooks::augment_agent_command(cmd).unwrap_or_else(|| cmd.to_string());

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
    let output = tmux_cmd().args(["kill-session", "-t", name]).output().await?;

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
pub async fn list_sessions() -> Result<Vec<EngineSessionInfo>> {
    let output = tmux_cmd()
        .args([
            "list-sessions",
            "-F",
            "#{session_attached}|#{session_windows}|#{session_created}|#{@omniterm_agent}|#{pane_current_path}|#{session_name}",
        ])
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout_str = String::from_utf8_lossy(&output.stdout);
        // "no server running" or empty output means no sessions — not an error.
        // psmux on Windows may exit non-zero with empty stdout when no sessions exist.
        if stderr.contains("no server running") || stdout_str.trim().is_empty() {
            return Ok(vec![]);
        }
        return Err(anyhow!("tmux list-sessions failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let sessions = stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('|').collect();
            // Minimum: attached, windows, created, agent_value, cwd, name = 6 fields
            if parts.len() >= 6 {
                let attached = parts[0] != "0";
                let windows: u32 = parts[1].parse().unwrap_or(1);
                let created = parts[2].to_string();

                // Parse agent option value
                let agent_val = parts[3];
                let agent_snapshot = crate::agent::state::parse_agent_value(agent_val);
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

                // Parse CWD (may be empty if no pane exists yet)
                let cwd_raw = parts[4];
                let cwd = if cwd_raw.is_empty() { None } else { Some(cwd_raw.to_string()) };

                // Session name: rejoin remaining parts with |
                let name = parts[5..].join("|");

                Some(EngineSessionInfo {
                    name,
                    attached,
                    windows,
                    created,
                    cwd,
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
    tmux_cmd()
        .args(["has-session", "-t", name])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Send keys to a tmux session (useful for automation).
pub async fn send_keys(session: &str, keys: &str) -> Result<()> {
    let output = tmux_cmd().args(["send-keys", "-t", session, keys, "Enter"]).output().await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("tmux send-keys failed: {}", stderr));
    }

    Ok(())
}

/// Get the current working directory of a tmux pane.
pub async fn pane_cwd(session: &str) -> Result<String> {
    let output = tmux_cmd()
        .args(["display-message", "-t", session, "-p", "#{pane_current_path}"])
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

/// Capture the current visible screen of a tmux pane (no scrollback).
pub async fn capture_screen(session: &str) -> Result<String> {
    let output = tmux_cmd().args(["capture-pane", "-t", session, "-p"]).output().await?;

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
    let output =
        tmux_cmd().args(["show-options", "-t", session_name, "@omniterm_agent"]).output().await?;

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
    let value = stdout.strip_prefix("@omniterm_agent ").map(|v| v.trim()).unwrap_or("");

    Ok(crate::agent::state::parse_agent_value(value))
}

/// Read the global tmux `mouse` option (`-g`).
/// Returns `true` if mouse mode is enabled, `false` if disabled.
pub async fn get_mouse_option() -> Result<bool> {
    let output = tmux_cmd().args(["show-options", "-g", "mouse"]).output().await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Output format: "mouse on\n" or "mouse off\n"
    Ok(stdout.trim().ends_with("on"))
}

/// Set the global tmux `mouse` option (`-g`).
pub async fn set_mouse_option(enabled: bool) -> Result<()> {
    let value = if enabled { "on" } else { "off" };
    let output = tmux_cmd().args(["set-option", "-g", "mouse", value]).output().await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("tmux set mouse failed: {}", stderr.trim()));
    }
    Ok(())
}
