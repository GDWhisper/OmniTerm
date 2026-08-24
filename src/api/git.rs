use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::api::files::resolve_base_from_query;
use crate::git::repo::{self, DiscardFile, GitError};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/git/status", get(git_status))
        .route("/git/diff", get(git_diff))
        .route("/git/log", get(git_log))
        .route("/git/show", get(git_show))
        .route("/git/branches", get(git_branches))
        .route("/git/stage", post(git_stage))
        .route("/git/unstage", post(git_unstage))
        .route("/git/commit", post(git_commit))
        .route("/git/discard", post(git_discard))
        .route("/git/checkout", post(git_checkout))
        .route("/git/branch", post(git_create_branch))
        .route("/git/push", post(git_push))
        .route("/git/pull", post(git_pull))
        .route("/git/fetch", post(git_fetch))
}

/// Repo binding fields (ADR-2): the API never accepts arbitrary filesystem
/// paths — the repo root is resolved server-side from session/workspace id.
#[derive(Deserialize)]
struct RepoQuery {
    session: Option<String>,
    workspace_id: Option<String>,
    workspace: Option<String>,
    // diff params
    path: Option<String>,
    staged: Option<bool>,
    untracked: Option<bool>,
    // log params
    skip: Option<u32>,
    limit: Option<u32>,
    // show params
    sha: Option<String>,
}

#[derive(Deserialize)]
struct RepoBody {
    session: Option<String>,
    workspace_id: Option<String>,
    workspace: Option<String>,
    #[serde(default)]
    paths: Vec<String>,
    message: Option<String>,
    #[serde(default)]
    files: Vec<DiscardFile>,
    branch: Option<String>,
    name: Option<String>,
}

fn git_error_response(e: GitError) -> Response {
    let status = match e.code.as_str() {
        "timeout" => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    (status, Json(json!({ "error": e.message, "code": e.code }))).into_response()
}

fn not_bound_response() -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": "workspace or session not found" })))
        .into_response()
}

fn not_repo_response() -> Response {
    (StatusCode::OK, Json(json!({ "is_repo": false }))).into_response()
}

#[allow(clippy::result_large_err)]
async fn resolve_root(
    state: &AppState,
    session: Option<&str>,
    workspace_id: Option<&str>,
    project: Option<&str>,
) -> Result<Option<String>, Response> {
    let Some((base, _)) = resolve_base_from_query(state, session, workspace_id, project).await
    else {
        return Err(not_bound_response());
    };
    Ok(repo::resolve_repo_root(&base.to_string_lossy()).await)
}

macro_rules! bind_repo {
    ($state:expr, $q:expr) => {
        match resolve_root(
            &$state,
            $q.session.as_deref(),
            $q.workspace_id.as_deref(),
            $q.workspace.as_deref(),
        )
        .await
        {
            Err(resp) => return resp,
            Ok(None) => return not_repo_response(),
            Ok(Some(root)) => root,
        }
    };
}

async fn git_status(State(state): State<AppState>, Query(q): Query<RepoQuery>) -> Response {
    let root = bind_repo!(state, q);
    match repo::status(&root).await {
        Ok(st) => (StatusCode::OK, Json(st)).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_diff(State(state): State<AppState>, Query(q): Query<RepoQuery>) -> Response {
    let Some(path) = q.path.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "path required" })))
            .into_response();
    };
    let root = bind_repo!(state, q);
    let staged = q.staged.unwrap_or(false);
    let untracked = q.untracked.unwrap_or(false);
    match repo::diff_file(&root, &path, staged, untracked).await {
        Ok((diff, truncated)) => {
            (StatusCode::OK, Json(json!({ "diff": diff, "truncated": truncated, "root": root })))
                .into_response()
        }
        Err(e) => git_error_response(e),
    }
}

async fn git_log(State(state): State<AppState>, Query(q): Query<RepoQuery>) -> Response {
    let root = bind_repo!(state, q);
    let skip = q.skip.unwrap_or(0);
    let limit = q.limit.unwrap_or(50).min(200);
    match repo::log(&root, skip, limit).await {
        Ok((entries, has_more)) => {
            (StatusCode::OK, Json(json!({ "entries": entries, "has_more": has_more })))
                .into_response()
        }
        Err(e) => git_error_response(e),
    }
}

async fn git_show(State(state): State<AppState>, Query(q): Query<RepoQuery>) -> Response {
    let Some(sha) = q.sha.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "sha required" }))).into_response();
    };
    let root = bind_repo!(state, q);
    match repo::show_commit(&root, &sha).await {
        Ok(detail) => (StatusCode::OK, Json(detail)).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_branches(State(state): State<AppState>, Query(q): Query<RepoQuery>) -> Response {
    let root = bind_repo!(state, q);
    match repo::branches(&root).await {
        Ok(list) => (StatusCode::OK, Json(json!({ "branches": list }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_stage(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let root = bind_repo!(state, b);
    match repo::stage(&root, &b.paths).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_unstage(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let root = bind_repo!(state, b);
    match repo::unstage(&root, &b.paths).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_commit(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(message) = b.message.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "message required" })))
            .into_response();
    };
    let root = bind_repo!(state, b);
    match repo::commit(&root, &message).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_discard(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    if b.files.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "files required" })))
            .into_response();
    }
    let root = bind_repo!(state, b);
    match repo::discard(&root, &b.files).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_checkout(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(branch) = b.branch.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "branch required" })))
            .into_response();
    };
    let root = bind_repo!(state, b);
    match repo::checkout_branch(&root, &branch).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_create_branch(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(name) = b.name.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "name required" })))
            .into_response();
    };
    let root = bind_repo!(state, b);
    match repo::create_branch(&root, &name).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_push(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let root = bind_repo!(state, b);
    match repo::push(&root).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_pull(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let root = bind_repo!(state, b);
    match repo::pull(&root).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_fetch(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let root = bind_repo!(state, b);
    match repo::fetch(&root).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}
