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
            "/workspaces/{wid}/sessions",
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
    Path(wid): Path<String>,
) -> impl IntoResponse {
    let sessions: Vec<Session> =
        sqlx::query_as("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY created_at DESC")
            .bind(&wid)
            .fetch_all(&state.db)
            .await
            .unwrap();

    Json(json!(sessions))
}

async fn create_session(
    State(state): State<AppState>,
    Path(wid): Path<String>,
    Json(req): Json<CreateSession>,
) -> impl IntoResponse {
    // Look up workspace root_path for tmux cwd
    let workspace: Option<(String,)> =
        sqlx::query_as("SELECT root_path FROM workspaces WHERE id = ?")
            .bind(&wid)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

    let root_path = workspace
        .map(|(p,)| p)
        .unwrap_or_else(|| {
            dirs().unwrap_or_else(|| "/tmp".to_string())
        });

    // Expand ~ and validate root_path exists
    let root_path = if root_path == "~" || root_path.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        root_path.replacen('~', &home, 1)
    } else {
        root_path
    };
    let root_path = if std::path::Path::new(&root_path).exists() {
        root_path
    } else {
        std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
    };

    let id = Uuid::new_v4().to_string();
    let tmux_name = format!("lt_{}", &id[..8]);
    let now = chrono::Utc::now().to_rfc3339();

    // Create the tmux session
    if let Err(e) = tmux::new_session(&tmux_name, &root_path).await {
        error!("failed to create tmux session: {}", e);
        // Continue anyway - the session record is still useful
    } else {
        info!("created tmux session: {} (cwd: {})", tmux_name, root_path);
    }

    sqlx::query(
        "INSERT INTO sessions (id, workspace_id, name, tmux_session_name, hook_enabled, hook_status, created_at) VALUES (?, ?, ?, ?, 0, NULL, ?)",
    )
    .bind(&id)
    .bind(&wid)
    .bind(&req.name)
    .bind(&tmux_name)
    .bind(&now)
    .execute(&state.db)
    .await
    .unwrap();

    let session = Session {
        id,
        workspace_id: wid,
        name: req.name,
        tmux_session_name: Some(tmux_name),
        hook_enabled: false,
        hook_status: None,
        created_at: now,
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
