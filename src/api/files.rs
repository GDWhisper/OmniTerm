use axum::{
    body::Body,
    extract::{Multipart, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use tracing::error;

use crate::fs;
use crate::tmux;
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/files", get(list_files).post(upload_file).delete(delete_file))
        .route("/files/download", get(download_file))
        .route("/files/read", get(read_file))
        .route("/files/write", post(write_file))
        .route("/files/mkdir", post(mkdir))
        .route("/files/rename", post(rename))
        .route("/files/move", post(move_files))
        .route("/files/copy", post(copy_files))
        .route("/files/search", get(search_files))
}

#[derive(Deserialize)]
struct FileQuery {
    path: Option<String>,
    workspace: Option<String>,
    session: Option<String>,
    sort: Option<String>,
    order: Option<String>,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    path: Option<String>,
    workspace: Option<String>,
}

#[derive(Deserialize)]
struct RenameRequest {
    path: String,
    #[serde(rename = "newName")]
    new_name: String,
    workspace: Option<String>,
}

#[derive(Deserialize)]
struct MoveRequest {
    paths: Vec<String>,
    destination: String,
    workspace: Option<String>,
}

#[derive(Deserialize)]
struct CopyRequest {
    paths: Vec<String>,
    destination: String,
    workspace: Option<String>,
}

#[derive(Deserialize)]
struct WriteRequest {
    content: String,
}

/// Resolve workspace root path from workspace ID.
async fn resolve_workspace_root(state: &AppState, workspace_id: &str) -> Option<String> {
    sqlx::query_as::<_, (String,)>("SELECT root_path FROM workspaces WHERE id = ?")
        .bind(workspace_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .map(|(p,)| p)
}

fn parse_sort(sort: Option<&str>, order: Option<&str>) -> (fs::SortKey, bool) {
    let key = match sort.as_deref() {
        Some("mtime") => fs::SortKey::Mtime,
        Some("size") => fs::SortKey::Size,
        _ => fs::SortKey::Name,
    };
    let desc = order.as_deref() == Some("desc");
    (key, desc)
}

/// Resolve base path from session ID (via tmux pane CWD).
/// Returns (base_path, tmux_session_name).
async fn resolve_session_base(state: &AppState, session_id: &str) -> Option<(String, String)> {
    let tmux_name: (String,) =
        sqlx::query_as("SELECT tmux_session_name FROM sessions WHERE id = ?")
            .bind(session_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()?;

    let tmux_name = tmux_name.0;
    let cwd = tmux::pane_cwd(&tmux_name).await.ok()?;
    Some((cwd, tmux_name))
}

/// Get workspace root_path for a session (used for is_outside_workspace check).
async fn resolve_session_workspace_root(state: &AppState, session_id: &str) -> Option<String> {
    sqlx::query_as::<_, (String,)>(
        "SELECT w.root_path FROM workspaces w JOIN sessions s ON s.workspace_id = w.id WHERE s.id = ?",
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .map(|(p,)| p)
}

async fn list_files(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
) -> impl IntoResponse {
    let (sort, desc) = parse_sort(q.sort.as_deref(), q.order.as_deref());

    // Session-based mode: resolve CWD from tmux
    if let Some(session_id) = q.session.as_deref() {
        let Some((cwd, _tmux_name)) = resolve_session_base(&state, session_id).await else {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "session not found or tmux unavailable" })),
            );
        };

        let rel_path = q.path.as_deref().unwrap_or("");
        let base = std::path::Path::new(&cwd);

        if !base.exists() {
            return (StatusCode::OK, Json(json!({ "files": [], "cwd": cwd, "is_outside_workspace": true })));
        }

        // Determine if CWD is outside workspace
        let is_outside = if let Some(ws_root) = resolve_session_workspace_root(&state, session_id).await {
            !cwd.starts_with(&ws_root)
        } else {
            false
        };

        // Resolve the actual directory to list
        let list_base = if rel_path.is_empty() || rel_path == "." {
            base.to_path_buf()
        } else if std::path::Path::new(rel_path).is_absolute() {
            std::path::Path::new(rel_path).to_path_buf()
        } else {
            base.join(rel_path)
        };

        // Basic security: ensure path doesn't escape /
        let Ok(canonical) = list_base.canonicalize() else {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "path not found" })),
            );
        };

        match fs::list_dir(&canonical, "", sort, desc).await {
            Ok(entries) => (
                StatusCode::OK,
                Json(json!({ "files": entries, "cwd": canonical.to_string_lossy(), "is_outside_workspace": is_outside })),
            ),
            Err(e) => {
                error!("list_files (session) failed: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": e.to_string() })),
                )
            }
        }
    } else {
        // Original workspace-based mode
        let workspace_id = q.workspace.as_deref().unwrap_or("default");
        let rel_path = q.path.as_deref().unwrap_or("");

        let Some(root) = resolve_workspace_root(&state, workspace_id).await else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "workspace not found" })),
            );
        };

        let base = std::path::Path::new(&root);

        if !base.exists() {
            return (StatusCode::OK, Json(json!([])));
        }

        match fs::list_dir(base, rel_path, sort, desc).await {
            Ok(entries) => (StatusCode::OK, Json(json!(entries))),
            Err(e) => {
                error!("list_files failed: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": e.to_string() })),
                )
            }
        }
    }
}

async fn upload_file(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let workspace_id = q.workspace.as_deref().unwrap_or("default");
    let rel_path = q.path.as_deref().unwrap_or("");

    let Some(root) = resolve_workspace_root(&state, workspace_id).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace not found" })),
        );
    };

    let base = std::path::Path::new(&root);
    let mut uploaded = Vec::new();

    while let Some(field) = multipart.next_field().await.unwrap_or(None) {
        let file_name = field.file_name().unwrap_or("upload").to_string();

        let data = match field.bytes().await {
            Ok(d) => d,
            Err(e) => {
                error!("failed to read upload data: {}", e);
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "read failed" })),
                );
            }
        };

        let target_path = if rel_path.is_empty() {
            file_name.clone()
        } else {
            format!("{}/{}", rel_path.trim_end_matches('/'), file_name)
        };

        if let Err(e) = fs::write_file(base, &target_path, &data).await {
            error!("upload write failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            );
        }

        uploaded.push(json!({
            "name": file_name,
            "path": target_path,
            "size": data.len(),
        }));
    }

    (StatusCode::OK, Json(json!(uploaded)))
}

async fn delete_file(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
) -> impl IntoResponse {
    let Some(path_str) = q.path.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path required" })),
        );
    };

    let workspace_id = q.workspace.as_deref().unwrap_or("default");
    let Some(root) = resolve_workspace_root(&state, workspace_id).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace not found" })),
        );
    };

    let base = std::path::Path::new(&root);

    match fs::delete_path(base, path_str).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            error!("delete failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    }
}

async fn download_file(State(state): State<AppState>, Query(q): Query<FileQuery>) -> Response {
    let Some(path_str) = q.path.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path required" })),
        )
            .into_response();
    };

    let workspace_id = q.workspace.as_deref().unwrap_or("default");
    let Some(root) = resolve_workspace_root(&state, workspace_id).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace not found" })),
        )
            .into_response();
    };

    let base = std::path::Path::new(&root);
    let Ok(full_path) = fs::sanitize_path(base, path_str) else {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "invalid path" }))).into_response();
    };

    let Ok(content) = tokio::fs::read(&full_path).await else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "file not found" }))).into_response();
    };

    let file_name = full_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", file_name),
        )
        .body(Body::from(content))
        .unwrap()
}

async fn read_file(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
) -> impl IntoResponse {
    let Some(path_str) = q.path.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path required" })),
        );
    };

    let workspace_id = q.workspace.as_deref().unwrap_or("default");
    let Some(root) = resolve_workspace_root(&state, workspace_id).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace not found" })),
        );
    };

    let base = std::path::Path::new(&root);

    match fs::read_file(base, path_str).await {
        Ok(content) => (StatusCode::OK, Json(json!({ "content": content }))),
        Err(e) => {
            error!("read_file failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    }
}

async fn write_file(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    Json(req): Json<WriteRequest>,
) -> impl IntoResponse {
    let Some(path_str) = q.path.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path required" })),
        );
    };

    let workspace_id = q.workspace.as_deref().unwrap_or("default");
    let Some(root) = resolve_workspace_root(&state, workspace_id).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace not found" })),
        );
    };

    let base = std::path::Path::new(&root);

    match fs::write_file(base, path_str, req.content.as_bytes()).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            error!("write_file failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    }
}

async fn mkdir(
    State(state): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> impl IntoResponse {
    let workspace_id = req
        .get("workspace")
        .and_then(|v| v.as_str())
        .unwrap_or("default");
    let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let name = req.get("name").and_then(|v| v.as_str()).unwrap_or("");

    let Some(root) = resolve_workspace_root(&state, workspace_id).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace not found" })),
        );
    };

    let base = std::path::Path::new(&root);
    let dir_path = if path.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", path.trim_end_matches('/'), name)
    };

    match fs::create_dir(base, &dir_path).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            error!("mkdir failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    }
}

async fn rename(
    State(state): State<AppState>,
    Json(req): Json<RenameRequest>,
) -> impl IntoResponse {
    let workspace_id = req.workspace.as_deref().unwrap_or("default");
    let Some(root) = resolve_workspace_root(&state, workspace_id).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace not found" })),
        );
    };

    let base = std::path::Path::new(&root);

    // Compute new path: replace the file/dir name in the original path
    let old_path = std::path::Path::new(&req.path);
    let new_rel = match old_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            format!(
                "{}/{}",
                parent.to_string_lossy().trim_end_matches('/'),
                req.new_name
            )
        }
        _ => req.new_name.clone(),
    };

    match fs::move_path(base, &req.path, &new_rel).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            error!("rename failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    }
}

async fn move_files(
    State(state): State<AppState>,
    Json(req): Json<MoveRequest>,
) -> impl IntoResponse {
    let workspace_id = req.workspace.as_deref().unwrap_or("default");
    let Some(root) = resolve_workspace_root(&state, workspace_id).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace not found" })),
        );
    };

    let base = std::path::Path::new(&root);

    // Move each path to destination directory
    for p in &req.paths {
        let file_name = std::path::Path::new(p)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let dest = format!(
            "{}/{}",
            req.destination.trim_end_matches('/'),
            file_name
        );
        if let Err(e) = fs::move_path(base, p, &dest).await {
            error!("move failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            );
        }
    }

    (StatusCode::OK, Json(json!({ "ok": true })))
}

async fn copy_files(
    State(state): State<AppState>,
    Json(req): Json<CopyRequest>,
) -> impl IntoResponse {
    let workspace_id = req.workspace.as_deref().unwrap_or("default");
    let Some(root) = resolve_workspace_root(&state, workspace_id).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace not found" })),
        );
    };

    let base = std::path::Path::new(&root);

    match fs::copy_paths(base, &req.paths, &req.destination).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            error!("copy failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    }
}

async fn search_files(
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> impl IntoResponse {
    let workspace_id = q.workspace.as_deref().unwrap_or("default");
    let rel_path = q.path.as_deref().unwrap_or("");

    let Some(root) = resolve_workspace_root(&state, workspace_id).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace not found" })),
        );
    };

    let base = std::path::Path::new(&root);

    match fs::search_files(base, rel_path, &q.q).await {
        Ok(entries) => (StatusCode::OK, Json(json!(entries))),
        Err(e) => {
            error!("search failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    }
}
