//! Agent hook 注入（本地 HTTP 回调版，计划 D7）：为 agent 命令生成把状态
//! POST 回 `$OMNITERM_HOOK_URL` 的 hook 配置。tmux 会话沿用冻结的 option
//! 信道版（`crate::engine::tmux::agent_hooks`）；本模块是其 pty 等价物，
//! hook 事件表与 tmux 版保持镜像（冻结代码不改，Phase 5 摘除 tmux 后
//! 本表为单一真源）。
//!
//! hook 命令纪律（herdr 三件套）：fail-silent（`-fs -o /dev/null` 加 `|| true`）
//! 与 0.5s 超时（`-m 0.5`）；上报 body 复用 option 信道的
//! `kind:state:reason:event:nonce` 五段格式（`parse_agent_value` 统一解析）。
//! CLI 识别在 `crate::agent::cli`。

use crate::agent::cli::detect_agent_kind;
use crate::agent::state::AgentKind;

/// 单条 hook 命令：把五段状态 POST 到 `$OMNITERM_HOOK_URL`（spawn 时 env 注入，
/// 不硬编码端口/token）。payload 无空格，免 shell 引号转义。
fn curl_report(kind: &str, state: &str, reason: &str, event: &str) -> String {
    format!(
        "curl -fs -m 0.5 -o /dev/null --data {}:{}:{}:{}:$(date +%s).$$ $OMNITERM_HOOK_URL || true",
        kind, state, reason, event
    )
}

/// Generate Claude Code `--settings` JSON for lifecycle hooks.
///
/// Returns a JSON string that maps each hook event to a command that POSTs
/// agent state to the backend hook endpoint.
pub fn claude_hook_settings() -> String {
    let hooks = serde_json::json!({
        "hooks": {
            "UserPromptSubmit": [
                { "command": curl_report("claude", "running", "", "UserPromptSubmit") }
            ],
            "PreToolUse": [
                { "command": curl_report("claude", "running", "", "PreToolUse") }
            ],
            "PostToolUse": [
                { "command": curl_report("claude", "running", "", "PostToolUse") }
            ],
            "PermissionRequest": [
                { "command": curl_report("claude", "waiting", "decision", "PermissionRequest") }
            ],
            "Notification": [
                {
                    "matcher": "permission_prompt",
                    "command": curl_report("claude", "waiting", "decision", "permission_prompt")
                },
                {
                    "matcher": "elicitation_dialog",
                    "command": curl_report("claude", "waiting", "decision", "elicitation_dialog")
                }
            ],
            "Stop": [
                { "command": curl_report("claude", "idle", "done", "Stop") }
            ],
            "StopFailure": [
                { "command": curl_report("claude", "idle", "error", "StopFailure") }
            ],
            "SessionEnd": [
                { "command": curl_report("claude", "idle", "done", "SessionEnd") }
            ]
        }
    });

    hooks.to_string()
}

/// Generate Codex `-c` flag arguments for lifecycle hooks.
///
/// Each argument is a `-c hooks.<event>.command=<shell command>` pair.
pub fn codex_hook_args() -> Vec<String> {
    let hooks: Vec<(&str, &str, &str)> = vec![
        ("running", "", "UserPromptSubmit"),
        ("running", "", "PreToolUse"),
        ("running", "", "PostToolUse"),
        ("waiting", "decision", "PermissionRequest"),
        ("idle", "done", "Stop"),
    ];

    let mut args = Vec::new();
    for (state, reason, event) in hooks {
        args.push("-c".to_string());
        args.push(format!(
            "hooks.{}.command={}",
            event,
            curl_report("codex", state, reason, event)
        ));
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
            let args_str = args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ");
            format!("{} {}", command.trim(), args_str)
        }
    };

    Some(augmented)
}

/// Simple shell quoting — wraps the argument in single quotes and escapes
/// any internal single quotes.
fn shell_quote(s: &str) -> String {
    let escaped = s.replace('\'', "'\\''");
    format!("'{escaped}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_hook_settings_valid_json_with_curl_commands() {
        let settings = claude_hook_settings();
        let parsed: serde_json::Value =
            serde_json::from_str(&settings).expect("should be valid JSON");
        let hooks = &parsed["hooks"];

        for event in [
            "UserPromptSubmit",
            "PreToolUse",
            "PostToolUse",
            "PermissionRequest",
            "Notification",
            "Stop",
            "StopFailure",
            "SessionEnd",
        ] {
            assert!(hooks[event].is_array(), "missing hook event {event}");
        }

        let notifications = hooks["Notification"].as_array().unwrap();
        assert_eq!(notifications.len(), 2);
        assert_eq!(notifications[0]["matcher"], "permission_prompt");
        assert_eq!(notifications[1]["matcher"], "elicitation_dialog");

        let cmd = hooks["PermissionRequest"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("curl"), "hook command must use curl: {cmd}");
        assert!(cmd.contains("-m 0.5"), "hook command must have 0.5s timeout: {cmd}");
        assert!(cmd.contains("$OMNITERM_HOOK_URL"), "hook command must target env URL: {cmd}");
        assert!(
            cmd.contains("claude:waiting:decision:PermissionRequest"),
            "payload must carry five-segment state: {cmd}"
        );
        assert!(cmd.contains("$(date +%s).$$"), "payload must carry nonce: {cmd}");
        assert!(cmd.ends_with("|| true"), "hook command must be fail-silent: {cmd}");
    }

    #[test]
    fn codex_hook_args_format() {
        let args = codex_hook_args();
        assert_eq!(args.len(), 10); // 5 hooks × 2 args each

        let expected_events =
            ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop"];
        let mut i = 0;
        for event in &expected_events {
            assert_eq!(args[i], "-c");
            assert!(args[i + 1].starts_with(&format!("hooks.{event}.command=")));
            assert!(args[i + 1].contains("curl"));
            assert!(args[i + 1].contains("$OMNITERM_HOOK_URL"));
            i += 2;
        }
    }

    #[test]
    fn augment_claude_and_codex() {
        let cmd = augment_agent_command("claude --model sonnet").expect("claude detected");
        assert!(cmd.starts_with("claude --model sonnet --settings '"));
        assert!(cmd.contains("UserPromptSubmit"));

        let cmd = augment_agent_command("codex").expect("codex detected");
        assert!(cmd.starts_with("codex "));
        assert!(cmd.contains("-c"));
    }

    #[test]
    fn augment_non_agent_returns_none() {
        assert!(augment_agent_command("bash").is_none());
        assert!(augment_agent_command("ls -la").is_none());
    }
}
