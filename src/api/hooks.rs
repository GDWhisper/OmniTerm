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

    // First, try to read agent state from the tmux session option
    match tmux::get_session_agent_option(&tmux_name).await {
        Ok(Some(snapshot)) => {
            return (
                StatusCode::OK,
                Json(json!({
                    "enabled": true,
                    "state": snapshot.agent_state.as_str(),
                    "agent_kind": snapshot.agent_kind.as_str(),
                    "attention_reason": snapshot.attention_reason.map(|r| r.as_str()),
                    "agent_event": snapshot.agent_event,
                    "agent_nonce": snapshot.agent_nonce,
                })),
            );
        }
        Ok(None) => {
            // Option not set — hooks may not have been injected yet
        }
        Err(e) => {
            tracing::warn!("failed to read agent option for {}: {}", tmux_name, e);
        }
    }

    // No structured agent state available — hooks not yet injected or session is bare shell
    (
        StatusCode::OK,
        Json(json!({
            "enabled": true,
            "state": "unknown",
            "detail": "agent hooks not injected yet",
        })),
    )
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
            // Try to detect agent CLI and inject hooks if possible
            // (Best effort — the session might not have a running agent process,
            // in which case hook-status will fall back to heuristic scanning.)
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
