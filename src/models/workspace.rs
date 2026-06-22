use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Workspace {
    pub id: String,
    pub target_id: Option<String>,
    pub name: String,
    pub root_path: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkspace {
    pub name: String,
    pub root_path: String,
    pub target_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspace {
    pub name: Option<String>,
}
