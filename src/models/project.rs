use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Project {
    pub id: String,
    pub target_id: Option<String>,
    pub name: String,
    pub path: String,
    pub created_at: String,
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
}
