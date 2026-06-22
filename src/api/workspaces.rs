use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, patch},
    Json, Router,
};
use serde_json::json;
use uuid::Uuid;

use crate::models::workspace::{CreateWorkspace, UpdateWorkspace, Workspace};
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/workspaces", get(list_workspaces).post(create_workspace))
        .route(
            "/workspaces/{id}",
            patch(update_workspace).delete(delete_workspace),
        )
}

async fn list_workspaces(State(state): State<AppState>) -> impl IntoResponse {
    let workspaces: Vec<Workspace> =
        sqlx::query_as("SELECT * FROM workspaces ORDER BY created_at DESC")
            .fetch_all(&state.db)
            .await
            .unwrap();

    Json(json!(workspaces))
}

async fn create_workspace(
    State(state): State<AppState>,
    Json(req): Json<CreateWorkspace>,
) -> impl IntoResponse {
    // Expand ~ to actual home directory
    let root_path = if req.root_path == "~" || req.root_path.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        req.root_path.replacen('~', &home, 1)
    } else {
        req.root_path.clone()
    };

    // Auto-create root directory if it doesn't exist
    if let Err(e) = tokio::fs::create_dir_all(&root_path).await {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("cannot create root path: {}", e) })),
        );
    }

    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO workspaces (id, target_id, name, root_path, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&req.target_id)
    .bind(&req.name)
    .bind(&root_path)
    .bind(&now)
    .execute(&state.db)
    .await
    .unwrap();

    let workspace = Workspace {
        id,
        target_id: req.target_id,
        name: req.name,
        root_path,
        created_at: now,
    };

    (StatusCode::CREATED, Json(json!(workspace)))
}

async fn update_workspace(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateWorkspace>,
) -> impl IntoResponse {
    let result = sqlx::query("UPDATE workspaces SET name = COALESCE(?, name) WHERE id = ?")
        .bind(req.name)
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    if result.rows_affected() == 0 {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    }

    let workspace: Workspace = sqlx::query_as("SELECT * FROM workspaces WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .unwrap();

    (StatusCode::OK, Json(json!(workspace)))
}

async fn delete_workspace(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Cascade: delete sessions first
    sqlx::query("DELETE FROM sessions WHERE workspace_id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    let result = sqlx::query("DELETE FROM workspaces WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    if result.rows_affected() == 0 {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    }

    (StatusCode::OK, Json(json!({ "ok": true })))
}
