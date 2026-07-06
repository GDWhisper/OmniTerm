//! Agent hook configuration generation.
//!
//! This module detects agent CLIs from session commands and generates
//! hook configuration flags for Claude Code and Codex.

use crate::tmux::agent_state::AgentKind;

/// Detect the agent kind from a command string.
///
/// Extracts the basename (strips path, extensions like `.exe`/`.cmd`/`.bat`, and lowercases),
/// then matches against known agent CLIs.
pub fn detect_agent_kind(command: &str) -> Option<AgentKind> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return None;
    }

    let first_token = cmd.split_whitespace().next()?;

    let basename = first_token
        .rsplit(&['/', '\\'][..])
        .next()
        .unwrap_or(first_token);

    let stripped = if let Some(s) = strip_ext(basename, ".exe")
        .or_else(|| strip_ext(basename, ".cmd"))
        .or_else(|| strip_ext(basename, ".bat"))
    {
        s
    } else {
        basename
    };

    match stripped.to_lowercase().as_str() {
        "claude" | "claude-code" => Some(AgentKind::Claude),
        "codex" => Some(AgentKind::Codex),
        "qoder" => Some(AgentKind::Qoder),
        "node" | "nodejs" => {
            let args = &cmd[first_token.len()..];
            detect_agent_in_node_args(args)
        }
        _ => None,
    }
}

/// Scan the arguments after `node`/`node.exe` for agent script path segments.
///
/// Matches paths like `C:\...\claude\bin\cli.js` or `/usr/lib/codex/index.js`
/// by checking if any path segment is a known agent name.
fn detect_agent_in_node_args(args: &str) -> Option<AgentKind> {
    for token in args.split_whitespace() {
        for segment in token.split(&['/', '\\'][..]) {
            let seg_lower = segment.to_lowercase();
            match seg_lower.as_str() {
                "claude" | "claude-code" => return Some(AgentKind::Claude),
                "codex" => return Some(AgentKind::Codex),
                "qoder" => return Some(AgentKind::Qoder),
                _ => {}
            }
        }
    }
    None
}

/// Case-insensitive extension stripping.
fn strip_ext<'a>(name: &'a str, ext: &str) -> Option<&'a str> {
    if name.len() > ext.len() && name[name.len() - ext.len()..].eq_ignore_ascii_case(ext) {
        Some(&name[..name.len() - ext.len()])
    } else {
        None
    }
}

/// Generate Claude Code `--settings` JSON for lifecycle hooks.
///
/// Returns a JSON string that maps each hook event to a `tmux set-option` command
/// that writes agent state to `@omniterm_agent`.
pub fn claude_hook_settings() -> String {
    let tmux_set = |state: &str, reason: &str, event: &str| -> String {
        format!(
            "tmux set-option -q @omniterm_agent claude:{}:{}:{}:$(date +%s).$$",
            state, reason, event
        )
    };

    let hooks = serde_json::json!({
        "hooks": {
            "UserPromptSubmit": [
                { "command": tmux_set("running", "", "UserPromptSubmit") }
            ],
            "PreToolUse": [
                { "command": tmux_set("running", "", "PreToolUse") }
            ],
            "PostToolUse": [
                { "command": tmux_set("running", "", "PostToolUse") }
            ],
            "PermissionRequest": [
                { "command": tmux_set("waiting", "decision", "PermissionRequest") }
            ],
            "Notification": [
                {
                    "matcher": "permission_prompt",
                    "command": tmux_set("waiting", "decision", "permission_prompt")
                },
                {
                    "matcher": "elicitation_dialog",
                    "command": tmux_set("waiting", "decision", "elicitation_dialog")
                }
            ],
            "Stop": [
                { "command": tmux_set("idle", "done", "Stop") }
            ],
            "StopFailure": [
                { "command": tmux_set("idle", "error", "StopFailure") }
            ],
            "SessionEnd": [
                { "command": tmux_set("idle", "done", "SessionEnd") }
            ]
        }
    });

    hooks.to_string()
}

/// Generate Codex `-c` flag arguments for lifecycle hooks.
///
/// Each argument is a `-c hooks.<event>.command=<shell command>` pair.
pub fn codex_hook_args() -> Vec<String> {
    let tmux_set = |state: &str, reason: &str, event: &str| -> String {
        format!(
            "tmux set-option -q @omniterm_agent codex:{}:{}:{}:$(date +%s).$$",
            state, reason, event
        )
    };

    let hooks: Vec<(&str, &str, &str)> = vec![
        ("running", "", "UserPromptSubmit"),
        ("running", "", "PreToolUse"),
        ("running", "", "PostToolUse"),
        ("waiting", "decision", "PermissionRequest"),
        ("idle", "done", "Stop"),
    ];

    let mut args = Vec::new();
    for (state, reason, event) in hooks {
        let cmd = tmux_set(state, reason, event);
        args.push("-c".to_string());
        args.push(format!("hooks.{}.command={}", event, cmd));
    }

    args
}

/// Augment an agent command with hook configuration flags.
///
/// If the command is detected as a supported agent CLI, returns the augmented
/// command string. Otherwise returns `None`.
pub fn augment_agent_command(command: &str) -> Option<String> {
    let kind = detect_agent_kind(command)?;

    let augmented = match kind {
        AgentKind::Claude | AgentKind::Qoder => {
            let settings_json = claude_hook_settings();
            format!("{} --settings '{}'", command.trim(), settings_json)
        }
        AgentKind::Codex => {
            let args = codex_hook_args();
            let args_str = args
                .iter()
                .map(|a| shell_quote(a))
                .collect::<Vec<_>>()
                .join(" ");
            format!("{} {}", command.trim(), args_str)
        }
    };

    Some(augmented)
}

/// Generate the initial `@omniterm_agent` option value for a new agent session.
///
/// Format: `omniterm:running::launch:<unix_timestamp>`
pub fn initial_agent_option_value(_kind: AgentKind) -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!(
        "omniterm:running::launch:{}",
        ts
    )
}

/// Simple shell quoting — wraps the argument in single quotes and escapes
/// any internal single quotes.
fn shell_quote(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{}'", escaped)
}

#[cfg(test)]
mod tests {
    use super::*;

    // === detect_agent_kind tests ===

    #[test]
    fn test_detect_claude() {
        assert_eq!(detect_agent_kind("claude"), Some(AgentKind::Claude));
        assert_eq!(detect_agent_kind("claude --dangerously-skip-permissions"), Some(AgentKind::Claude));
    }

    #[test]
    fn test_detect_claude_code() {
        assert_eq!(detect_agent_kind("claude-code"), Some(AgentKind::Claude));
        assert_eq!(detect_agent_kind("claude-code --model haiku"), Some(AgentKind::Claude));
    }

    #[test]
    fn test_detect_codex() {
        assert_eq!(detect_agent_kind("codex"), Some(AgentKind::Codex));
        assert_eq!(detect_agent_kind("codex --help"), Some(AgentKind::Codex));
    }

    #[test]
    fn test_detect_case_insensitive() {
        assert_eq!(detect_agent_kind("Claude"), Some(AgentKind::Claude));
        assert_eq!(detect_agent_kind("CLAUDE"), Some(AgentKind::Claude));
        assert_eq!(detect_agent_kind("Codex"), Some(AgentKind::Codex));
    }

    #[test]
    fn test_detect_strip_extensions() {
        assert_eq!(detect_agent_kind("claude.exe"), Some(AgentKind::Claude));
        assert_eq!(detect_agent_kind("Claude.EXE"), Some(AgentKind::Claude));
        assert_eq!(detect_agent_kind("codex.cmd"), Some(AgentKind::Codex));
        assert_eq!(detect_agent_kind("claude.bat"), Some(AgentKind::Claude));
    }

    #[test]
    fn test_detect_full_path() {
        assert_eq!(detect_agent_kind("/usr/local/bin/claude"), Some(AgentKind::Claude));
        // Windows path — use a path without spaces (split_whitespace breaks on spaces)
        assert_eq!(detect_agent_kind("C:\\Claude\\claude.exe"), Some(AgentKind::Claude));
    }

    #[test]
    fn test_detect_non_agent() {
        assert_eq!(detect_agent_kind("bash"), None);
        assert_eq!(detect_agent_kind("zsh"), None);
        assert_eq!(detect_agent_kind("vim"), None);
        assert_eq!(detect_agent_kind(""), None);
        assert_eq!(detect_agent_kind("  "), None);
    }

    #[test]
    fn test_detect_qoder() {
        assert_eq!(detect_agent_kind("qoder"), Some(AgentKind::Qoder));
        assert_eq!(detect_agent_kind("qoder.exe"), Some(AgentKind::Qoder));
        assert_eq!(detect_agent_kind("C:\\Users\\x\\qoder.exe"), Some(AgentKind::Qoder));
    }

    #[test]
    fn test_detect_windows_negative_samples() {
        assert_eq!(detect_agent_kind("claudette.exe"), None);
        assert_eq!(detect_agent_kind("codextool.exe"), None);
        assert_eq!(detect_agent_kind("qodercli.exe"), None);
        assert_eq!(detect_agent_kind("C:\\Program Files\\claudette.exe"), None);
    }

    #[test]
    fn test_detect_node_wrapper_claude() {
        assert_eq!(
            detect_agent_kind("node C:\\Users\\x\\claude\\bin\\cli.js"),
            Some(AgentKind::Claude)
        );
        assert_eq!(
            detect_agent_kind("node.exe /usr/local/lib/claude/index.js"),
            Some(AgentKind::Claude)
        );
    }

    #[test]
    fn test_detect_node_wrapper_codex() {
        assert_eq!(
            detect_agent_kind("node C:\\tools\\codex\\bin\\main.js"),
            Some(AgentKind::Codex)
        );
    }

    #[test]
    fn test_detect_node_wrapper_non_agent() {
        assert_eq!(detect_agent_kind("node server.js"), None);
        assert_eq!(detect_agent_kind("node.exe app/index.js"), None);
    }

    // === claude_hook_settings tests ===

    #[test]
    fn test_claude_hook_settings_valid_json() {
        let settings = claude_hook_settings();
        let parsed: serde_json::Value = serde_json::from_str(&settings).expect("should be valid JSON");
        let hooks = &parsed["hooks"];

        // Verify all required hook events are present
        assert!(hooks["UserPromptSubmit"].is_array());
        assert!(hooks["PreToolUse"].is_array());
        assert!(hooks["PostToolUse"].is_array());
        assert!(hooks["PermissionRequest"].is_array());
        assert!(hooks["Notification"].is_array());
        assert!(hooks["Stop"].is_array());
        assert!(hooks["StopFailure"].is_array());
        assert!(hooks["SessionEnd"].is_array());

        // Verify notification matchers
        let notifications = hooks["Notification"].as_array().unwrap();
        assert_eq!(notifications.len(), 2);
        assert_eq!(notifications[0]["matcher"], "permission_prompt");
        assert_eq!(notifications[1]["matcher"], "elicitation_dialog");

        // Verify command format
        let cmd = hooks["PermissionRequest"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("tmux set-option -q @omniterm_agent claude:waiting:decision:PermissionRequest"));
        assert!(cmd.contains("$(date +%s).$$"));
    }

    // === codex_hook_args tests ===

    #[test]
    fn test_codex_hook_args_format() {
        let args = codex_hook_args();
        // Should be pairs of -c and the hook config
        assert_eq!(args.len(), 10); // 5 hooks × 2 args each = 10

        // Verify -c flags
        let mut i = 0;
        let expected_events = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"];
        for event in &expected_events {
            assert_eq!(args[i], "-c");
            assert!(args[i + 1].starts_with(&format!("hooks.{}.command=", event)));
            assert!(args[i + 1].contains("tmux set-option"));
            i += 2;
        }
    }

    // === augment_agent_command tests ===

    #[test]
    fn test_augment_claude() {
        let result = augment_agent_command("claude --model sonnet");
        assert!(result.is_some());
        let cmd = result.unwrap();
        assert!(cmd.starts_with("claude --model sonnet --settings '"));
        assert!(cmd.contains("UserPromptSubmit"));
    }

    #[test]
    fn test_augment_codex() {
        let result = augment_agent_command("codex");
        assert!(result.is_some());
        let cmd = result.unwrap();
        assert!(cmd.starts_with("codex "));
        assert!(cmd.contains("-c"));
        assert!(cmd.contains("UserPromptSubmit"));
    }

    #[test]
    fn test_augment_non_agent() {
        assert!(augment_agent_command("bash").is_none());
        assert!(augment_agent_command("ls -la").is_none());
    }

    // === initial_agent_option_value tests ===

    #[test]
    fn test_initial_option_value_format() {
        let val = initial_agent_option_value(AgentKind::Claude);
        assert!(val.starts_with("omniterm:running::launch:"));
        // Should contain a reasonable timestamp
        let parts: Vec<&str> = val.split(':').collect();
        assert_eq!(parts.len(), 5);
        let ts: u64 = parts[4].parse().expect("timestamp should be numeric");
        assert!(ts > 1700000000); // after 2023
    }

    // === shell escaping tests (via clean_token in agent_state) ===

    #[test]
    fn test_shell_escaping_special_chars() {
        use crate::tmux::agent_state::clean_token;

        // Single quotes are replaced
        assert_eq!(clean_token("it's"), "it_s");
        // Double quotes are replaced
        assert_eq!(clean_token("say \"hello\""), "say__hello_");
        // Backslashes are replaced
        assert_eq!(clean_token("path\\to"), "path_to");
        // Newlines are replaced
        assert_eq!(clean_token("line1\nline2"), "line1_line2");
    }
}
