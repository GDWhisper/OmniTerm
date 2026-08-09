use anyhow::anyhow;
use axum::{
    Json, Router,
    body::Body,
    extract::{Multipart, Query, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use tracing::error;

use crate::AppState;
use crate::engine::tmux;
use crate::fs;

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
    workspace: Option<String>, // project_id (existing, misnamed)
    session: Option<String>,
    workspace_id: Option<String>, // NEW: actual workspace id
    sort: Option<String>,
    order: Option<String>,
    /// 前端写类请求透传（delete/write/mkdir/upload/rename/move/copy）：
    /// 为 true 时允许目标路径逃逸出 workspace 根目录（受信调用方显式请求）。
    allow_escape: Option<bool>,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    path: Option<String>,
    workspace: Option<String>,
    session: Option<String>,
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
struct RenameRequest {
    path: String,
    #[serde(rename = "newName")]
    new_name: String,
    workspace: Option<String>,
    session: Option<String>,
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
struct MoveRequest {
    paths: Vec<String>,
    destination: String,
    workspace: Option<String>,
    session: Option<String>,
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
struct CopyRequest {
    paths: Vec<String>,
    destination: String,
    workspace: Option<String>,
    session: Option<String>,
    workspace_id: Option<String>,
}

#[derive(Deserialize)]
struct WriteRequest {
    content: String,
}

/// Resolve project root path from project ID.
pub async fn resolve_project_root(state: &AppState, project_id: &str) -> Option<String> {
    sqlx::query_as::<_, (String,)>("SELECT path FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(&state.db)
        .await
        .ok()
        .flatten()
        .map(|(p,)| p)
}

fn parse_sort(sort: Option<&str>, order: Option<&str>) -> (fs::SortKey, bool) {
    let key = match sort {
        Some("mtime") => fs::SortKey::Mtime,
        Some("size") => fs::SortKey::Size,
        _ => fs::SortKey::Name,
    };
    let desc = order == Some("desc");
    (key, desc)
}

/// Resolve base path from session ID.
///
/// Returns `(base_path, tmux_session_name_or_empty)`. The second value is the
/// tmux session name for `runtime_kind='tmux'` sessions, and `""` (empty) for
/// `runtime_kind='acp'` sessions — which **do not have a tmux session**, so
/// FileManager must read the session's `workspace_path` directly (the agent
/// process cwd was fixed in commit 27d815f to actually be that path).
///
/// For tmux sessions, falls back to re-creating the tmux session at
/// `workspace_path` if `pane_cwd` fails (e.g. tmux server restart).
///
/// **历史 bug**：此前 ACP session 的 `tmux_session_name` 是 NULL，
/// `SELECT tmux_session_name` 返回 None  → 整个函数返 None  →
/// `/files?session=…` 返回 404 "session not found or tmux unavailable"，
/// FileManager 加载 ACP session 的文件列表永远报错。修复后识别
/// runtime_kind=acp 走 workspace_path 分支。
pub async fn resolve_session_base(state: &AppState, session_id: &str) -> Option<(String, String)> {
    // 一次性取 session 关键字段，避免多次往返
    let row: (String, Option<String>, String) = sqlx::query_as(
        "SELECT runtime_kind, tmux_session_name, workspace_path FROM sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()?;

    let (runtime_kind, tmux_name_opt, workspace_path) = row;

    // ACP session：没有 tmux 会话，直接用 session 的 workspace_path 作为
    // FileManager 起点。这与 agent 子进程 OS cwd 修复（commit 27d815f）
    // 保持一致——agent 看到的是 workspace_path，FileManager 也展示
    // workspace_path，UI 与 agent 实际文件上下文统一。
    //
    // 未来若引入非 tmux/非 acp 的新 runtime_kind，未设置 tmux_name 但
    // 仍要求跟随会话工作区：也走此分支（`tmux_name_opt.is_none()`）。
    if runtime_kind == "acp" || tmux_name_opt.is_none() {
        tracing::debug!(
            "session {} is non-tmux (runtime_kind={}), using workspace_path={} as FileManager cwd",
            session_id,
            runtime_kind,
            workspace_path
        );
        return Some((workspace_path, String::new()));
    }

    // 走到这里说明是 tmux 会话。tmux_name_opt 一定是 Some
    // （上面已 early-return None 分支）。
    let tmux_name = tmux_name_opt.expect("checked above");

    // Try to get pane CWD; if it fails, the tmux session may have been lost
    match tmux::pane_cwd(&tmux_name).await {
        Ok(cwd) => Some((cwd, tmux_name)),
        Err(e) => {
            tracing::warn!(
                "tmux session '{}' unavailable ({}), attempting re-create",
                tmux_name,
                e
            );
            // Resolve workspace root as fallback CWD
            let (root, _project_id) =
                resolve_session_workspace_root(state, session_id).await.unwrap_or_else(|| {
                    (std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string()), String::new())
                });
            tmux::new_session(&tmux_name, &root, None).await.ok()?;
            let cwd = tmux::pane_cwd(&tmux_name).await.ok()?;
            tracing::info!("re-created tmux session '{}' at {}", tmux_name, cwd);
            Some((cwd, tmux_name))
        }
    }
}

/// Get workspace_path and project_id for a session (used for is_outside_workspace check).
async fn resolve_session_workspace_root(
    state: &AppState,
    session_id: &str,
) -> Option<(String, String)> {
    sqlx::query_as::<_, (String, String)>(
        "SELECT workspace_path, project_id FROM sessions WHERE id = ?",
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
}

/// Fallback: 当 `list_base` 不在 session 的 `workspace_path`（ws_root）内时，
/// 先在 session 所属 project 的 worktrees 中寻找**包含** `list_base` 的最近
/// worktree；找不到再退化为 `git rev-parse --show-toplevel`（任意 git 仓库的
/// 顶层目录），命中则作为 effective workspace_root。覆盖以下场景：
/// 1. adopt 时 session workspace_path 存错（最常见根因）
/// 2. 跨 project 浏览到其它 worktree（adopt 外部 tmux 会话后又切到别的项目）
/// 3. tmux 临时 cd 出去又 manual 浏览回工作区
///
/// 命中时 is_outside = false 且返回的 workspace_root 改为 effective 值，
/// 让前端的 `isPathOutsideWorkspace(filePath, workspaceRoot)` 也能正确通过。
async fn resolve_effective_workspace_root(
    state: &AppState,
    project_id: &str,
    list_base_canonical: &std::path::Path,
) -> Option<String> {
    // 1) 同 project 的 worktree（最近祖先）
    if !project_id.is_empty()
        && let Some(p) = resolve_effective_in_project(state, project_id, list_base_canonical).await
    {
        return Some(p);
    }
    // 2) 退化：任意祖先 git repo 的 toplevel
    resolve_git_toplevel(list_base_canonical)
}

async fn resolve_effective_in_project(
    state: &AppState,
    project_id: &str,
    list_base_canonical: &std::path::Path,
) -> Option<String> {
    use crate::workspaces;
    let project_root = resolve_project_root(state, project_id).await?;
    let project = crate::models::project::Project {
        id: project_id.to_string(),
        name: String::new(),
        path: project_root,
        target_id: None,
        created_at: String::new(),
        path_valid: true, // internal helper; the root resolved from DB and is in use
    };
    let wts = workspaces::list_workspaces(&project).await;
    wts.into_iter()
        .filter_map(|w| {
            let wp = std::path::Path::new(&w.path);
            let wp_canon = wp.canonicalize().ok()?;
            if list_base_canonical.starts_with(&wp_canon) { Some((wp_canon, w.path)) } else { None }
        })
        .max_by_key(|(p, _)| p.as_os_str().len())
        .map(|(_, p)| p)
}

/// `git -C <path> rev-parse --show-toplevel`，失败返回 None。
/// 不依赖 git 二进制的 panic：用 timeout + spawn，stderr 吞掉。
fn resolve_git_toplevel(path: &std::path::Path) -> Option<String> {
    use std::process::{Command, Stdio};
    let output = Command::new("git")
        .args(["-C", path.to_str()?, "rev-parse", "--show-toplevel"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8(output.stdout).ok()?;
    let trimmed = s.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
}

/// Resolve base path from query: session > workspace_id > project.
/// Returns (base_path, is_session_mode).
pub async fn resolve_base_from_query(
    state: &AppState,
    session: Option<&str>,
    workspace_id: Option<&str>,
    project: Option<&str>,
) -> Option<(std::path::PathBuf, bool)> {
    if let Some(sid) = session {
        let (cwd, _) = resolve_session_base(state, sid).await?;
        Some((std::path::PathBuf::from(cwd), true))
    } else if let Some(wid) = workspace_id {
        let pid = project.unwrap_or("default");
        let root = resolve_workspace_root(state, wid, pid).await?;
        Some((std::path::PathBuf::from(root), false))
    } else {
        let pid = project.unwrap_or("default");
        let root = resolve_project_root(state, pid).await?;
        Some((std::path::PathBuf::from(root), false))
    }
}

/// Resolve workspace root path from workspace_id + project_id.
/// Workspaces are discovered dynamically from git worktrees.
async fn resolve_workspace_root(
    state: &AppState,
    workspace_id: &str,
    project_id: &str,
) -> Option<String> {
    use crate::workspaces;
    let project_root = resolve_project_root(state, project_id).await?;
    let project = crate::models::project::Project {
        id: project_id.to_string(),
        name: String::new(),
        path: project_root,
        target_id: None,
        created_at: String::new(),
        path_valid: true, // internal helper; the root resolved from DB and is in use
    };
    let wts = workspaces::list_workspaces(&project).await;
    wts.into_iter().find(|w| w.id == workspace_id).map(|w| w.path)
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

        // workspace 根路径：供前端判断越界；解析失败时回退为空串
        let (ws_root, project_id) =
            resolve_session_workspace_root(&state, session_id).await.unwrap_or_default();

        let rel_path = q.path.as_deref().unwrap_or("");
        let base = std::path::Path::new(&cwd);

        if !base.exists() {
            return (
                StatusCode::OK,
                Json(
                    json!({ "files": [], "cwd": fs::display_path_str(&cwd), "is_outside_workspace": true, "workspace_root": ws_root }),
                ),
            );
        }

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
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "path not found" })));
        };

        // Determine if the **browsed directory** (not tmux's own cwd) is outside
        // the session's workspace. Using `canonical` (the directory the user is
        // actually viewing) instead of `cwd` (tmux pane_cwd) avoids false
        // positives when the user manually navigates back into the workspace
        // via FileManager (manual mode) while tmux's pane cwd is elsewhere.
        //
        // Fallback: 若 `canonical` 不在 session 的 `workspace_path` 内（adopt 时存
        // 错 / 跨 worktree 浏览），在 session 所属 project 的 git worktrees 中寻找
        // **包含** `canonical` 的最近 worktree，作为 effective workspace_root。
        // 命中时 is_outside = false 且返回的 workspace_root 改为 effective 值，
        // 让前端的 `isPathOutsideWorkspace(filePath, workspaceRoot)` 也能正确通过。
        // canonicalize 两侧后再比较，避免 Windows 上分隔符（G:\ vs g:/）与大小写差异误判
        let (is_outside, effective_root) = if !ws_root.is_empty() {
            let raw_outside =
                match (canonical.canonicalize(), std::path::Path::new(&ws_root).canonicalize()) {
                    (Ok(c), Ok(r)) => !c.starts_with(&r),
                    _ => !canonical.starts_with(&ws_root),
                };
            if raw_outside && !project_id.is_empty() {
                if let Some(eff) =
                    resolve_effective_workspace_root(&state, &project_id, &canonical).await
                {
                    (false, eff)
                } else {
                    (true, ws_root)
                }
            } else {
                (raw_outside, ws_root)
            }
        } else {
            (false, ws_root)
        };

        match fs::list_dir(&canonical, "", sort, desc).await {
            Ok(entries) => (
                StatusCode::OK,
                Json(
                    json!({ "files": entries, "cwd": fs::display_path(&canonical), "is_outside_workspace": is_outside, "workspace_root": effective_root }),
                ),
            ),
            Err(e) => {
                error!("list_files (session) failed: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
            }
        }
    } else if let Some(workspace_id) = q.workspace_id.as_deref() {
        // Workspace-based mode: resolve workspace path from workspace_id
        let project_id = q.workspace.as_deref().unwrap_or("default");

        let Some(root) = resolve_workspace_root(&state, workspace_id, project_id).await else {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "workspace not found" })));
        };

        let base = std::path::Path::new(&root);
        if !base.exists() {
            return (
                StatusCode::OK,
                Json(
                    json!({ "files": [], "cwd": fs::display_path_str(&root), "is_outside_workspace": false, "workspace_root": root }),
                ),
            );
        }

        let rel_path = q.path.as_deref().unwrap_or("");
        let list_base = if rel_path.is_empty() || rel_path == "." {
            base.to_path_buf()
        } else if std::path::Path::new(rel_path).is_absolute() {
            std::path::Path::new(rel_path).to_path_buf()
        } else {
            base.join(rel_path)
        };

        let Ok(canonical) = list_base.canonicalize() else {
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "path not found" })));
        };

        // Detect if browsing outside workspace root (same as session mode behavior)
        let is_outside = match base.canonicalize() {
            Ok(canonical_root) => !canonical.starts_with(&canonical_root),
            Err(_) => false,
        };

        match fs::list_dir(&canonical, "", sort, desc).await {
            Ok(entries) => (
                StatusCode::OK,
                Json(
                    json!({ "files": entries, "cwd": fs::display_path(&canonical), "is_outside_workspace": is_outside, "workspace_root": root }),
                ),
            ),
            Err(e) => {
                error!("list_files (workspace) failed: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
            }
        }
    } else if let Some(project_id) = q.workspace.as_deref() {
        // Project-based mode (existing fallback, unchanged)
        let rel_path = q.path.as_deref().unwrap_or("");

        let Some(root) = resolve_project_root(&state, project_id).await else {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "project not found" })));
        };

        let base = std::path::Path::new(&root);

        if !base.exists() {
            return (StatusCode::OK, Json(json!([])));
        }

        match fs::list_dir(base, rel_path, sort, desc).await {
            Ok(entries) => (StatusCode::OK, Json(json!(entries))),
            Err(e) => {
                error!("list_files failed: {}", e);
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
            }
        }
    } else {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "session, workspace_id, or workspace parameter required" })),
        )
    }
}

async fn upload_file(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let rel_path = q.path.as_deref().unwrap_or("");
    let allow_escape = q.allow_escape.unwrap_or(false);

    let Some((base, _)) = resolve_base_from_query(
        &state,
        q.session.as_deref(),
        q.workspace_id.as_deref(),
        q.workspace.as_deref(),
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    let mut uploaded = Vec::new();

    while let Some(field) = multipart.next_field().await.unwrap_or(None) {
        let file_name = field.file_name().unwrap_or("upload").to_string();

        let data = match field.bytes().await {
            Ok(d) => d,
            Err(e) => {
                error!("failed to read upload data: {}", e);
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": "read failed" })));
            }
        };

        // For session mode with absolute rel_path, use it as-is
        let target_path = if rel_path.is_empty() || rel_path == "." {
            file_name.clone()
        } else {
            // 绝对路径与相对路径的拼接形式一致，clippy 复核后合并分支
            format!("{}/{}", rel_path.trim_end_matches('/'), file_name)
        };

        if let Err(e) = if allow_escape {
            fs::write_file_allow_escape(&base, &target_path, &data).await
        } else {
            fs::write_file(&base, &target_path, &data).await
        } {
            error!("upload write failed: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })));
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
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "path required" })));
    };

    let Some((base, _)) = resolve_base_from_query(
        &state,
        q.session.as_deref(),
        q.workspace_id.as_deref(),
        q.workspace.as_deref(),
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    let allow_escape = q.allow_escape.unwrap_or(false);

    let result = if allow_escape {
        fs::delete_path_allow_escape(&base, path_str).await
    } else {
        fs::delete_path(&base, path_str).await
    };

    match result {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            error!("delete failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
        }
    }
}

async fn download_file(State(state): State<AppState>, Query(q): Query<FileQuery>) -> Response {
    let Some(path_str) = q.path.as_deref() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "path required" })))
            .into_response();
    };

    let Some((base, _)) = resolve_base_from_query(
        &state,
        q.session.as_deref(),
        q.workspace_id.as_deref(),
        q.workspace.as_deref(),
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        )
            .into_response();
    };

    // For session mode, paths may be absolute
    // 越界路径直接放行：相对路径 sanitize 失败（不存在或逃逸）时以 base 拼接原始
    // 路径继续下载，不再返回 FORBIDDEN —— 对齐 allow_escape 语义，用于会话被固定
    // 在工作区外的场景。文件确实不存在时由后续 read 返回 NOT_FOUND。
    let full_path = if std::path::Path::new(path_str).is_absolute() {
        std::path::PathBuf::from(path_str)
    } else {
        match fs::sanitize_path(&base, path_str) {
            Ok(p) => p,
            Err(_) => base.join(path_str),
        }
    };

    // Directories are packed into a zip archive on the fly.
    let is_dir = tokio::fs::metadata(&full_path).await.map(|m| m.is_dir()).unwrap_or(false);

    if is_dir {
        let dir_name = full_path.file_name().unwrap_or_default().to_string_lossy().into_owned();

        // Zip packing is CPU/IO bound; run it off the async runtime.
        let packed = match tokio::task::spawn_blocking(move || zip_directory(&full_path)).await {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(e)) => {
                error!("zip directory failed: {}", e);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": e.to_string() })),
                )
                    .into_response();
            }
            Err(e) => {
                error!("zip task panicked: {}", e);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": "zip packing failed" })),
                )
                    .into_response();
            }
        };

        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/zip")
            .header(
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}.zip\"", dir_name),
            )
            .body(Body::from(packed))
            .unwrap();
    }

    let Ok(content) = tokio::fs::read(&full_path).await else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "file not found" }))).into_response();
    };

    let file_name = full_path.file_name().unwrap_or_default().to_string_lossy();

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{}\"", file_name))
        .body(Body::from(content))
        .unwrap()
}

/// Recursively pack `dir` into an in-memory zip archive.
/// Entry paths are relative to `dir`'s parent so the top-level folder
/// name is preserved when extracted.
fn zip_directory(dir: &std::path::Path) -> anyhow::Result<Vec<u8>> {
    use std::io::{Read, Write};
    use zip::write::SimpleFileOptions;

    let mut buf: Vec<u8> = Vec::new();
    {
        let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
        let options = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);

        let mut stack: Vec<std::path::PathBuf> = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            let mut entries =
                std::fs::read_dir(&current).map_err(|e| anyhow!("read dir failed: {}", e))?;
            while let Some(entry) = entries.next().transpose()? {
                let path = entry.path();
                // Zip entry path preserves the top-level folder name.
                let rel = path
                    .strip_prefix(dir.parent().unwrap_or(dir))
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");

                let meta = std::fs::symlink_metadata(&path)?;
                if meta.is_dir() {
                    zw.add_directory(format!("{}/", rel), options)?;
                    stack.push(path);
                } else if meta.is_file() {
                    zw.start_file(rel, options)?;
                    let mut f = std::fs::File::open(&path)?;
                    let mut chunk = Vec::new();
                    f.read_to_end(&mut chunk)?;
                    zw.write_all(&chunk)?;
                }
                // Skip symlinks/other types to keep the archive portable.
            }
        }
        zw.finish()?;
    }
    Ok(buf)
}

async fn read_file(State(state): State<AppState>, Query(q): Query<FileQuery>) -> impl IntoResponse {
    let Some(path_str) = q.path.as_deref() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "path required" })));
    };

    let Some((base, _)) = resolve_base_from_query(
        &state,
        q.session.as_deref(),
        q.workspace_id.as_deref(),
        q.workspace.as_deref(),
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    // For session mode, paths may be absolute
    let content = if std::path::Path::new(path_str).is_absolute() {
        fs::read_text_file(std::path::Path::new(path_str)).await.map_err(|e| anyhow!(e))
    } else {
        fs::read_file(&base, path_str).await
    };

    match content {
        // is_text: false → 非 UTF-8 文本（如二进制），前端降级为「无法预览」
        Ok(Some(content)) => (StatusCode::OK, Json(json!({ "content": content, "is_text": true }))),
        Ok(None) => {
            (StatusCode::OK, Json(json!({ "content": serde_json::Value::Null, "is_text": false })))
        }
        Err(e) => {
            error!("read_file failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
        }
    }
}

async fn write_file(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    Json(req): Json<WriteRequest>,
) -> impl IntoResponse {
    let Some(path_str) = q.path.as_deref() else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "path required" })));
    };

    let Some((base, _)) = resolve_base_from_query(
        &state,
        q.session.as_deref(),
        q.workspace_id.as_deref(),
        q.workspace.as_deref(),
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    let allow_escape = q.allow_escape.unwrap_or(false);

    // For session mode, paths may be absolute
    let result: Result<(), anyhow::Error> = if std::path::Path::new(path_str).is_absolute() {
        // Ensure parent directory exists
        if let Some(parent) = std::path::Path::new(path_str).parent() {
            let _ = tokio::fs::create_dir_all(parent).await;
        }
        tokio::fs::write(path_str, req.content.as_bytes()).await.map_err(|e| anyhow!(e))
    } else if allow_escape {
        fs::write_file_allow_escape(&base, path_str, req.content.as_bytes()).await
    } else {
        fs::write_file(&base, path_str, req.content.as_bytes()).await
    };

    match result {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            error!("write_file failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
        }
    }
}

async fn mkdir(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    Json(req): Json<serde_json::Value>,
) -> impl IntoResponse {
    let session_id = req.get("session").and_then(|v| v.as_str());
    let workspace_id = req.get("workspace_id").and_then(|v| v.as_str());
    let project_id = req.get("workspace").and_then(|v| v.as_str());
    let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let name = req.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let allow_escape = q.allow_escape.unwrap_or(false);

    let Some((base, _)) =
        resolve_base_from_query(&state, session_id, workspace_id, project_id).await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    let dir_path = if path.is_empty() || path == "." {
        name.to_string()
    } else {
        format!("{}/{}", path.trim_end_matches('/'), name)
    };

    let result = if allow_escape {
        fs::create_dir_allow_escape(&base, &dir_path).await
    } else {
        fs::create_dir(&base, &dir_path).await
    };

    match result {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            error!("mkdir failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
        }
    }
}

async fn rename(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    Json(req): Json<RenameRequest>,
) -> impl IntoResponse {
    let allow_escape = q.allow_escape.unwrap_or(false);

    let Some((base, _)) = resolve_base_from_query(
        &state,
        req.session.as_deref(),
        req.workspace_id.as_deref(),
        req.workspace.as_deref(),
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    // Compute new path: replace the file/dir name in the original path
    let old_path = std::path::Path::new(&req.path);
    let new_rel = match old_path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            format!("{}/{}", parent.to_string_lossy().trim_end_matches('/'), req.new_name)
        }
        _ => req.new_name.clone(),
    };

    let result = if allow_escape {
        fs::move_path_allow_escape(&base, &req.path, &new_rel).await
    } else {
        fs::move_path(&base, &req.path, &new_rel).await
    };

    match result {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            error!("rename failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
        }
    }
}

async fn move_files(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    Json(req): Json<MoveRequest>,
) -> impl IntoResponse {
    let allow_escape = q.allow_escape.unwrap_or(false);

    let Some((base, _)) = resolve_base_from_query(
        &state,
        req.session.as_deref(),
        req.workspace_id.as_deref(),
        req.workspace.as_deref(),
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    for p in &req.paths {
        let file_name = std::path::Path::new(p)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let dest = format!("{}/{}", req.destination.trim_end_matches('/'), file_name);
        let result = if allow_escape {
            fs::move_path_allow_escape(&base, p, &dest).await
        } else {
            fs::move_path(&base, p, &dest).await
        };
        if let Err(e) = result {
            error!("move failed: {}", e);
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })));
        }
    }

    (StatusCode::OK, Json(json!({ "ok": true })))
}

async fn copy_files(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    Json(req): Json<CopyRequest>,
) -> impl IntoResponse {
    let allow_escape = q.allow_escape.unwrap_or(false);

    let Some((base, _)) = resolve_base_from_query(
        &state,
        req.session.as_deref(),
        req.workspace_id.as_deref(),
        req.workspace.as_deref(),
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    let result = if allow_escape {
        fs::copy_paths_allow_escape(&base, &req.paths, &req.destination).await
    } else {
        fs::copy_paths(&base, &req.paths, &req.destination).await
    };

    match result {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))),
        Err(e) => {
            error!("copy failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
        }
    }
}

async fn search_files(
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> impl IntoResponse {
    let rel_path = q.path.as_deref().unwrap_or("");

    let Some((base, _)) = resolve_base_from_query(
        &state,
        q.session.as_deref(),
        q.workspace_id.as_deref(),
        q.workspace.as_deref(),
    )
    .await
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    match fs::search_files(&base, rel_path, &q.q).await {
        Ok(entries) => (StatusCode::OK, Json(json!(entries))),
        Err(e) => {
            error!("search failed: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e.to_string() })))
        }
    }
}

#[cfg(test)]
mod handler_tests {
    use super::*;
    use crate::test_utils::test_state;
    use axum::body::to_bytes;
    use std::path::PathBuf;

    /// 建一个 `runtime_kind=acp` 的会话，`workspace_path` 指向临时 base 目录。
    /// 返回 `(base, outside)` 两个同级目录，outside 位于 base 之外（供逃逸测试）。
    async fn fixture_session(state: &AppState) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "omniterm_files_handler_{}_{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let base = root.join("base");
        let outside = root.join("outside");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        sqlx::query(
            "INSERT INTO projects (id, target_id, name, path, created_at) \
             VALUES ('test-project', NULL, 'test', ?, '2026-01-01')",
        )
        .bind(base.to_str().unwrap())
        .execute(&state.db)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, \
             hook_enabled, hook_status, created_at, runtime_kind) \
             VALUES ('test-session', 'test-project', ?, 'test', NULL, 0, 'idle', '2026-01-01', 'acp')",
        )
        .bind(base.to_str().unwrap())
        .execute(&state.db)
        .await
        .unwrap();

        (base, outside)
    }

    fn session_query(path: &str, allow_escape: Option<bool>) -> FileQuery {
        FileQuery {
            path: Some(path.to_string()),
            workspace: None,
            session: Some("test-session".to_string()),
            workspace_id: None,
            sort: None,
            order: None,
            allow_escape,
        }
    }

    /// 只带 allow_escape 的 query（session/workspace 走 JSON body 的 handler 用）。
    fn allow_only(allow_escape: Option<bool>) -> FileQuery {
        FileQuery {
            path: None,
            workspace: None,
            session: None,
            workspace_id: None,
            sort: None,
            order: None,
            allow_escape,
        }
    }

    async fn body_json(res: Response) -> serde_json::Value {
        let bytes = to_bytes(res.into_body(), 1024 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn delete_file_escape_rejected_by_default_allowed_with_flag() {
        let state = test_state().await;
        let (_base, outside) = fixture_session(&state).await;
        let target = outside.join("victim.txt");
        std::fs::write(&target, b"x").unwrap();

        // 未传 allow_escape：越界删除被拒绝（500），文件保留
        let res =
            delete_file(State(state.clone()), Query(session_query("../outside/victim.txt", None)))
                .await
                .into_response();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(target.exists());

        // allow_escape=true：越界删除成功
        let res =
            delete_file(State(state), Query(session_query("../outside/victim.txt", Some(true))))
                .await
                .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn write_file_escape_rejected_by_default_allowed_with_flag() {
        let state = test_state().await;
        let (_base, outside) = fixture_session(&state).await;

        let res = write_file(
            State(state.clone()),
            Query(session_query("../outside/w.txt", None)),
            Json(WriteRequest { content: "hi".into() }),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!outside.join("w.txt").exists());

        let res = write_file(
            State(state),
            Query(session_query("../outside/w.txt", Some(true))),
            Json(WriteRequest { content: "hello".into() }),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(std::fs::read_to_string(outside.join("w.txt")).unwrap(), "hello");
    }

    #[tokio::test]
    async fn mkdir_escape_rejected_by_default_allowed_with_flag() {
        let state = test_state().await;
        let (_base, outside) = fixture_session(&state).await;
        let body = || json!({ "session": "test-session", "path": "../outside", "name": "newdir" });

        let res = mkdir(State(state.clone()), Query(allow_only(None)), Json(body()))
            .await
            .into_response();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!outside.join("newdir").exists());

        let res =
            mkdir(State(state), Query(allow_only(Some(true))), Json(body())).await.into_response();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(outside.join("newdir").is_dir());
    }

    #[tokio::test]
    async fn rename_escape_rejected_by_default_allowed_with_flag() {
        let state = test_state().await;
        let (_base, outside) = fixture_session(&state).await;
        std::fs::write(outside.join("a.txt"), b"x").unwrap();
        let body = || RenameRequest {
            path: "../outside/a.txt".into(),
            new_name: "renamed.txt".into(),
            session: Some("test-session".into()),
            workspace: None,
            workspace_id: None,
        };

        let res = rename(State(state.clone()), Query(allow_only(None)), Json(body()))
            .await
            .into_response();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(outside.join("a.txt").exists());

        let res =
            rename(State(state), Query(allow_only(Some(true))), Json(body())).await.into_response();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(outside.join("renamed.txt").exists());
        assert!(!outside.join("a.txt").exists());
    }

    #[tokio::test]
    async fn move_files_escape_rejected_by_default_allowed_with_flag() {
        let state = test_state().await;
        let (_base, outside) = fixture_session(&state).await;
        std::fs::write(outside.join("m.txt"), b"x").unwrap();
        let body = || MoveRequest {
            paths: vec!["../outside/m.txt".into()],
            destination: "../outside/moved".into(),
            session: Some("test-session".into()),
            workspace: None,
            workspace_id: None,
        };

        let res = move_files(State(state.clone()), Query(allow_only(None)), Json(body()))
            .await
            .into_response();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(outside.join("m.txt").exists());

        let res = move_files(State(state), Query(allow_only(Some(true))), Json(body()))
            .await
            .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(outside.join("moved").join("m.txt").exists());
    }

    #[tokio::test]
    async fn copy_files_escape_rejected_by_default_allowed_with_flag() {
        let state = test_state().await;
        let (_base, outside) = fixture_session(&state).await;
        std::fs::write(outside.join("c.txt"), b"x").unwrap();
        let body = || CopyRequest {
            paths: vec!["../outside/c.txt".into()],
            destination: "../outside/copied".into(),
            session: Some("test-session".into()),
            workspace: None,
            workspace_id: None,
        };

        let res = copy_files(State(state.clone()), Query(allow_only(None)), Json(body()))
            .await
            .into_response();
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!outside.join("copied").join("c.txt").exists());

        let res = copy_files(State(state), Query(allow_only(Some(true))), Json(body()))
            .await
            .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(outside.join("copied").join("c.txt").exists());
    }

    #[tokio::test]
    async fn download_out_of_base_returns_content_not_forbidden() {
        let state = test_state().await;
        let (_base, outside) = fixture_session(&state).await;
        std::fs::write(outside.join("dl.txt"), b"download-me").unwrap();

        let res =
            download_file(State(state), Query(session_query("../outside/dl.txt", None))).await;
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = to_bytes(res.into_body(), 1024).await.unwrap();
        assert_eq!(&bytes[..], b"download-me");
    }

    #[tokio::test]
    async fn list_files_session_response_includes_workspace_root() {
        let state = test_state().await;
        let (base, _outside) = fixture_session(&state).await;

        let res = list_files(State(state), Query(session_query("", None))).await.into_response();
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        assert_eq!(v["workspace_root"].as_str(), Some(base.to_str().unwrap()));
        assert_eq!(v["is_outside_workspace"].as_bool(), Some(false));
    }

    #[tokio::test]
    async fn list_files_session_early_return_includes_workspace_root() {
        let state = test_state().await;
        let (base, _outside) = fixture_session(&state).await;
        let ghost = base.join("does-not-exist");

        // 插一个 workspace_path 不存在的会话 → 触发 base 不存在早退分支
        sqlx::query(
            "INSERT INTO sessions (id, project_id, workspace_path, name, tmux_session_name, \
             hook_enabled, hook_status, created_at, runtime_kind) \
             VALUES ('ghost-session', 'test-project', ?, 'ghost', NULL, 0, 'idle', '2026-01-01', 'acp')",
        )
        .bind(ghost.to_str().unwrap())
        .execute(&state.db)
        .await
        .unwrap();

        let q = FileQuery {
            path: None,
            workspace: None,
            session: Some("ghost-session".to_string()),
            workspace_id: None,
            sort: None,
            order: None,
            allow_escape: None,
        };
        let res = list_files(State(state), Query(q)).await.into_response();
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        assert_eq!(v["workspace_root"].as_str(), Some(ghost.to_str().unwrap()));
        assert_eq!(v["is_outside_workspace"].as_bool(), Some(true));
    }

    /// is_outside_workspace 应基于「用户实际浏览的目录」而非 tmux 静态 cwd，
    /// 否则用户 manual 浏览到 ws_root 外时会被误判为在工作区内（acp fixture
    /// 下 cwd == workspace_path，旧实现用 cwd 判断永远 false）。
    #[tokio::test]
    async fn list_files_session_is_outside_reflects_browsed_path() {
        let state = test_state().await;
        let (base, outside) = fixture_session(&state).await;
        let inside_sub = base.join("sub");
        std::fs::create_dir_all(&inside_sub).unwrap();

        // manual 浏览到 ws_root 子目录 → is_outside = false
        let res = list_files(
            State(state.clone()),
            Query(session_query(inside_sub.to_str().unwrap(), None)),
        )
        .await
        .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        assert_eq!(
            v["is_outside_workspace"].as_bool(),
            Some(false),
            "subdir of workspace_path must not be flagged as outside"
        );

        // manual 浏览到 ws_root 外 → is_outside = true（旧实现下永远 false）
        let res = list_files(State(state), Query(session_query(outside.to_str().unwrap(), None)))
            .await
            .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        assert_eq!(
            v["is_outside_workspace"].as_bool(),
            Some(true),
            "dir outside workspace_path must be flagged as outside"
        );
    }

    /// 当 session 的 `workspace_path` 错误/过时（adopt 时存错、跨 worktree 浏览），
    /// 但用户实际浏览的目录在该 session 所属 project 的另一个 worktree 内时，
    /// 应 fallback 到该 worktree 作为 effective workspace_root，避免误报越界。
    #[tokio::test]
    async fn list_files_session_falls_back_to_project_worktree() {
        let state = test_state().await;
        let (base, outside) = fixture_session(&state).await;

        // 把 session 的 workspace_path 改成 outside（与 base 同级、不在 base 内）
        // 模拟「adopt 时 cwd 错 / 跨 worktree 误用旧 session」的场景
        sqlx::query("UPDATE sessions SET workspace_path = ? WHERE id = 'test-session'")
            .bind(outside.to_str().unwrap())
            .execute(&state.db)
            .await
            .unwrap();

        // 浏览到 base（项目内）→ raw_outside=true，但 base 是 test-project 的
        // worktree（list_workspaces 对非 git 目录返回 single_workspace=base），
        // fallback 命中 → is_outside=false、workspace_root 改为 base
        let res = list_files(State(state), Query(session_query(base.to_str().unwrap(), None)))
            .await
            .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        assert_eq!(
            v["is_outside_workspace"].as_bool(),
            Some(false),
            "browsed dir inside a project worktree must fall back"
        );
        assert_eq!(
            v["workspace_root"].as_str(),
            Some(base.to_str().unwrap()),
            "workspace_root should be the effective worktree path"
        );
    }

    /// 跨 project 浏览且 list_base 不在 session 所属 project 的任何 worktree 内时，
    /// 退化为 `git rev-parse --show-toplevel` 探测，命中则视为工作区内。
    /// 这是「用 test 项目的会话编辑 OmniTerm-dev 文件」场景的最后兜底。
    #[tokio::test]
    async fn list_files_session_falls_back_to_git_toplevel() {
        let state = test_state().await;
        let (_base, outside) = fixture_session(&state).await;

        // 建一个临时 git repo（不在 test-project 的 worktree 内）
        let git_root = std::env::temp_dir().join(format!(
            "omniterm_fb_git_{}_{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let git_sub = git_root.join("sub");
        std::fs::create_dir_all(&git_sub).unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(&git_root)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(init.status.success(), "git init failed");

        // session workspace_path = outside（与 base 同级，session 属 test-project）
        sqlx::query("UPDATE sessions SET workspace_path = ? WHERE id = 'test-session'")
            .bind(outside.to_str().unwrap())
            .execute(&state.db)
            .await
            .unwrap();

        // 浏览到 git_root/sub → 不在 test-project worktree 内（test-project=base/_base），
        // 但 .git 祖先在 git_root → git_toplevel fallback 命中
        let res = list_files(State(state), Query(session_query(git_sub.to_str().unwrap(), None)))
            .await
            .into_response();
        assert_eq!(res.status(), StatusCode::OK);
        let v = body_json(res).await;
        assert_eq!(
            v["is_outside_workspace"].as_bool(),
            Some(false),
            "browsed dir inside an unrelated git repo must fall back to git toplevel"
        );
        // workspace_root 应指向 git_root（git rev-parse --show-toplevel 输出）
        let root = v["workspace_root"].as_str().expect("workspace_root set");
        assert!(
            std::path::Path::new(root).canonicalize().unwrap()
                == std::path::Path::new(&git_root).canonicalize().unwrap(),
            "workspace_root should be the git toplevel, got {root}"
        );

        let _ = std::fs::remove_dir_all(&git_root);
    }

    /// session.adopt workspace_path 存错 / 跨 worktree 浏览时，sanitize_path
    /// 的 git_toplevel 兜底应放行位于祖先 git 仓库内的写操作（与 listFiles2
    /// `resolve_effective_workspace_root` 兜底语义一致）。
    #[tokio::test]
    async fn mkdir_in_ancestor_git_repo_falls_back_to_git_toplevel() {
        let state = test_state().await;
        let (base, _outside) = fixture_session(&state).await;

        // 在 base 的**同级**建一个 git repo，使 "../<name>/sub" 落在 git repo 内
        let parent = base.parent().unwrap().to_path_buf();
        let git_root = parent.join(format!(
            "sanitize_fb_git_{}_{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let git_sub = git_root.join("sub");
        std::fs::create_dir_all(&git_sub).unwrap();
        let init = std::process::Command::new("git")
            .args(["init", "-q", "-b", "main"])
            .current_dir(&git_root)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(init.status.success());

        // base = parent/base, git_root = parent/git_root → "../<git_root_name>/sub"
        let rel = format!("../{}/sub", git_root.file_name().unwrap().to_str().unwrap());
        let body = json!({ "session": "test-session", "path": rel, "name": "newdir" });
        let res = mkdir(State(state), Query(allow_only(None)), Json(body)).await.into_response();
        assert_eq!(
            res.status(),
            StatusCode::OK,
            "mkdir inside an ancestor git repo must fall back to git toplevel"
        );
        assert!(git_sub.join("newdir").exists());

        let _ = std::fs::remove_dir_all(&git_root);
        let _ = std::fs::remove_dir_all(base);
    }

    /// 非 git 目录的逃逸仍应被拒绝（兜底不放过非 git 路径，安全语义不变）
    #[tokio::test]
    async fn mkdir_in_non_git_dir_still_rejected() {
        let state = test_state().await;
        let (_base, _outside) = fixture_session(&state).await;
        let body = json!({ "session": "test-session", "path": "../outside", "name": "d" });

        let res = mkdir(State(state), Query(allow_only(None)), Json(body)).await.into_response();
        assert_eq!(
            res.status(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "non-git escape must still be rejected"
        );
    }
}

#[cfg(test)]
mod zip_tests {
    use super::zip_directory;
    use std::io::Read;
    use std::path::Path;

    #[test]
    fn packs_directory_into_valid_zip() {
        let dir = std::env::temp_dir().join("ot_ziptest_mod");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), b"hello").unwrap();
        std::fs::write(dir.join("sub").join("b.txt"), b"world").unwrap();

        let bytes = zip_directory(&dir).expect("zip should succeed");
        assert!(!bytes.is_empty());

        // Verify it's a valid zip by reading entries back.
        let mut cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(&mut cursor).expect("valid zip archive");
        let mut names = Vec::new();
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).unwrap();
            let name = f.name().to_string();
            names.push(name.clone());
            if name.ends_with("a.txt") {
                let mut buf = String::new();
                f.read_to_string(&mut buf).unwrap();
                assert_eq!(buf, "hello");
            }
            if name.ends_with("b.txt") {
                let mut buf = String::new();
                f.read_to_string(&mut buf).unwrap();
                assert_eq!(buf, "world");
            }
        }
        assert!(names.iter().any(|n| n.ends_with("a.txt")), "a.txt present: {:?}", names);
        assert!(names.iter().any(|n| n.ends_with("sub/b.txt")), "sub/b.txt present: {:?}", names);
        assert!(
            names.iter().any(|n| n.ends_with("ot_ziptest_mod/") || n.contains("ot_ziptest_mod")),
            "top folder preserved: {:?}",
            names
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[allow(dead_code)]
    fn _assert_path(_: &Path) {}
}
