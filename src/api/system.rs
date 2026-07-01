use axum::{extract::{Query, State}, http::StatusCode, routing::get, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::fs::{self, SortKey};
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/system/info", get(system_info))
        .route("/system/dirs", get(list_dirs))
        .route("/system/exists", get(check_exists))
}

#[derive(Deserialize)]
struct ListDirsQuery {
    path: String,
}

async fn system_info() -> Json<Value> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".into());

    Json(json!({
        "home_dir": home,
    }))
}

/// List directory entries for a given absolute path.
///
/// Used by the new-project modal to let users browse the filesystem
/// before they have any project/workspace context. Returns ALL entries
/// (directories and files); the frontend filters to directories only.
async fn list_dirs(
    State(_state): State<AppState>,
    Query(q): Query<ListDirsQuery>,
) -> (axum::http::StatusCode, Json<Value>) {
    let path = std::path::Path::new(&q.path);

    // Canonicalize to resolve `..` and symlinks; reject non-existent paths.
    let canonical = match path.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                Json(json!({ "error": "path not found" })),
            );
        }
    };

    if !canonical.is_dir() {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": "not a directory" })),
        );
    }

    match fs::list_dir(&canonical, "", SortKey::Name, false).await {
        Ok(entries) => (
            axum::http::StatusCode::OK,
            Json(json!({ "files": entries })),
        ),
        Err(e) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[derive(Deserialize)]
struct ExistsQuery {
    path: String,
}

/// Check if a path exists on disk.
/// Used by the frontend to detect stale project paths.
async fn check_exists(
    Query(q): Query<ExistsQuery>,
) -> (StatusCode, Json<Value>) {
    let exists = std::path::Path::new(&q.path).exists();
    (StatusCode::OK, Json(json!({ "exists": exists })))
}
