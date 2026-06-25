use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, patch},
    Json, Router,
};
use serde_json::json;
use uuid::Uuid;

use crate::models::project::{CreateProject, Project, UpdateProject};
use crate::workspaces;
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects", get(list_projects).post(create_project))
        .route(
            "/projects/{id}",
            patch(update_project).delete(delete_project),
        )
        .route("/projects/{id}/worktrees", get(list_worktrees))
}

async fn list_projects(State(state): State<AppState>) -> impl IntoResponse {
    let projects: Vec<Project> =
        sqlx::query_as("SELECT * FROM projects ORDER BY created_at DESC")
            .fetch_all(&state.db)
            .await
            .unwrap();

    Json(json!(projects))
}

async fn create_project(
    State(state): State<AppState>,
    Json(req): Json<CreateProject>,
) -> impl IntoResponse {
    // Expand ~ to actual home directory
    let path = if req.path == "~" || req.path.starts_with("~/") {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".into());
        req.path.replacen('~', &home, 1)
    } else {
        req.path.clone()
    };

    // Auto-create directory if it doesn't exist
    if let Err(e) = tokio::fs::create_dir_all(&path).await {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("cannot create path: {}", e) })),
        );
    }

    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO projects (id, target_id, name, path, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&req.target_id)
    .bind(&req.name)
    .bind(&path)
    .bind(&now)
    .execute(&state.db)
    .await
    .unwrap();

    let project = Project {
        id,
        target_id: req.target_id,
        name: req.name,
        path,
        created_at: now,
    };

    (StatusCode::CREATED, Json(json!(project)))
}

async fn update_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<UpdateProject>,
) -> impl IntoResponse {
    let result = sqlx::query("UPDATE projects SET name = COALESCE(?, name) WHERE id = ?")
        .bind(req.name)
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    if result.rows_affected() == 0 {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    }

    let project: Project = sqlx::query_as("SELECT * FROM projects WHERE id = ?")
        .bind(&id)
        .fetch_one(&state.db)
        .await
        .unwrap();

    (StatusCode::OK, Json(json!(project)))
}

async fn delete_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Cascade: delete sessions first
    sqlx::query("DELETE FROM sessions WHERE project_id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    let result = sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    if result.rows_affected() == 0 {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    }

    (StatusCode::OK, Json(json!({ "ok": true })))
}

async fn list_worktrees(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let project: Option<Project> = sqlx::query_as("SELECT * FROM projects WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await
        .unwrap();

    let Some(project) = project else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "project not found" })));
    };

    let ws_list = workspaces::list_workspaces(&project).await;
    (StatusCode::OK, Json(json!(ws_list)))
}
