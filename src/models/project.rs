use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Project {
    pub id: String,
    pub target_id: Option<String>,
    pub name: String,
    pub path: String,
    pub created_at: String,
    /// Whether the project path currently exists on disk. Computed at query
    /// time by `list_projects` (and refreshed on create/update responses).
    /// `#[sqlx(default)]` keeps `SELECT *` rows (no such column) valid.
    #[serde(default)]
    #[sqlx(default)]
    pub path_valid: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateProject {
    pub name: String,
    pub path: String,
    pub target_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProject {
    pub name: Option<String>,
    pub path: Option<String>,
}
