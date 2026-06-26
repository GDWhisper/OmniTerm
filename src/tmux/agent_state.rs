//! Agent state data model for hook-driven agent monitoring.
//!
//! This module defines the types and parsing logic for the `@omniterm_agent` tmux
//! session option. The value format is colon-separated:
//!
//! ```text
//! <agent_kind>:<state>:<reason>:<event>:<nonce>
//! ```
//!
//! Example: `claude:waiting:decision:PermissionRequest:1719000000.12345`

use serde::Serialize;

/// Supported agent CLIs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentKind {
    Claude,
    Codex,
}

impl AgentKind {
    /// Parse from a lowercase string.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    /// Return the lowercase string representation.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

/// The current state of an agent process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    /// Agent is actively processing.
    Running,
    /// Agent is waiting for user input/decision.
    Waiting,
    /// Agent is idle (finished or not started).
    Idle,
}

impl AgentState {
    /// Parse from lowercase string.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "running" => Some(Self::Running),
            "waiting" => Some(Self::Waiting),
            "idle" => Some(Self::Idle),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Idle => "idle",
        }
    }
}

/// Reason for user attention (when state is `waiting` or `idle`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionReason {
    /// Agent needs a user decision (permission, prompt).
    Decision,
    /// Agent finished successfully.
    Done,
    /// Agent encountered an error.
    Error,
}

impl AttentionReason {
    /// Parse from lowercase string.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "decision" => Some(Self::Decision),
            "done" => Some(Self::Done),
            "error" => Some(Self::Error),
            "" => None,
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Decision => "decision",
            Self::Done => "done",
            Self::Error => "error",
        }
    }
}

/// A snapshot of agent state parsed from the `@omniterm_agent` tmux option.
#[derive(Debug, Clone, Serialize)]
pub struct AgentSnapshot {
    pub agent_kind: AgentKind,
    pub agent_state: AgentState,
    pub attention_reason: Option<AttentionReason>,
    pub agent_event: Option<String>,
    pub agent_nonce: Option<String>,
}

/// The tmux session option name used to store agent state.
pub const AGENT_OPTION: &str = "@omniterm_agent";

/// Parse a `@omniterm_agent` value string into an `AgentSnapshot`.
///
/// Expected format: `<kind>:<state>:<reason>:<event>:<nonce>`
///
/// Returns `None` if the value is empty or cannot be parsed.
pub fn parse_agent_value(value: &str) -> Option<AgentSnapshot> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }

    // If the agent_kind is "omniterm" (the initial placeholder set before agent launch),
    // treat it as "no agent activity yet" — return None so callers fall back.
    let parts: Vec<&str> = value.splitn(5, ':').collect();
    if parts.is_empty() || parts[0].is_empty() {
        return None;
    }

    if parts[0] == "omniterm" {
        // Initial placeholder — not a real agent snapshot
        return None;
    }

    let agent_kind = AgentKind::from_str(parts[0])?;

    let agent_state = parts
        .get(1)
        .and_then(|s| AgentState::from_str(s))
        .unwrap_or(AgentState::Idle);

    let attention_reason = parts
        .get(2)
        .and_then(|s| AttentionReason::from_str(s));

    let agent_event = parts.get(3).filter(|s| !s.is_empty()).map(|s| s.to_string());

    let agent_nonce = parts.get(4).filter(|s| !s.is_empty()).map(|s| s.to_string());

    Some(AgentSnapshot {
        agent_kind,
        agent_state,
        attention_reason,
        agent_event,
        agent_nonce,
    })
}

/// Format an `AgentSnapshot` into the `@omniterm_agent` value string.
///
/// All fields are sanitized via `clean_token()` to prevent shell injection.
pub fn agent_value(snapshot: &AgentSnapshot) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        clean_token(snapshot.agent_kind.as_str()),
        clean_token(snapshot.agent_state.as_str()),
        snapshot
            .attention_reason
            .map(|r| clean_token(r.as_str()))
            .unwrap_or_default(),
        snapshot
            .agent_event
            .as_deref()
            .map(clean_token)
            .unwrap_or_default(),
        snapshot
            .agent_nonce
            .as_deref()
            .map(clean_token)
            .unwrap_or_default(),
    )
}

/// Sanitize a token for use in the agent option value.
///
/// Whitespace and characters outside `[A-Za-z0-9_.-]` are replaced with `_`.
/// This prevents shell injection and ensures the value is safe for `tmux set-option`.
pub fn clean_token(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // === parse_agent_value tests ===

    #[test]
    fn test_parse_valid_claude_waiting() {
        let snap = parse_agent_value("claude:waiting:decision:PermissionRequest:1719000000.12345")
            .expect("should parse");
        assert_eq!(snap.agent_kind, AgentKind::Claude);
        assert_eq!(snap.agent_state, AgentState::Waiting);
        assert_eq!(snap.attention_reason, Some(AttentionReason::Decision));
        assert_eq!(snap.agent_event.as_deref(), Some("PermissionRequest"));
        assert_eq!(snap.agent_nonce.as_deref(), Some("1719000000.12345"));
    }

    #[test]
    fn test_parse_valid_codex_running() {
        let snap =
            parse_agent_value("codex:running::UserPromptSubmit:1719000001.54321").expect("should parse");
        assert_eq!(snap.agent_kind, AgentKind::Codex);
        assert_eq!(snap.agent_state, AgentState::Running);
        assert_eq!(snap.attention_reason, None);
        assert_eq!(snap.agent_event.as_deref(), Some("UserPromptSubmit"));
        assert_eq!(snap.agent_nonce.as_deref(), Some("1719000001.54321"));
    }

    #[test]
    fn test_parse_valid_idle_done() {
        let snap = parse_agent_value("claude:idle:done:Stop:1719000002.11111").expect("should parse");
        assert_eq!(snap.agent_state, AgentState::Idle);
        assert_eq!(snap.attention_reason, Some(AttentionReason::Done));
    }

    #[test]
    fn test_parse_valid_idle_error() {
        let snap = parse_agent_value("codex:idle:error:StopFailure:1719000003.22222")
            .expect("should parse");
        assert_eq!(snap.agent_state, AgentState::Idle);
        assert_eq!(snap.attention_reason, Some(AttentionReason::Error));
    }

    #[test]
    fn test_parse_empty_string() {
        assert!(parse_agent_value("").is_none());
    }

    #[test]
    fn test_parse_whitespace_only() {
        assert!(parse_agent_value("   ").is_none());
    }

    #[test]
    fn test_parse_omniterm_placeholder() {
        // The initial placeholder should be treated as "no agent activity"
        assert!(parse_agent_value("omniterm:running::launch:1719000000.99999").is_none());
    }

    #[test]
    fn test_parse_unknown_agent_kind() {
        assert!(parse_agent_value("unknown:running::test:12345").is_none());
    }

    #[test]
    fn test_parse_malformed_fewer_parts() {
        // Only 2 parts — should still parse with defaults for missing fields
        let snap = parse_agent_value("claude:running").expect("should parse");
        assert_eq!(snap.agent_kind, AgentKind::Claude);
        assert_eq!(snap.agent_state, AgentState::Running);
        assert_eq!(snap.attention_reason, None);
        assert_eq!(snap.agent_event, None);
        assert_eq!(snap.agent_nonce, None);
    }

    #[test]
    fn test_parse_only_agent_kind() {
        let snap = parse_agent_value("claude").expect("should parse");
        assert_eq!(snap.agent_kind, AgentKind::Claude);
        assert_eq!(snap.agent_state, AgentState::Idle);
        assert_eq!(snap.attention_reason, None);
    }

    #[test]
    fn test_parse_with_special_chars_sanitized() {
        // Real world: session name could contain special chars that end up here
        // via shell injection attempt. clean_token sanitizes, but parse doesn't
        // clean — it just splits. If the raw value has unexpected chars, parse
        // should still work on the clean parts.
        let snap = parse_agent_value("claude:running:decision:Some_Event:1234.5")
            .expect("should parse");
        assert_eq!(snap.agent_event.as_deref(), Some("Some_Event"));
    }

    // === agent_value + clean_token tests ===

    #[test]
    fn test_round_trip_format_and_parse() {
        let original = AgentSnapshot {
            agent_kind: AgentKind::Claude,
            agent_state: AgentState::Waiting,
            attention_reason: Some(AttentionReason::Decision),
            agent_event: Some("PermissionRequest".to_string()),
            agent_nonce: Some("1719000000.12345".to_string()),
        };
        let formatted = agent_value(&original);
        let parsed = parse_agent_value(&formatted).expect("round-trip should succeed");
        assert_eq!(parsed.agent_kind, original.agent_kind);
        assert_eq!(parsed.agent_state, original.agent_state);
        assert_eq!(parsed.attention_reason, original.attention_reason);
        assert_eq!(parsed.agent_event, original.agent_event);
        assert_eq!(parsed.agent_nonce, original.agent_nonce);
    }

    #[test]
    fn test_round_trip_no_reason() {
        let original = AgentSnapshot {
            agent_kind: AgentKind::Codex,
            agent_state: AgentState::Running,
            attention_reason: None,
            agent_event: Some("PreToolUse".to_string()),
            agent_nonce: Some("1111.22".to_string()),
        };
        let formatted = agent_value(&original);
        let parsed = parse_agent_value(&formatted).expect("round-trip should succeed");
        assert_eq!(parsed.attention_reason, None);
        assert_eq!(parsed.agent_event.as_deref(), Some("PreToolUse"));
    }

    #[test]
    fn test_clean_token_alphanumeric_passthrough() {
        assert_eq!(clean_token("hello123"), "hello123");
        assert_eq!(clean_token("ABC_def.ghi-jkl"), "ABC_def.ghi-jkl");
    }

    #[test]
    fn test_clean_token_special_chars() {
        assert_eq!(clean_token("hello world"), "hello_world");
        assert_eq!(clean_token("it's"), "it_s");
        assert_eq!(clean_token("quote\""), "quote_");
        assert_eq!(clean_token("back\\slash"), "back_slash");
        assert_eq!(clean_token("new\nline"), "new_line");
        assert_eq!(clean_token("tab\tchar"), "tab_char");
        assert_eq!(clean_token("dollar$sign"), "dollar_sign");
        assert_eq!(clean_token("path/to/file"), "path_to_file");
        assert_eq!(clean_token("name@domain"), "name_domain");
    }

    // === AgentState enum tests ===

    #[test]
    fn test_agent_state_from_str_all_variants() {
        assert_eq!(AgentState::from_str("running"), Some(AgentState::Running));
        assert_eq!(AgentState::from_str("waiting"), Some(AgentState::Waiting));
        assert_eq!(AgentState::from_str("idle"), Some(AgentState::Idle));
        assert_eq!(AgentState::from_str("unknown"), None);
        assert_eq!(AgentState::from_str(""), None);
    }

    // === AgentKind enum tests ===

    #[test]
    fn test_agent_kind_from_str() {
        assert_eq!(AgentKind::from_str("claude"), Some(AgentKind::Claude));
        assert_eq!(AgentKind::from_str("codex"), Some(AgentKind::Codex));
        assert_eq!(AgentKind::from_str("Claude"), None); // case-sensitive
        assert_eq!(AgentKind::from_str(""), None);
        assert_eq!(AgentKind::from_str("unknown"), None);
    }

    // === AttentionReason enum tests ===

    #[test]
    fn test_attention_reason_from_str() {
        assert_eq!(AttentionReason::from_str("decision"), Some(AttentionReason::Decision));
        assert_eq!(AttentionReason::from_str("done"), Some(AttentionReason::Done));
        assert_eq!(AttentionReason::from_str("error"), Some(AttentionReason::Error));
        assert_eq!(AttentionReason::from_str(""), None);
        assert_eq!(AttentionReason::from_str("unknown"), None);
    }
}
