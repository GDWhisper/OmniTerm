use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::json;
use tracing::error;

use crate::tmux;
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/sessions/{id}/hook-status", get(hook_status))
        .route("/sessions/{id}/hook-enable", post(hook_enable))
        .route("/sessions/{id}/hook-disable", post(hook_disable))
}

async fn hook_status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let session: Option<(String, bool)> =
        sqlx::query_as("SELECT tmux_session_name, hook_enabled FROM sessions WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

    let Some((tmux_name, hook_enabled)) = session else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "session not found" })));
    };

    if !hook_enabled {
        return (
            StatusCode::OK,
            Json(json!({
                "enabled": false,
                "state": "idle",
            })),
        );
    }

    match tmux::capture_pane(&tmux_name, 50).await {
        Ok(content) => {
            let status = tmux::hooks::scan_agent_state(&content);
            (
                StatusCode::OK,
                Json(json!({
                    "enabled": true,
                    "state": status.state,
                    "agent_kind": status.agent_kind,
                    "detail": status.detail,
                })),
            )
        }
        Err(e) => {
            error!("failed to capture pane: {}", e);
            (
                StatusCode::OK,
                Json(json!({
                    "enabled": true,
                    "state": "unknown",
                    "detail": format!("capture failed: {}", e),
                })),
            )
        }
    }
}

async fn hook_enable(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let result = sqlx::query("UPDATE sessions SET hook_enabled = 1 WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await;

    match result {
        Ok(r) if r.rows_affected() > 0 => {
            (StatusCode::OK, Json(json!({ "ok": true, "hook_enabled": true })))
        }
        Ok(_) => {
            (StatusCode::NOT_FOUND, Json(json!({ "error": "session not found" })))
        }
        Err(e) => {
            error!("failed to enable hook: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "db error" })))
        }
    }
}

async fn hook_disable(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    let result = sqlx::query("UPDATE sessions SET hook_enabled = 0, hook_status = NULL WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await;

    match result {
        Ok(r) if r.rows_affected() > 0 => {
            (StatusCode::OK, Json(json!({ "ok": true, "hook_enabled": false })))
        }
        Ok(_) => {
            (StatusCode::NOT_FOUND, Json(json!({ "error": "session not found" })))
        }
        Err(e) => {
            error!("failed to disable hook: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": "db error" })))
        }
    }
}
