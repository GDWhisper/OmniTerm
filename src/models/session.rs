use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub name: Option<String>,
    pub tmux_session_name: Option<String>,
    pub hook_enabled: bool,
    pub hook_status: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateSession {
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSession {
    pub name: Option<String>,
}
