use serde::{Deserialize, Serialize};

fn is_false(v: &bool) -> bool {
    !*v
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
}

#[derive(Debug, Deserialize)]
pub struct CreateSession {
    pub name: Option<String>,
    pub workspace_path: String,
    /// Optional command to run in the session (e.g. "claude" for Claude Code).
    /// If absent, a plain shell is started.
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSession {
    pub name: Option<String>,
}
