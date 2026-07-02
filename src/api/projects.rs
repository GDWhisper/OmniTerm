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
use crate::workspaces::{self, CoverKind};
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects", get(list_projects).post(create_project))
        .route("/projects/duplicates", get(list_duplicates))
        .route(
            "/projects/{id}",
            patch(update_project).delete(delete_project),
        )
        .route("/projects/{id}/worktrees", get(list_worktrees))
        .route(
            "/projects/{id}/merge-into/{target_id}",
            axum::routing::post(merge_project_into),
        )
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

    // Coverage check: if another project already covers this path (exact
    // match or shared git repo), reject with 409 so the UI can offer to
    // switch to the existing project instead of creating a duplicate.
    let existing: Vec<Project> =
        sqlx::query_as("SELECT * FROM projects ORDER BY created_at DESC")
            .fetch_all(&state.db)
            .await
            .unwrap_or_default();

    match workspaces::find_covering_project(std::path::Path::new(&path), &existing).await {
        Ok(Some((cover, kind))) => {
            let reason = match kind {
                CoverKind::ExactPath => "exact_path",
                CoverKind::WorktreeChild => "worktree_child",
            };
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "already_covered",
                    "reason": reason,
                    "covering_project": {
                        "id": cover.id,
                        "name": cover.name,
                        "path": cover.path,
                    }
                })),
            );
        }
        Ok(None) => {}
        Err(e) => {
            tracing::warn!("coverage check failed (allowing creation): {}", e);
        }
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
    // If path is being updated, validate it exists
    if let Some(ref new_path) = req.path {
        if !std::path::Path::new(new_path).exists() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "path does not exist" })),
            );
        }

        // Cascade: update session workspace_path for sessions that used the old path.
        // Read the old project path first.
        let old_path: Option<(String,)> =
            sqlx::query_as("SELECT path FROM projects WHERE id = ?")
                .bind(&id)
                .fetch_optional(&state.db)
                .await
                .ok()
                .flatten();

        if let Some((ref old_path_str,)) = old_path {
            // For each session whose workspace_path starts with the old project
            // path, replace the prefix with the new path.
            let old_prefix = old_path_str.trim_end_matches('/');
            let new_prefix = new_path.trim_end_matches('/');

            // Exact match: workspace_path == old path
            let exact = sqlx::query(
                "UPDATE sessions SET workspace_path = ? WHERE project_id = ? AND workspace_path = ?",
            )
            .bind(new_prefix)
            .bind(&id)
            .bind(old_prefix)
            .execute(&state.db)
            .await;

            // Prefix match: workspace_path starts with 'old_prefix/'
            let prefix_like = format!("{}/%", old_prefix);
            let prefix_affected = sqlx::query(
                "UPDATE sessions SET workspace_path = ? || SUBSTR(workspace_path, ?) \
                 WHERE project_id = ? AND workspace_path LIKE ?",
            )
            .bind(new_prefix)
            .bind((old_prefix.len() + 1) as i32)
            .bind(&id)
            .bind(&prefix_like)
            .execute(&state.db)
            .await;

            let exact_count = exact.as_ref().map(|r| r.rows_affected()).unwrap_or(0);
            let prefix_count = prefix_affected.as_ref().map(|r| r.rows_affected()).unwrap_or(0);
            let total = exact_count + prefix_count;

            if let Err(e) = prefix_affected.as_ref().or(exact.as_ref()) {
                tracing::warn!(
                    "failed to cascade-update session workspace_path: {}",
                    e
                );
            } else if total > 0 {
                tracing::info!(
                    "updated workspace_path for {} session(s) after project path change: {} -> {}",
                    total,
                    old_path_str,
                    new_path
                );
            }
        }
    }

    let result = sqlx::query(
        "UPDATE projects SET name = COALESCE(?, name), path = COALESCE(?, path) WHERE id = ?",
    )
    .bind(req.name)
    .bind(&req.path)
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

/// Group of projects that share coverage of the same git repository (or
/// have the same exact path). Returned by `GET /projects/duplicates`.
#[derive(serde::Serialize)]
struct DuplicateGroup {
    /// Stable identifier: the canonical toplevel path, or the canonical
    /// project path when none of the projects in the group is a git repo.
    group_id: String,
    /// Why the projects are duplicates: "exact_path" or "shared_toplevel".
    reason: String,
    projects: Vec<DuplicateProject>,
}

#[derive(serde::Serialize)]
struct DuplicateProject {
    id: String,
    name: String,
    path: String,
    created_at: String,
    session_count: i64,
}

/// Find groups of projects that cover the same git repository (or share
/// an exact path). Used by the sidebar to surface a reconciliation banner
/// for legacy data created before the coverage check existed.
async fn list_duplicates(State(state): State<AppState>) -> impl IntoResponse {
    let projects: Vec<Project> = match sqlx::query_as("SELECT * FROM projects")
        .fetch_all(&state.db)
        .await
    {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("list_duplicates: failed to load projects: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            );
        }
    };

    // Map: canonical key -> (group_id, reason, [(project, session_count)])
    use std::collections::BTreeMap;
    let mut groups: BTreeMap<String, (String, String, Vec<(Project, i64)>)> = BTreeMap::new();

    for project in &projects {
        let session_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sessions WHERE project_id = ?",
        )
        .bind(&project.id)
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);

        // Determine the canonical group key for this project.
        //
        // - If the project's path is a git repo, use the git toplevel path
        //   (always the first entry in `git worktree list` output). Two
        //   projects pointing to any worktree of the same repo get the
        //   same key, which is what we want.
        // - Otherwise (not a git repo), fall back to the canonical path.
        //   Two non-git projects at the same path also get the same key.
        let group_key = if crate::git::is_git_repo(&project.path).await {
            crate::git::discover_worktrees(&project.path)
                .await
                .ok()
                .and_then(|wts| wts.into_iter().next())
                .map(|wt| {
                    std::fs::canonicalize(&wt.path)
                        .ok()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or(wt.path)
                })
        } else {
            std::fs::canonicalize(&project.path)
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        };

        let Some(key) = group_key else {
            continue; // path doesn't resolve; skip
        };

        // The reason label is informational; the action is the same either way.
        let reason = if crate::git::is_git_repo(&project.path).await {
            "shared_toplevel"
        } else {
            "exact_path"
        };

        let entry = groups
            .entry(key.clone())
            .or_insert_with(|| (key, reason.to_string(), Vec::new()));
        if !entry.2.iter().any(|(p, _)| p.id == project.id) {
            entry.2.push((project.clone(), session_count));
        }
    }

    let result: Vec<DuplicateGroup> = groups
        .into_values()
        .filter(|(_, _, ps)| ps.len() > 1)
        .map(|(group_id, reason, ps)| DuplicateGroup {
            group_id,
            reason,
            projects: ps
                .into_iter()
                .map(|(p, c)| DuplicateProject {
                    id: p.id,
                    name: p.name,
                    path: p.path,
                    created_at: p.created_at,
                    session_count: c,
                })
                .collect(),
        })
        .collect();

    (StatusCode::OK, Json(json!(result)))
}

/// Merge source project `id` into `target_id`: reassign all sessions, then
/// delete the source project. Rejects with 409 if any session's
/// `tmux_session_name` would collide with an existing target session.
async fn merge_project_into(
    State(state): State<AppState>,
    Path((id, target_id)): Path<(String, String)>,
) -> impl IntoResponse {
    if id == target_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "source and target must be different" })),
        );
    }

    let source: Option<Project> = sqlx::query_as("SELECT * FROM projects WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.db)
        .await
        .unwrap();
    let target: Option<Project> = sqlx::query_as("SELECT * FROM projects WHERE id = ?")
        .bind(&target_id)
        .fetch_optional(&state.db)
        .await
        .unwrap();

    let (source, target) = match (source, target) {
        (Some(s), Some(t)) => (s, t),
        _ => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "source or target project not found" })),
            );
        }
    };

    // Detect tmux_session_name collisions between source and target.
    // A collision means both projects have a session backed by the same
    // tmux process; we can't safely merge those (would lose access to one).
    let collisions: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT s.id, s.tmux_session_name, s.name FROM sessions s \
         WHERE s.project_id = ? AND s.tmux_session_name IS NOT NULL \
           AND EXISTS (SELECT 1 FROM sessions t WHERE t.project_id = ? \
                       AND t.tmux_session_name = s.tmux_session_name)",
    )
    .bind(&id)
    .bind(&target_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    if !collisions.is_empty() {
        return (
            StatusCode::CONFLICT,
            Json(json!({
                "error": "tmux_session_name_collision",
                "collisions": collisions.iter().map(|(sid, tname, sname)| {
                    json!({
                        "session_id": sid,
                        "session_name": sname,
                        "tmux_session_name": tname,
                    })
                }).collect::<Vec<_>>(),
            })),
        );
    }

    // Reassign sessions, then delete the source.
    if let Err(e) = sqlx::query("UPDATE sessions SET project_id = ? WHERE project_id = ?")
        .bind(&target_id)
        .bind(&id)
        .execute(&state.db)
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("failed to reassign sessions: {}", e) })),
        );
    }

    if let Err(e) = sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(&id)
        .execute(&state.db)
        .await
    {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": format!("failed to delete source project: {}", e) })),
        );
    }

    tracing::info!(
        "merged project {} ({}) into {} ({})",
        source.id,
        source.path,
        target.id,
        target.path
    );

    (StatusCode::OK, Json(json!({ "ok": true, "merged_into": target.id })))
}
