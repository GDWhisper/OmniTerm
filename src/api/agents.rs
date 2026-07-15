use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde_json::json;
use uuid::Uuid;

use crate::models::agent::{Agent, AgentEnvVar, CreateAgent, UpdateAgent};
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/agents", get(list_agents).post(create_agent))
        .route(
            "/agents/{id}",
            get(get_agent).put(update_agent).delete(delete_agent),
        )
}

#[derive(sqlx::FromRow)]
struct AgentRow {
    id: String,
    display_name: String,
    command: String,
    args: String,
    env: String,
    api_key_env_var: Option<String>,
    api_key_value: Option<String>,
    created_at: String,
    updated_at: String,
}

impl AgentRow {
    fn into_agent(self) -> Agent {
        let args: Vec<String> = serde_json::from_str(&self.args).unwrap_or_default();
        let env: Vec<AgentEnvVar> = serde_json::from_str(&self.env).unwrap_or_default();
        Agent {
            id: self.id,
            display_name: self.display_name,
            command: self.command,
            args,
            env,
            api_key_env_var: self.api_key_env_var,
            api_key_value: self.api_key_value,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }
}

async fn list_agents(State(state): State<AppState>) -> impl IntoResponse {
    let rows: Vec<AgentRow> = sqlx::query_as("SELECT * FROM agents ORDER BY created_at DESC")
        .fetch_all(&state.db)
        .await
        .unwrap_or_default();

    let agents: Vec<Agent> = rows.into_iter().map(AgentRow::into_agent).collect();
    Json(json!(agents))
}

async fn get_agent(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    let row: Option<AgentRow> = sqlx::query_as("SELECT * FROM agents WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await
        .unwrap();

    match row {
        Some(r) => (StatusCode::OK, Json(json!(r.into_agent()))),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "not found" })),
        ),
    }
}

async fn create_agent(
    State(state): State<AppState>,
    Json(req): Json<CreateAgent>,
) -> impl IntoResponse {
    let id = req.id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let args_json = serde_json::to_string(&req.args).unwrap_or_else(|_| "[]".into());
    let env_json = serde_json::to_string(&req.env).unwrap_or_else(|_| "[]".into());

    let result = sqlx::query(
        "INSERT INTO agents (id, display_name, command, args, env, api_key_env_var, api_key_value, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&req.display_name)
    .bind(&req.command)
    .bind(&args_json)
    .bind(&env_json)
    .bind(&req.api_key_env_var)
    .bind(&req.api_key_value)
    .bind(&now)
    .bind(&now)
    .execute(&state.db)
    .await;

    if let Err(e) = result {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        );
    }

    let agent = Agent {
        id,
        display_name: req.display_name,
        command: req.command,
        args: req.args,
        env: req.env,
        api_key_env_var: req.api_key_env_var,
        api_key_value: req.api_key_value,
        created_at: now.clone(),
        updated_at: now,
    };

    (StatusCode::CREATED, Json(json!(agent)))
}

async fn update_agent(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateAgent>,
) -> impl IntoResponse {
    let existing: Option<AgentRow> = sqlx::query_as("SELECT * FROM agents WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await
        .unwrap();

    let Some(existing) = existing else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "not found" })),
        );
    };
    let mut current = existing.into_agent();

    if let Some(v) = req.display_name {
        current.display_name = v;
    }
    if let Some(v) = req.command {
        current.command = v;
    }
    if let Some(v) = req.args {
        current.args = v;
    }
    if let Some(v) = req.env {
        current.env = v;
    }
    if let Some(v) = req.api_key_env_var {
        current.api_key_env_var = Some(v);
    }
    if let Some(v) = req.api_key_value {
        current.api_key_value = Some(v);
    }
    current.updated_at = chrono::Utc::now().to_rfc3339();

    let args_json = serde_json::to_string(&current.args).unwrap_or_else(|_| "[]".into());
    let env_json = serde_json::to_string(&current.env).unwrap_or_else(|_| "[]".into());

    sqlx::query(
        "UPDATE agents SET display_name = ?, command = ?, args = ?, env = ?, api_key_env_var = ?, api_key_value = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&current.display_name)
    .bind(&current.command)
    .bind(&args_json)
    .bind(&env_json)
    .bind(&current.api_key_env_var)
    .bind(&current.api_key_value)
    .bind(&current.updated_at)
    .bind(&id)
    .execute(&state.db)
    .await
    .unwrap();

    (StatusCode::OK, Json(json!(current)))
}

async fn delete_agent(State(state): State<AppState>, Path(id): Path<String>) -> impl IntoResponse {
    let result = sqlx::query("DELETE FROM agents WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    if result.rows_affected() == 0 {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    }
    (StatusCode::OK, Json(json!({ "ok": true })))
}

/// Load an agent for internal use (spawn env includes plaintext api key).
pub async fn load_agent(db: &sqlx::SqlitePool, id: &str) -> Option<Agent> {
    let row: Option<AgentRow> = sqlx::query_as("SELECT * FROM agents WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    row.map(AgentRow::into_agent)
}
