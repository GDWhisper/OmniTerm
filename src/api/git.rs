use axum::{
    Json, Router,
    extract::{ConnectInfo, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;

use crate::AppState;
use crate::ai_commit::{self, Provider};
use crate::api::files::resolve_base_from_query;
use crate::git::repo::{self, DiscardFile, GitError};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/git/status", get(git_status))
        .route("/git/diff", get(git_diff))
        .route("/git/hunks", get(git_hunks))
        .route("/git/hunk", post(git_hunk))
        .route("/git/log", get(git_log))
        .route("/git/show", get(git_show))
        .route("/git/branches", get(git_branches))
        .route("/git/range", get(git_range))
        .route("/git/stage", post(git_stage))
        .route("/git/unstage", post(git_unstage))
        .route("/git/commit", post(git_commit))
        .route("/git/discard", post(git_discard))
        .route("/git/stash/list", get(git_stash_list))
        .route("/git/stash/push", post(git_stash_push))
        .route("/git/stash/apply", post(git_stash_apply))
        .route("/git/stash/pop", post(git_stash_pop))
        .route("/git/stash/drop", post(git_stash_drop))
        .route("/git/commit-message", post(git_commit_message))
        .route("/git/cherry-pick", post(git_cherry_pick))
        .route("/git/revert-commit", post(git_revert_commit))
        .route("/git/reset", post(git_reset))
        .route("/git/merge", post(git_merge))
        .route("/git/rebase", post(git_rebase))
        .route("/git/operation/continue", post(git_operation_continue))
        .route("/git/operation/abort", post(git_operation_abort))
        .route("/git/checkout", post(git_checkout))
        .route("/git/branch", post(git_create_branch))
        .route("/git/branch/delete", post(git_delete_branch))
        .route("/git/branch/rename", post(git_rename_branch))
        .route("/git/branch/delete-remote", post(git_delete_remote_branch))
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
    context_lines: Option<u32>,
    // log params
    skip: Option<u32>,
    limit: Option<u32>,
    /// Include commits from every ref (`git log --all`).
    all: Option<bool>,
    // show params
    sha: Option<String>,
    // range params
    base: Option<String>,
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
    new_name: Option<String>,
    #[serde(default)]
    force: bool,
    remote: Option<String>,
    #[serde(default)]
    include_untracked: bool,
    index: Option<u32>,
    sha: Option<String>,
    mode: Option<String>,
    #[serde(default)]
    amend: bool,
    // hunk params
    path: Option<String>,
    action: Option<String>,
    patch: Option<String>,
    context_lines: Option<u32>,
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
    let context_lines = repo::normalize_context_lines(q.context_lines);
    match repo::diff_file(&root, &path, staged, untracked, context_lines).await {
        Ok((diff, truncated)) => {
            (StatusCode::OK, Json(json!({ "diff": diff, "truncated": truncated, "root": root })))
                .into_response()
        }
        Err(e) => git_error_response(e),
    }
}

/// Single-file diff plus the canonical hunk patches that drive hunk actions.
async fn git_hunks(State(state): State<AppState>, Query(q): Query<RepoQuery>) -> Response {
    let Some(path) = q.path.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "path required" })))
            .into_response();
    };
    if q.untracked.unwrap_or(false) {
        return git_error_response(GitError::invalid_hunk(
            "untracked files have no diff base for hunk actions",
        ));
    }
    let staged = q.staged.unwrap_or(false);
    let context_lines = repo::normalize_context_lines(q.context_lines);
    let root = bind_repo!(state, q);
    match repo::file_hunks(&root, &path, staged, context_lines).await {
        Ok(data) => (
            StatusCode::OK,
            Json(json!({
                "diff": data.diff,
                "truncated": data.truncated,
                "hunks": data.hunks,
                "context_lines": data.context_lines,
                "root": root,
            })),
        )
            .into_response(),
        Err(e) => git_error_response(e),
    }
}

/// Apply one hunk. The action determines the diff direction; the patch is
/// canonical-checked against the current diff before touching the index or
/// working tree.
async fn git_hunk(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(path) = b.path.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "path required" })))
            .into_response();
    };
    let Some(action) = b.action.as_deref().and_then(repo::HunkAction::parse) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "action must be stage, unstage or revert" })),
        )
            .into_response();
    };
    let Some(patch) = b.patch.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "patch required" })))
            .into_response();
    };
    let context_lines = repo::normalize_context_lines(b.context_lines);
    let root = bind_repo!(state, b);
    match repo::apply_hunk(&root, &path, action, &patch, context_lines).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_log(State(state): State<AppState>, Query(q): Query<RepoQuery>) -> Response {
    let skip = q.skip.unwrap_or(0);
    let limit = q.limit.unwrap_or(50).min(200);
    // `path` is shared with /git/diff; an empty value means "no file filter".
    let path = q.path.clone().filter(|p| !p.is_empty());
    let all = q.all.unwrap_or(false);
    let root = bind_repo!(state, q);
    match repo::log(&root, skip, limit, path.as_deref(), all).await {
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

/// Branch comparison against HEAD. Without `path` returns the merge-base,
/// changed-file list and full range diff; with `path` returns one file.
async fn git_range(State(state): State<AppState>, Query(q): Query<RepoQuery>) -> Response {
    let Some(base) = q.base.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "base required" })))
            .into_response();
    };
    let path = q.path.clone();
    let root = bind_repo!(state, q);
    match path {
        Some(path) => match repo::range_file_diff(&root, &base, &path).await {
            Ok((diff, truncated)) => (
                StatusCode::OK,
                Json(json!({ "diff": diff, "truncated": truncated, "root": root })),
            )
                .into_response(),
            Err(e) => git_error_response(e),
        },
        None => match repo::range_overview(&root, &base).await {
            Ok(data) => (
                StatusCode::OK,
                Json(json!({
                    "merge_base": data.merge_base,
                    "files": data.files,
                    "files_truncated": data.files_truncated,
                    "diff": data.diff,
                    "truncated": data.truncated,
                    "root": root,
                })),
            )
                .into_response(),
            Err(e) => git_error_response(e),
        },
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
    let amend = b.amend;
    let root = bind_repo!(state, b);
    match repo::commit(&root, &message, amend).await {
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

async fn git_stash_list(State(state): State<AppState>, Query(q): Query<RepoQuery>) -> Response {
    let root = bind_repo!(state, q);
    match repo::stash_list(&root).await {
        Ok((stashes, truncated)) => {
            (StatusCode::OK, Json(json!({ "stashes": stashes, "truncated": truncated })))
                .into_response()
        }
        Err(e) => git_error_response(e),
    }
}

async fn git_stash_push(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let root = bind_repo!(state, b);
    match repo::stash_push(&root, b.message.as_deref(), b.include_untracked).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_stash_apply(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(index) = b.index else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "index required" })))
            .into_response();
    };
    let root = bind_repo!(state, b);
    match repo::stash_apply(&root, index).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_stash_pop(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(index) = b.index else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "index required" })))
            .into_response();
    };
    let root = bind_repo!(state, b);
    match repo::stash_pop(&root, index).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_stash_drop(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(index) = b.index else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "index required" })))
            .into_response();
    };
    let root = bind_repo!(state, b);
    match repo::stash_drop(&root, index).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

/// Generate a commit message from the **staged** diff. One provider request per
/// click; the frontend only fills the commit box and never auto-commits.
async fn git_commit_message(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let root = bind_repo!(state, b);
    let cfg = ai_commit::load_config(&state.db).await;
    if cfg.provider == Provider::Off {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": "AI commit is not configured", "code": "ai_not_configured" })),
        )
            .into_response();
    }
    if let Err(message) = ai_commit::validate_config(&cfg) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": message, "code": "ai_not_configured" })),
        )
            .into_response();
    }

    let context = match repo::ai_commit_context(&root).await {
        Ok(context) => context,
        Err(e) => return git_error_response(e),
    };
    let api_key = match ai_commit::resolve_api_key(&state.ai_commit_key_path) {
        Ok(key) => key,
        Err(e) => return crate::api::ai_commit::ai_error_response(e),
    };
    let (system, user) = ai_commit::generate::build_prompts(
        &context.diff,
        &context.subjects,
        context.omitted_files,
        context.omitted_chars,
    );
    match ai_commit::generate::generate(&cfg, api_key.as_deref(), &system, &user).await {
        Ok(message) => {
            // Never log prompt/diff content (it is user source code).
            tracing::info!(
                provider = cfg.provider.as_str(),
                model = %cfg.model,
                files = context.file_count,
                omitted_files = context.omitted_files,
                omitted_chars = context.omitted_chars,
                "generated AI commit message"
            );
            (
                StatusCode::OK,
                Json(json!({
                    "message": message,
                    "provider": cfg.provider.as_str(),
                    "model": cfg.model,
                    "file_count": context.file_count,
                    "omitted_files": context.omitted_files,
                    "omitted_chars": context.omitted_chars,
                })),
            )
                .into_response()
        }
        Err(e) => crate::api::ai_commit::ai_error_response(e),
    }
}

async fn git_cherry_pick(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(sha) = b.sha.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "sha required" }))).into_response();
    };
    let root = bind_repo!(state, b);
    match repo::cherry_pick(&root, &sha).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_revert_commit(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(sha) = b.sha.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "sha required" }))).into_response();
    };
    let root = bind_repo!(state, b);
    match repo::revert_commit(&root, &sha).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_reset(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(sha) = b.sha.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "sha required" }))).into_response();
    };
    let mode = match b.mode.as_deref() {
        Some("soft") => repo::ResetMode::Soft,
        Some("mixed") => repo::ResetMode::Mixed,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "mode must be soft or mixed" })),
            )
                .into_response();
        }
    };
    let root = bind_repo!(state, b);
    match repo::reset_to(&root, &sha, mode).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_merge(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(branch) = b.branch.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "branch required" })))
            .into_response();
    };
    let root = bind_repo!(state, b);
    match repo::merge_branch(&root, &branch).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_rebase(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(branch) = b.branch.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "branch required" })))
            .into_response();
    };
    let root = bind_repo!(state, b);
    match repo::rebase_branch(&root, &branch).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

/// Continue whatever operation is on disk (kind is detected server-side).
async fn git_operation_continue(
    State(state): State<AppState>,
    Json(b): Json<RepoBody>,
) -> Response {
    let root = bind_repo!(state, b);
    match repo::operation_continue(&root).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_operation_abort(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let root = bind_repo!(state, b);
    match repo::operation_abort(&root).await {
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

async fn git_delete_branch(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let Some(name) = b.name.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "name required" })))
            .into_response();
    };
    let root = bind_repo!(state, b);
    match repo::delete_branch(&root, &name, b.force).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_rename_branch(State(state): State<AppState>, Json(b): Json<RepoBody>) -> Response {
    let (Some(old), Some(new)) = (b.name.clone(), b.new_name.clone()) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "name and new_name required" })))
            .into_response();
    };
    let root = bind_repo!(state, b);
    match repo::rename_branch(&root, &old, &new).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_delete_remote_branch(
    State(state): State<AppState>,
    Json(b): Json<RepoBody>,
) -> Response {
    let Some(name) = b.name.clone() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "name required" })))
            .into_response();
    };
    let remote = b.remote.as_deref().unwrap_or("origin");
    let root = bind_repo!(state, b);
    match repo::delete_remote_branch(&root, remote, &name).await {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(e) => git_error_response(e),
    }
}

async fn git_push(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(b): Json<RepoBody>,
) -> Response {
    let root = bind_repo!(state, b);
    match repo::push(&root).await {
        Ok(()) => {
            // 审计（S5）：push 是把本地改动送出机器的动作，必须有痕。
            // 计划 D4 的存疑点「强推是否需单独分流」在此确认为**否**：
            // `repo::push` 只发 `push` 与 `push --set-upstream origin HEAD`
            // （src/git/repo.rs:513-529），从不带 --force，故不存在独立的
            // 「强推」动作可分流。repo 根本身即 target，scope 用同一值。
            let ctx = crate::api::audit::AuditContext::from_ip(
                Some(addr.ip()),
                Some(format!("repo:{root}")),
            );
            crate::api::audit::record(
                &state.db,
                &ctx,
                crate::api::audit::AuditAction::GitPush,
                &root,
                None,
            )
            .await;
            (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
        }
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
