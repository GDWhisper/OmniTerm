use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, patch},
    Json, Router,
};
use serde_json::json;
use tracing::{error, info};
use uuid::Uuid;

use crate::models::session::{CreateSession, Session, UpdateSession};
use crate::tmux;
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/{pid}/sessions",
            get(list_sessions).post(create_session),
        )
        .route(
            "/sessions/{id}",
            patch(update_session).delete(delete_session),
        )
        .route("/sessions/{id}/cwd", get(get_session_cwd))
}

async fn list_sessions(
    State(state): State<AppState>,
    Path(pid): Path<String>,
) -> impl IntoResponse {
    let mut sessions: Vec<Session> =
        sqlx::query_as("SELECT * FROM sessions WHERE project_id = ? ORDER BY created_at DESC")
            .bind(&pid)
            .fetch_all(&state.db)
            .await
            .unwrap();

    // Enrich sessions with agent state from tmux
    for session in &mut sessions {
        if let Some(ref tmux_name) = session.tmux_session_name {
            if let Ok(Some(snapshot)) = tmux::get_session_agent_option(tmux_name).await {
                session.agent_kind = Some(snapshot.agent_kind.as_str().to_string());
                session.agent_state = Some(snapshot.agent_state.as_str().to_string());
                session.attention_reason = snapshot.attention_reason.map(|r| r.as_str().to_string());
                session.agent_event = snapshot.agent_event;
                session.agent_nonce = snapshot.agent_nonce;
            }
        }
    }

    Json(json!(sessions))
}

async fn create_session(
    State(state): State<AppState>,
    Path(pid): Path<String>,
    Json(req): Json<CreateSession>,
) -> impl IntoResponse {
    // Resolve workspace_path: use provided path, fallback to project path
    let workspace_path = if req.workspace_path.is_empty() {
        // Fallback: get project path
        let project_path: Option<(String,)> =
            sqlx::query_as("SELECT path FROM projects WHERE id = ?")
                .bind(&pid)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten();
        project_path
            .map(|(p,)| p)
            .unwrap_or_else(|| dirs().unwrap_or_else(|| "/tmp".to_string()))
    } else {
        req.workspace_path.clone()
    };

    // Expand ~ and validate workspace_path exists
    let workspace_path = if workspace_path == "~" || workspace_path.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        workspace_path.replacen('~', &home, 1)
    } else {
        workspace_path
    };
    let workspace_path = if std::path::Path::new(&workspace_path).exists() {
        workspace_path
    } else {
        std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
    };

    let id = Uuid::new_v4().to_string();
    let tmux_name = format!("lt_{}", &id[..8]);
    let now = chrono::Utc::now().to_rfc3339();

    // Create the tmux session; detect agent and inject hooks if applicable
    let hook_enabled = match tmux::new_session(&tmux_name, &workspace_path, req.command.as_deref()).await {
        Ok(injected) => {
            info!("created tmux session: {} (cwd: {})", tmux_name, workspace_path);
            injected && req.command.is_some()
        }
        Err(e) => {
            error!("failed to create tmux session: {}", e);
            false
        }
    };

    sqlx::query(
        "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, hook_enabled, hook_status, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
    )
    .bind(&id)
    .bind(&pid)
    .bind(&workspace_path)
    .bind(&req.name)
    .bind(&tmux_name)
    .bind(hook_enabled as i32)
    .bind(&now)
    .execute(&state.db)
    .await
    .unwrap();

    let session = Session {
        id,
        project_id: pid,
        workspace_path,
        name: req.name,
        tmux_session_name: Some(tmux_name),
        hook_enabled,
        hook_status: None,
        created_at: now,
        agent_kind: None,
        agent_state: None,
        attention_reason: None,
        agent_event: None,
        agent_nonce: None,
    };

    (StatusCode::CREATED, Json(json!(session)))
}

async fn update_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateSession>,
) -> impl IntoResponse {
    let result = sqlx::query("UPDATE sessions SET name = COALESCE(?, name) WHERE id = ?")
        .bind(req.name)
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    if result.rows_affected() == 0 {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    }

    let session: Session = sqlx::query_as("SELECT * FROM sessions WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .unwrap();

    (StatusCode::OK, Json(json!(session)))
}

async fn delete_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Look up tmux session name before deleting
    let tmux_name: Option<(String,)> =
        sqlx::query_as("SELECT tmux_session_name FROM sessions WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

    let result = sqlx::query("DELETE FROM sessions WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    if result.rows_affected() == 0 {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    }

    // Kill the tmux session
    if let Some((tmux_name,)) = tmux_name {
        if let Err(e) = tmux::kill_session(&tmux_name).await {
            error!("failed to kill tmux session {}: {}", tmux_name, e);
        }
    }

    (StatusCode::OK, Json(json!({ "ok": true })))
}

async fn get_session_cwd(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Look up tmux session name
    let tmux_name: Option<(String,)> =
        sqlx::query_as("SELECT tmux_session_name FROM sessions WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

    let Some((tmux_name,)) = tmux_name else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "session not found" })),
        );
    };

    match tmux::pane_cwd(&tmux_name).await {
        Ok(cwd) => (StatusCode::OK, Json(json!({ "cwd": cwd }))),
        Err(e) => {
            error!("pane_cwd failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    }
}

fn dirs() -> Option<String> {
    std::env::var("HOME").ok()
}
