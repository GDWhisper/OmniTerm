use serde::Serialize;

/// Agent state detected from tmux pane content.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    /// Agent is actively running (processing, calling tools)
    Running,
    /// Agent is waiting for user decision (permission request, prompt)
    Decision,
    /// Agent finished successfully
    Finished,
    /// Agent encountered an error
    Error,
    /// No agent detected or agent is idle
    Idle,
}

/// Result of scanning a tmux pane for agent activity.
#[derive(Debug, Clone, Serialize)]
pub struct AgentStatus {
    pub state: AgentState,
    pub agent_kind: Option<String>, // "claude", "codex", etc.
    pub detail: Option<String>,
}

/// Scan the last N lines of tmux pane content and detect agent state.
///
/// This is a heuristic-based scanner that looks for common patterns
/// in Claude Code / Codex terminal output.
///
/// #[deprecated] Use `agent_state::parse_agent_value()` with the `@omniterm_agent`
/// tmux session option instead. This heuristic scanner is retained as a fallback
/// for sessions where hooks have not been injected. It will be removed after
/// 1-2 weeks of stable hook-driven operation.
#[deprecated(since = "0.5.0", note = "use agent_state::parse_agent_value() with @omniterm_agent session option instead")]
pub fn scan_agent_state(pane_content: &str) -> AgentStatus {
    let lines: Vec<&str> = pane_content.lines().collect();
    let tail: String = lines.iter().rev().take(30).copied().collect::<Vec<_>>().join("\n");
    let tail_lower = tail.to_lowercase();

    // Detect agent kind
    let agent_kind = if tail_lower.contains("claude code") || tail_lower.contains("claude-code") {
        Some("claude".to_string())
    } else if tail_lower.contains("codex") {
        Some("codex".to_string())
    } else {
        None
    };

    // Check for permission/decision prompts (highest priority — user needs to act)
    if is_decision_state(&tail_lower) {
        return AgentStatus {
            state: AgentState::Decision,
            agent_kind,
            detail: Some("waiting for user decision".to_string()),
        };
    }

    // Check for errors
    if is_error_state(&tail_lower) {
        return AgentStatus {
            state: AgentState::Error,
            agent_kind,
            detail: Some("agent error detected".to_string()),
        };
    }

    // Check for completion
    if is_finished_state(&tail_lower) {
        return AgentStatus {
            state: AgentState::Finished,
            agent_kind,
            detail: Some("agent finished".to_string()),
        };
    }

    // Check for running indicators
    if is_running_state(&tail_lower) {
        return AgentStatus {
            state: AgentState::Running,
            agent_kind,
            detail: Some("agent is running".to_string()),
        };
    }

    AgentStatus {
        state: AgentState::Idle,
        agent_kind,
        detail: None,
    }
}

/// Detect permission/decision prompts.
fn is_decision_state(text: &str) -> bool {
    // Claude Code permission patterns
    text.contains("do you want to proceed")
        || text.contains("allow")
            && (text.contains("?") || text.contains("y/n"))
        || text.contains("permission")
            && (text.contains("required") || text.contains("request"))
        || text.contains("approve")
            && text.contains("?")
        || text.contains("(y/n)")
        || text.contains("[y/n]")
        // Codex patterns
        || text.contains("approve this action")
        || text.contains("confirm to continue")
}

/// Detect error states.
fn is_error_state(text: &str) -> bool {
    text.contains("error:")
        || text.contains("fatal:")
        || text.contains("panic:")
        || text.contains("traceback")
        || text.contains("exception:")
        || text.contains("failed:")
        || text.contains("abort")
}

/// Detect completion states.
fn is_finished_state(text: &str) -> bool {
    text.contains("task completed")
        || text.contains("done.")
        || text.contains("finished.")
        || text.contains("all tasks completed")
        || (text.contains("claude") && text.contains("exited"))
}

/// Detect active running states.
fn is_running_state(text: &str) -> bool {
    // Spinner characters or progress indicators
    text.contains("⠋")
        || text.contains("⠙")
        || text.contains("⠹")
        || text.contains("⠸")
        || text.contains("⠼")
        || text.contains("⠴")
        || text.contains("⠦")
        || text.contains("⠧")
        || text.contains("⠇")
        || text.contains("⠏")
        // Common running indicators
        || text.contains("thinking...")
        || text.contains("processing...")
        || text.contains("running...")
        || text.contains("executing...")
        // Tool use patterns
        || text.contains("calling tool")
        || text.contains("using tool")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_idle_state() {
        let status = scan_agent_state("$ echo hello\nhello\n$ _");
        assert_eq!(status.state, AgentState::Idle);
    }

    #[test]
    fn test_decision_state() {
        let status = scan_agent_state("Do you want to proceed? (y/n) _");
        assert_eq!(status.state, AgentState::Decision);
    }

    #[test]
    fn test_error_state() {
        let status = scan_agent_state("Error: connection refused\n$ _");
        assert_eq!(status.state, AgentState::Error);
    }

    #[test]
    fn test_running_state() {
        let status = scan_agent_state("⠹ thinking...\n");
        assert_eq!(status.state, AgentState::Running);
        assert_eq!(status.agent_kind, None);
    }

    #[test]
    fn test_claude_detected() {
        let status = scan_agent_state("Claude Code v1.0\n⠹ thinking...\n");
        assert_eq!(status.state, AgentState::Running);
        assert_eq!(status.agent_kind, Some("claude".to_string()));
    }
}
