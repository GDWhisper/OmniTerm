use serde::{Deserialize, Serialize};

/// A single environment variable to pass to the agent process.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEnvVar {
    pub key: String,
    pub value: String,
}

/// Configuration for spawning an ACP-compatible agent process.
///
/// Stored one row per agent in the `agents` table. `args` and `env` are
/// serialized as JSON strings in DB (SQLite has no native array type).
///
/// Credential management is the agent's own responsibility — OmniTerm only
/// spawns the process and speaks ACP over its stdio. Users who want to
/// inject env vars (e.g. `ANTHROPIC_API_KEY`) can do so via `env`, but
/// there is no first-class api-key field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub display_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<AgentEnvVar>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateAgent {
    pub id: Option<String>,
    pub display_name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<AgentEnvVar>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAgent {
    pub display_name: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<Vec<AgentEnvVar>>,
}
