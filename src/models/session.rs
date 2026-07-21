use serde::{Deserialize, Serialize};

fn is_false(v: &bool) -> bool {
    !*v
}

/// Which runtime backs a session.
///
/// - `Tmux`: session driven by a tmux pane; identified by `tmux_session_name`.
/// - `Acp`: session driven by an ACP adapter subprocess; identified by `acp_session_id`.
///
/// Default flipped from `Tmux` (Phase 2) to `Acp` in Phase 4 once the frontend
/// Chat view landed. Callers that still want a tmux session must pass
/// `runtime_kind = 'tmux'` explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, sqlx::Type, Serialize, Deserialize)]
#[sqlx(rename_all = "lowercase")]
#[serde(rename_all = "lowercase")]
pub enum RuntimeKind {
    Tmux,
    Acp,
}

impl Default for RuntimeKind {
    fn default() -> Self {
        RuntimeKind::Acp
    }
}

/// Request DTO for adopting an external tmux session into a project.
#[derive(Debug, Deserialize)]
pub struct AdoptSession {
    pub tmux_name: String,
    pub project_id: String,
}

/// Response type for GET /sessions/external — a tmux session not yet in the DB,
/// enriched with CWD.
#[derive(Debug, Serialize)]
pub struct ExternalSessionResponse {
    pub name: String,
    pub attached: bool,
    pub windows: u32,
    pub created: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_nonce: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub workspace_path: String,
    pub name: Option<String>,
    pub tmux_session_name: Option<String>,
    pub hook_enabled: bool,
    pub hook_status: Option<String>,
    pub created_at: String,
    /// Which runtime drives this session. Persisted, defaults to `tmux` in DB.
    #[sqlx(default)]
    pub runtime_kind: RuntimeKind,
    /// ACP adapter session id when `runtime_kind = 'acp'`. NULL for tmux sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub acp_session_id: Option<String>,
    /// Which agent registry row this session was spawned from. Required for
    /// `runtime_kind = 'acp'`, NULL for tmux sessions.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_id: Option<String>,
    // Runtime activity indicator (tmux control mode, not persisted)
    #[serde(skip_serializing_if = "is_false")]
    #[sqlx(default)]
    pub is_active: bool,
    // Agent state fields (read-only, derived from tmux option at query time, not persisted)
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub attention_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_nonce: Option<String>,
    // Agent process detection (runtime, not persisted)
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub agent_detected: Option<String>,
    // ACP agent subprocess currently resident in the supervisor (runtime, not persisted).
    // `true` = process alive and reachable; `false` = released/reaped, session can be restored.
    #[serde(skip_serializing_if = "is_false")]
    #[sqlx(default)]
    pub acp_process_alive: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateSession {
    pub name: Option<String>,
    pub workspace_path: String,
    /// Optional command to run in the session (e.g. "claude" for Claude Code).
    /// If absent, a plain shell is started.
    #[serde(default)]
    pub command: Option<String>,
    /// Which runtime to use. Absent/null → server default (`RuntimeKind::default()`).
    #[serde(default)]
    pub runtime_kind: Option<RuntimeKind>,
    /// Which agent to use when `runtime_kind = 'acp'`. Required in that branch.
    #[serde(default)]
    pub agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSession {
    pub name: Option<String>,
}
