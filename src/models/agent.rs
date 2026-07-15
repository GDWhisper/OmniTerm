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
/// `api_key_value` is Phase 3 plaintext; Phase 5 will migrate to keychain.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub display_name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<AgentEnvVar>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key_env_var: Option<String>,
    /// Never serialize the plaintext key value back to clients — API layer
    /// masks it. The field stays here so we can build spawn env internally.
    #[serde(skip_serializing)]
    pub api_key_value: Option<String>,
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
    pub api_key_env_var: Option<String>,
    pub api_key_value: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAgent {
    pub display_name: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<Vec<AgentEnvVar>>,
    pub api_key_env_var: Option<String>,
    pub api_key_value: Option<String>,
}
