use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{delete, get},
    Json, Router,
};
use serde_json::json;
use uuid::Uuid;

use crate::models::target::{CreateTarget, Target};
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/targets", get(list_targets).post(create_target))
        .route("/targets/{id}", delete(delete_target))
}

async fn list_targets(State(state): State<AppState>) -> impl IntoResponse {
    let targets: Vec<Target> = sqlx::query_as("SELECT * FROM targets ORDER BY created_at DESC")
        .fetch_all(&state.db)
        .await
        .unwrap();

    Json(json!(targets))
}

async fn create_target(
    State(state): State<AppState>,
    Json(req): Json<CreateTarget>,
) -> impl IntoResponse {
    let id = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT INTO targets (id, name, type, config, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&req.name)
    .bind(&req.target_type)
    .bind(&req.config)
    .bind(&now)
    .execute(&state.db)
    .await
    .unwrap();

    let target = Target {
        id,
        name: req.name,
        target_type: req.target_type,
        config: req.config,
        created_at: now,
    };

    (StatusCode::CREATED, Json(json!(target)))
}

async fn delete_target(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let result = sqlx::query("DELETE FROM targets WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
        .unwrap();

    if result.rows_affected() == 0 {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" })));
    }

    (StatusCode::OK, Json(json!({ "ok": true })))
}
