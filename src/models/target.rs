use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Target {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub target_type: String, // local | ssh | wsl
    pub config: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateTarget {
    pub name: String,
    #[serde(rename = "type")]
    pub target_type: String,
    pub config: Option<String>,
}
