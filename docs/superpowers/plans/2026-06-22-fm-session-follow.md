# 文件管理器跟随终端 CWD 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文件管理器跟随终端实时 CWD，支持双模式导航（跟随/手动），超出 workspace 边界时显示警告。

**Architecture:** 后端新增 `GET /sessions/{id}/cwd` 端点 + 文件 API 支持 `session` 参数（基于 tmux `pane_current_path`）。前端 FileManager 重构为双模式 + 3 秒轮询，per-session 状态存储在 Zustand store。

**Tech Stack:** Rust (Axum, SQLx), TypeScript (React, Zustand), tmux `display-message`

## Global Constraints

- 深色科技感 (Dark Tech) 视觉语言：`#0a0a0f` 底色，violet `#a78bfa` 强调色
- 字体：`'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace`
- 过渡动效：`0.15s ease`
- 圆角：按钮 `6px`，输入框 `5px`
- 所有文件路径：MIT license header
- `sanitize_path` 从"限制在 workspace 内"降级为"防止路径遍历攻击"
- 轮询间隔：3000ms

---

### Task 1: 后端 — 新增 `GET /sessions/{id}/cwd` 端点

**Files:**
- Modify: `src/api/sessions.rs:3-16` (routes 函数)
- Modify: `src/api/sessions.rs` (新增 `get_session_cwd` handler)

**Interfaces:**
- Produces: `GET /api/v1/sessions/{id}/cwd` → `{ "cwd": "/path" }` 或 `404`/`500`

- [ ] **Step 1: 在 sessions.rs 中新增路由和 handler**

在 `src/api/sessions.rs` 的 `routes()` 函数中添加新路由：

```rust
pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/workspaces/{wid}/sessions",
            get(list_sessions).post(create_session),
        )
        .route(
            "/sessions/{id}",
            patch(update_session).delete(delete_session),
        )
        .route("/sessions/{id}/cwd", get(get_session_cwd))
}
```

在文件末尾（`fn dirs()` 之前）添加 handler：

```rust
async fn get_session_cwd(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    // Look up tmux session name
    let tmux_name: Option<(String,)> =
        sqlx::query_as("SELECT tmux_session_name FROM sessions WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();

    let Some((tmux_name,)) = tmux_name else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "session not found" })),
        );
    };

    match tmux::pane_cwd(&tmux_name).await {
        Ok(cwd) => (StatusCode::OK, Json(json!({ "cwd": cwd }))),
        Err(e) => {
            error!("pane_cwd failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            )
        }
    }
}
```

- [ ] **Step 2: 验证编译通过**

```bash
cd /home/pax/coding/OmniTerm-dev && cargo check
```

Expected: 编译成功，无错误。

- [ ] **Step 3: 手动测试**

启动后端后，创建一个 session，然后：
```bash
curl http://localhost:9777/api/v1/sessions/<session_id>/cwd
```
Expected: 返回 `{"cwd":"/home/pax/..."}` 或类似路径。

- [ ] **Step 4: Commit**

```bash
git add src/api/sessions.rs
git commit -m "feat(api): add GET /sessions/{id}/cwd endpoint"
```

---

### Task 2: 后端 — 文件 API 支持 `session` 参数（list_files）

**Files:**
- Modify: `src/api/files.rs:27-33` (FileQuery struct)
- Modify: `src/api/files.rs` (新增 `resolve_session_base` helper)
- Modify: `src/api/files.rs:90-122` (list_files handler)

**Interfaces:**
- Consumes: `tmux::pane_cwd(session_name)` from `src/tmux/mod.rs`
- Produces: `GET /api/v1/files?session={sid}&path={path}` → `{ "files": [...], "cwd": "/path", "is_outside_workspace": bool }`

- [ ] **Step 1: 给 FileQuery 添加 `session` 字段**

在 `src/api/files.rs` 中修改 `FileQuery` struct：

```rust
#[derive(Deserialize)]
struct FileQuery {
    path: Option<String>,
    workspace: Option<String>,
    session: Option<String>,  // 新增
    sort: Option<String>,
    order: Option<String>,
}
```

- [ ] **Step 2: 添加 `resolve_session_base` helper 函数**

在 `parse_sort` 函数之后添加：

```rust
/// Resolve base path from session ID (via tmux pane CWD).
/// Returns (base_path, tmux_session_name).
async fn resolve_session_base(state: &AppState, session_id: &str) -> Option<(String, String)> {
    let tmux_name: Option<(String,)> =
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
```

- [ ] **Step 3: 修改 `list_files` handler 支持 session 参数**

替换整个 `list_files` 函数：

```rust
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
```

- [ ] **Step 4: 验证编译通过**

```bash
cd /home/pax/coding/OmniTerm-dev && cargo check
```

Expected: 编译成功。

- [ ] **Step 5: Commit**

```bash
git add src/api/files.rs
git commit -m "feat(api): add session parameter to list_files endpoint"
```

---

### Task 3: 后端 — 文件操作 API 支持 `session` 参数

**Files:**
- Modify: `src/api/files.rs` — upload_file, delete_file, download_file, read_file, write_file, mkdir, rename, move_files, copy_files, search_files

**Interfaces:**
- Consumes: `resolve_session_base()` from Task 2
- Produces: 所有文件操作 API 支持 `?session={sid}` 参数

- [ ] **Step 1: 修改 SearchQuery 添加 session 字段**

```rust
#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    path: Option<String>,
    workspace: Option<String>,
    session: Option<String>,  // 新增
}
```

- [ ] **Step 2: 修改 RenameRequest 添加 session 字段**

```rust
#[derive(Deserialize)]
struct RenameRequest {
    path: String,
    #[serde(rename = "newName")]
    new_name: String,
    workspace: Option<String>,
    session: Option<String>,  // 新增
}
```

- [ ] **Step 3: 修改 MoveRequest 添加 session 字段**

```rust
#[derive(Deserialize)]
struct MoveRequest {
    paths: Vec<String>,
    destination: String,
    workspace: Option<String>,
    session: Option<String>,  // 新增
}
```

- [ ] **Step 4: 修改 CopyRequest 添加 session 字段**

```rust
#[derive(Deserialize)]
struct CopyRequest {
    paths: Vec<String>,
    destination: String,
    workspace: Option<String>,
    session: Option<String>,  // 新增
}
```

- [ ] **Step 5: 添加通用 helper 函数 `resolve_base_from_query`**

在 `resolve_session_workspace_root` 函数之后添加：

```rust
/// Resolve base path from FileQuery: prefer session over workspace.
/// Returns (base_path, is_session_mode).
async fn resolve_base_from_query(state: &AppState, session: Option<&str>, workspace: Option<&str>) -> Option<(std::path::PathBuf, bool)> {
    if let Some(sid) = session {
        let (cwd, _) = resolve_session_base(state, sid).await?;
        Some((std::path::PathBuf::from(cwd), true))
    } else {
        let wid = workspace.unwrap_or("default");
        let root = resolve_workspace_root(state, wid).await?;
        Some((std::path::PathBuf::from(root), false))
    }
}
```

- [ ] **Step 6: 修改 `upload_file` handler**

```rust
async fn upload_file(
    State(state): State<AppState>,
    Query(q): Query<FileQuery>,
    mut multipart: Multipart,
) -> impl IntoResponse {
    let rel_path = q.path.as_deref().unwrap_or("");

    let Some((base, _)) = resolve_base_from_query(&state, q.session.as_deref(), q.workspace.as_deref()).await else {
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
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "read failed" })),
                );
            }
        };

        // For session mode with absolute rel_path, use it as-is
        let target_path = if rel_path.is_empty() || rel_path == "." {
            file_name.clone()
        } else if std::path::Path::new(rel_path).is_absolute() {
            format!("{}/{}", rel_path.trim_end_matches('/'), file_name)
        } else {
            format!("{}/{}", rel_path.trim_end_matches('/'), file_name)
        };

        if let Err(e) = fs::write_file(&base, &target_path, &data).await {
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
```

- [ ] **Step 7: 修改 `delete_file` handler**

```rust
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

    let Some((base, _)) = resolve_base_from_query(&state, q.session.as_deref(), q.workspace.as_deref()).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    match fs::delete_path(&base, path_str).await {
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
```

- [ ] **Step 8: 修改 `download_file` handler**

```rust
async fn download_file(State(state): State<AppState>, Query(q): Query<FileQuery>) -> Response {
    let Some(path_str) = q.path.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path required" })),
        )
            .into_response();
    };

    let Some((base, _)) = resolve_base_from_query(&state, q.session.as_deref(), q.workspace.as_deref()).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        )
            .into_response();
    };

    // For session mode, paths may be absolute
    let full_path = if std::path::Path::new(path_str).is_absolute() {
        std::path::PathBuf::from(path_str)
    } else {
        match fs::sanitize_path(&base, path_str) {
            Ok(p) => p,
            Err(_) => return (StatusCode::FORBIDDEN, Json(json!({ "error": "invalid path" }))).into_response(),
        }
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
```

- [ ] **Step 9: 修改 `read_file` handler**

```rust
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

    let Some((base, _)) = resolve_base_from_query(&state, q.session.as_deref(), q.workspace.as_deref()).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    match fs::read_file(&base, path_str).await {
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
```

- [ ] **Step 10: 修改 `write_file` handler**

```rust
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

    let Some((base, _)) = resolve_base_from_query(&state, q.session.as_deref(), q.workspace.as_deref()).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    match fs::write_file(&base, path_str, req.content.as_bytes()).await {
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
```

- [ ] **Step 11: 修改 `mkdir` handler**

```rust
async fn mkdir(
    State(state): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> impl IntoResponse {
    let session_id = req.get("session").and_then(|v| v.as_str());
    let workspace_id = req.get("workspace").and_then(|v| v.as_str());
    let path = req.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let name = req.get("name").and_then(|v| v.as_str()).unwrap_or("");

    let Some((base, _)) = resolve_base_from_query(&state, session_id, workspace_id).await else {
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

    match fs::create_dir(&base, &dir_path).await {
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
```

- [ ] **Step 12: 修改 `rename` handler**

```rust
async fn rename(
    State(state): State<AppState>,
    Json(req): Json<RenameRequest>,
) -> impl IntoResponse {
    let Some((base, _)) = resolve_base_from_query(&state, req.session.as_deref(), req.workspace.as_deref()).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

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

    match fs::move_path(&base, &req.path, &new_rel).await {
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
```

- [ ] **Step 13: 修改 `move_files` handler**

```rust
async fn move_files(
    State(state): State<AppState>,
    Json(req): Json<MoveRequest>,
) -> impl IntoResponse {
    let Some((base, _)) = resolve_base_from_query(&state, req.session.as_deref(), req.workspace.as_deref()).await else {
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
        let dest = format!(
            "{}/{}",
            req.destination.trim_end_matches('/'),
            file_name
        );
        if let Err(e) = fs::move_path(&base, p, &dest).await {
            error!("move failed: {}", e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": e.to_string() })),
            );
        }
    }

    (StatusCode::OK, Json(json!({ "ok": true })))
}
```

- [ ] **Step 14: 修改 `copy_files` handler**

```rust
async fn copy_files(
    State(state): State<AppState>,
    Json(req): Json<CopyRequest>,
) -> impl IntoResponse {
    let Some((base, _)) = resolve_base_from_query(&state, req.session.as_deref(), req.workspace.as_deref()).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    match fs::copy_paths(&base, &req.paths, &req.destination).await {
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
```

- [ ] **Step 15: 修改 `search_files` handler**

```rust
async fn search_files(
    State(state): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> impl IntoResponse {
    let rel_path = q.path.as_deref().unwrap_or("");

    let Some((base, _)) = resolve_base_from_query(&state, q.session.as_deref(), q.workspace.as_deref()).await else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "workspace or session not found" })),
        );
    };

    match fs::search_files(&base, rel_path, &q.q).await {
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
```

- [ ] **Step 16: 验证编译通过**

```bash
cd /home/pax/coding/OmniTerm-dev && cargo check
```

Expected: 编译成功。

- [ ] **Step 17: Commit**

```bash
git add src/api/files.rs
git commit -m "feat(api): add session parameter to all file operation endpoints"
```

---

### Task 4: 前端 — appStore 新增 FM session 状态

**Files:**
- Modify: `frontend/src/stores/appStore.ts`

**Interfaces:**
- Produces: `fmSessionStates`, `setFmSessionMode()`, `setFmManualPath()`, `resetFmToFollowing()`

- [ ] **Step 1: 添加 FmSessionState 接口和新状态**

在 `frontend/src/stores/appStore.ts` 中，在 `Session` interface 之后添加：

```typescript
interface FmSessionState {
  mode: 'following' | 'manual'
  manualPath: string | null  // 手动模式下的绝对路径
}
```

在 `AppState` interface 中添加新字段和 actions：

```typescript
interface AppState {
  // ... 现有字段 ...

  // FM session states
  fmSessionStates: Record<string, FmSessionState>

  // ... 现有 actions ...

  // FM session actions
  setFmSessionMode: (sessionId: string, mode: 'following' | 'manual') => void
  setFmManualPath: (sessionId: string, path: string | null) => void
  resetFmToFollowing: (sessionId: string) => void
}
```

- [ ] **Step 2: 添加初始状态和 action 实现**

在 `create<AppState>((set) => ({` 内添加初始值：

```typescript
  fmSessionStates: {},
```

在现有 actions 之后添加新 actions：

```typescript
  setFmSessionMode: (sessionId, mode) =>
    set((s) => ({
      fmSessionStates: {
        ...s.fmSessionStates,
        [sessionId]: {
          ...s.fmSessionStates[sessionId],
          mode,
          ...(mode === 'following' ? { manualPath: null } : {}),
        },
      },
    })),

  setFmManualPath: (sessionId, path) =>
    set((s) => ({
      fmSessionStates: {
        ...s.fmSessionStates,
        [sessionId]: { ...s.fmSessionStates[sessionId], mode: 'manual', manualPath: path },
      },
    })),

  resetFmToFollowing: (sessionId) =>
    set((s) => ({
      fmSessionStates: {
        ...s.fmSessionStates,
        [sessionId]: { mode: 'following', manualPath: null },
      },
    })),
```

- [ ] **Step 3: 验证 TypeScript 编译**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/stores/appStore.ts
git commit -m "feat(store): add per-session FM state (following/manual mode)"
```

---

### Task 5: 前端 — API client 新增方法

**Files:**
- Modify: `frontend/src/api/client.ts`

**Interfaces:**
- Produces: `api.getSessionCwd(sessionId)`, `api.listFilesBySession(sessionId, path, sort, desc)`

- [ ] **Step 1: 添加新 API 方法**

在 `frontend/src/api/client.ts` 的 `api` 对象中，在 `// Sessions` 区块的 `deleteSession` 之后添加：

```typescript
  // Session CWD
  getSessionCwd: (sessionId: string) =>
    request<{ cwd: string }>(`/sessions/${sessionId}/cwd`),
```

在 `// Files` 区块的 `searchFiles` 之后添加：

```typescript
  // Files by session (follows terminal CWD)
  listFilesBySession: (sessionId: string, path?: string, sort?: string, desc?: boolean) => {
    let url = `/files?session=${sessionId}&path=${path || ''}`
    if (sort) url += `&sort=${sort}`
    if (desc) url += `&order=desc`
    return request<{ files: any[]; cwd: string; is_outside_workspace: boolean }>(url)
  },
  uploadFileBySession: (sessionId: string, path: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    return fetch(`/api/v1/files?session=${sessionId}&path=${encodeURIComponent(path)}`, {
      method: 'POST',
      body: form,
    }).then((r) => {
      if (!r.ok) throw new Error(`Upload failed: ${r.status}`)
      return r.json()
    })
  },
  deleteFileBySession: (sessionId: string, path: string) =>
    request(`/files?session=${sessionId}&path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),
  mkdirBySession: (sessionId: string, path: string, name: string) =>
    request('/files/mkdir', { method: 'POST', body: JSON.stringify({ path, name, session: sessionId }) }),
  renameBySession: (sessionId: string, path: string, newName: string) =>
    request('/files/rename', { method: 'POST', body: JSON.stringify({ path, newName, session: sessionId }) }),
  searchFilesBySession: (sessionId: string, query: string, path?: string) =>
    request<any[]>(`/files/search?session=${sessionId}&q=${encodeURIComponent(query)}&path=${path || ''}`),
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/api/client.ts
git commit -m "feat(api): add session-based file operation methods"
```

---

### Task 6: 前端 — 新增图标组件

**Files:**
- Modify: `frontend/src/components/FileManager/icons.tsx`

**Interfaces:**
- Produces: `WarningIcon`, `HomeIcon` — stroke-based SVG components

- [ ] **Step 1: 添加 WarningIcon 和 HomeIcon**

在 `frontend/src/components/FileManager/icons.tsx` 末尾（`IconFolderOpen` 之后）添加：

```tsx
export function IconWarning(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M8 2L1.5 13h13L8 2z" />
      <line x1="8" y1="6" x2="8" y2="9" />
      <circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconHome(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M3 8.5L8 3.5l5 5" />
      <path d="M5 7.5V13h2.5v-3h1v3H11V7.5" />
    </svg>
  )
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/FileManager/icons.tsx
git commit -m "feat(icons): add WarningIcon and HomeIcon components"
```

---

### Task 7: 文档 — UI 风格规范新增 warning 语义色

**Files:**
- Modify: `docs/visual-design/ui-style-guide.md:76-84` (§2.5 功能色)

**Interfaces:**
- Produces: `warning`, `warning-12`, `warning-glow` color tokens

- [ ] **Step 1: 在 UI 风格规范中添加 warning 语义色**

在 `docs/visual-design/ui-style-guide.md` 的 §2.5 功能色表格中，在 `success-glow` 之后添加新行：

```markdown
| `warning` | `#f59e0b` | 警告状态、超出 workspace 边界 |
| `warning-12` | `rgba(245, 158, 11, 0.12)` | 警告背景 |
| `warning-glow` | `0 0 6px rgba(245, 158, 11, 0.3)` | 警告状态辉光 |
```

- [ ] **Step 2: Commit**

```bash
git add docs/visual-design/ui-style-guide.md
git commit -m "docs(style): add warning semantic color tokens"
```

---

### Task 8: 前端 — FileManager 重构为双模式 + 轮询

**Files:**
- Modify: `frontend/src/components/FileManager/FileManager.tsx`

**Interfaces:**
- Consumes: `useAppStore` (fmSessionStates, setFmSessionMode, setFmManualPath, resetFmToFollowing, activeSessionId)
- Consumes: `api.listFilesBySession()`, `api.uploadFileBySession()`, `api.deleteFileBySession()`, `api.mkdirBySession()`, `api.renameBySession()`, `api.searchFilesBySession()`
- Consumes: `IconWarning`, `IconHome` from `./icons`

- [ ] **Step 1: 更新 imports**

替换 `frontend/src/components/FileManager/FileManager.tsx` 的 import 行：

```tsx
import { useState, useEffect, useRef, useCallback, type KeyboardEvent, type DragEvent } from 'react'
import { api } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'
import { useAppStore } from '../../stores/appStore'
import { IconFolder, IconFile, IconLink, IconArrowUp, IconRefresh, IconUpload, IconPencil, IconTrash, IconFolderOpen, IconWarning, IconHome } from './icons'
```

- [ ] **Step 2: 重写组件状态和 store 绑定**

替换 `FileManager` 函数开头（从 `export function FileManager()` 到 `const [colWidths, setColWidths] = ...` 之前）：

```tsx
const POLL_MS = 3000

export function FileManager() {
  const addToast = useToastStore((s) => s.addToast)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const fileManagerCollapsed = useAppStore((s) => s.fileManagerCollapsed)
  const toggleFileManagerCollapsed = useAppStore((s) => s.toggleFileManagerCollapsed)
  const fmSessionStates = useAppStore((s) => s.fmSessionStates)
  const setFmSessionMode = useAppStore((s) => s.setFmSessionMode)
  const setFmManualPath = useAppStore((s) => s.setFmManualPath)
  const resetFmToFollowing = useAppStore((s) => s.resetFmToFollowing)

  // Current session's FM state (defaults to following)
  const fmState = activeSessionId ? (fmSessionStates[activeSessionId] ?? { mode: 'following' as const, manualPath: null }) : { mode: 'following' as const, manualPath: null }

  const [files, setFiles] = useState<FileEntry[]>([])
  const [cwd, setCwd] = useState('')  // absolute path from server
  const [isOutsideWorkspace, setIsOutsideWorkspace] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDesc, setSortDesc] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editingName, setEditingName] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [colWidths, setColWidths] = useState({ name: 300, mtime: 140, size: 100 })
```

- [ ] **Step 3: 实现 fetchFiles (session-based)**

替换现有的 `fetchFiles` 函数：

```tsx
  const fetchFiles = useCallback(async (path?: string, sort?: string, desc?: boolean) => {
    if (!activeSessionId) { setFiles([]); return }
    setLoading(true)
    try {
      const effectivePath = path ?? (fmState.mode === 'manual' && fmState.manualPath ? fmState.manualPath : '.')
      const data = await api.listFilesBySession(activeSessionId, effectivePath, sort ?? sortKey, desc ?? sortDesc)
      setFiles(data.files ?? [])
      if (data.cwd) setCwd(data.cwd)
      setIsOutsideWorkspace(data.is_outside_workspace ?? false)
      setSelected(new Set())
    } catch (err: any) {
      addToast('error', err.message || '加载文件列表失败')
      setFiles([])
    } finally {
      setLoading(false)
    }
  }, [activeSessionId, fmState.mode, fmState.manualPath, sortKey, sortDesc])
```

- [ ] **Step 4: 实现轮询 effect (following mode)**

替换现有的 `useEffect(() => { fetchFiles(currentPath) }, [currentPath, activeWorkspaceId])`：

```tsx
  // Polling: following mode — auto-sync with terminal CWD
  useEffect(() => {
    if (!activeSessionId || fmState.mode !== 'following') return
    // Initial fetch
    fetchFiles('.')
    const id = setInterval(() => fetchFiles('.'), POLL_MS)
    return () => clearInterval(id)
  }, [activeSessionId, fmState.mode, fetchFiles])

  // Manual mode: fetch once when manualPath changes
  useEffect(() => {
    if (!activeSessionId || fmState.mode !== 'manual' || !fmState.manualPath) return
    fetchFiles(fmState.manualPath)
  }, [activeSessionId, fmState.mode, fmState.manualPath, fetchFiles])

  // Session switch: restore state
  useEffect(() => {
    if (!activeSessionId) return
    // If manual mode with a path, fetch it; otherwise following will handle via polling
    if (fmState.mode === 'manual' && fmState.manualPath) {
      fetchFiles(fmState.manualPath)
    }
  }, [activeSessionId])
```

- [ ] **Step 5: 实现导航和操作函数**

替换现有的 `navigateTo`、`handleRowClick`、`handleSort` 函数：

```tsx
  const navigateTo = (absolutePath: string) => {
    if (!activeSessionId) return
    // Switch to manual mode with absolute path
    setFmSessionMode(activeSessionId, 'manual')
    setFmManualPath(activeSessionId, absolutePath)
  }

  const handleHome = () => {
    if (!activeSessionId) return
    resetFmToFollowing(activeSessionId)
    // Next poll will sync to terminal CWD
  }

  const handleRowClick = (entry: FileEntry, e: React.MouseEvent) => {
    if (editingName) return
    if (entry.path_type === 'Dir' || entry.path_type === 'SymlinkDir') {
      const newPath = cwd ? `${cwd}/${entry.name}` : entry.name
      navigateTo(newPath)
      return
    }
    const fullPath = cwd ? `${cwd}/${entry.name}` : entry.name
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        next.has(fullPath) ? next.delete(fullPath) : next.add(fullPath)
        return next
      })
    } else {
      setSelected(new Set([fullPath]))
    }
  }

  const handleSort = (key: SortKey) => {
    let newDesc: boolean
    if (key === sortKey) {
      newDesc = !sortDesc
    } else {
      newDesc = key === 'name' ? false : true
    }
    setSortKey(key)
    setSortDesc(newDesc)
    fetchFiles(undefined, key, newDesc)
  }
```

- [ ] **Step 6: 实现文件操作函数 (session-based)**

替换现有的 `handleDrop`、`commitRename`、`handleDelete`、`handleUpload`、`handleSearch` 函数：

```tsx
  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const droppedFiles = e.dataTransfer?.files
    if (!droppedFiles?.length || !activeSessionId) return
    for (let i = 0; i < droppedFiles.length; i++) {
      const file = droppedFiles[i]
      try {
        await api.uploadFileBySession(activeSessionId, cwd, file)
      } catch (err: any) {
        addToast('error', `上传 ${file.name} 失败: ${err.message}`)
      }
    }
    addToast('success', '上传完成')
    fetchFiles()
  }

  const commitRename = async () => {
    if (!editingName || !editValue.trim() || !activeSessionId) { setEditingName(null); return }
    try {
      await api.renameBySession(activeSessionId, editingName, editValue.trim())
      addToast('success', '重命名成功')
      fetchFiles()
    } catch (err: any) {
      addToast('error', err.message || '重命名失败')
    }
    setEditingName(null)
  }

  const handleDelete = async () => {
    if (selected.size === 0 || !activeSessionId) return
    if (!confirm(`确定删除 ${selected.size} 个项目？`)) return
    try {
      for (const path of selected) {
        await api.deleteFileBySession(activeSessionId, path)
      }
      addToast('success', `已删除 ${selected.size} 个项目`)
      fetchFiles()
    } catch (err: any) {
      addToast('error', err.message || '删除失败')
    }
  }

  const handleUpload = () => {
    if (!activeSessionId) return
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = async () => {
      if (!input.files?.length) return
      for (let i = 0; i < input.files.length; i++) {
        try {
          await api.uploadFileBySession(activeSessionId, cwd, input.files[i])
        } catch (err: any) {
          addToast('error', `上传失败: ${err.message}`)
        }
      }
      addToast('success', '上传完成')
      fetchFiles()
    }
    input.click()
  }

  const handleSearch = async () => {
    if (!searchQuery.trim() || !activeSessionId) { fetchFiles(); return }
    setLoading(true)
    try {
      const results = await api.searchFilesBySession(activeSessionId, searchQuery, cwd)
      setFiles(results)
    } catch (err: any) {
      addToast('error', err.message || '搜索失败')
    } finally {
      setLoading(false)
    }
  }
```

- [ ] **Step 7: 更新 breadcrumb 渲染**

替换现有的 breadcrumb 渲染部分：

```tsx
      {cwd && (
        <div className="fm-breadcrumb">
          <span
            className="fm-bc-seg"
            onClick={() => { if (activeSessionId) { resetFmToFollowing(activeSessionId) } }}
            title="回到终端当前目录"
          >/</span>
          {cwd.split('/').filter(Boolean).map((seg, i, arr) => {
            const segPath = '/' + arr.slice(0, i + 1).join('/')
            return (
              <span key={segPath}>
                <span className="fm-bc-sep">/</span>
                <span className="fm-bc-seg" onClick={() => navigateTo(segPath)}>{seg}</span>
              </span>
            )
          })}
          {isOutsideWorkspace && (
            <span
              className="fm-warning-icon"
              title="当前目录超出 workspace 边界"
              style={{ marginLeft: 6, color: '#f59e0b', cursor: 'help' }}
            >
              <IconWarning width={14} height={14} />
            </span>
          )}
        </div>
      )}
```

- [ ] **Step 8: 更新 toolbar（添加 Home 按钮）**

在 toolbar 的 `fm-toolbar-right` div 中，在刷新按钮之前添加 Home 按钮：

```tsx
        <div className="fm-toolbar-right">
          <input
            className="fm-search"
            placeholder="搜索文件名..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
          />
          {fmState.mode === 'manual' && (
            <button className="fm-btn" onClick={handleHome} title="回到终端目录">
              <IconHome />
            </button>
          )}
          <button
            className="fm-btn"
            onClick={() => {
              const parentPath = getParentPath(cwd)
              if (parentPath) navigateTo(parentPath)
            }}
            disabled={!cwd}
            title="返回上级"
          >
            <IconArrowUp />
          </button>
          <button className="fm-btn" onClick={() => fetchFiles()} title="刷新">
            <IconRefresh />
          </button>
          <button className="fm-btn" onClick={handleUpload} title="上传文件">
            <IconUpload />
          </button>
        </div>
```

- [ ] **Step 9: 更新空状态**

替换现有的空状态检查逻辑：

```tsx
        {!activeSessionId ? (
          <div className="fm-empty">
            <span className="fm-empty-icon"><IconFolderOpen width={32} height={32} style={{ color: '#a78bfa', filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.4))' }} /></span>
            <span>请先在侧栏选择一个终端会话</span>
          </div>
        ) : loading ? (
          <div className="fm-empty">加载中...</div>
        ) : files.length === 0 ? (
          <div className="fm-empty">
            <span className="fm-empty-icon"><IconFolderOpen width={32} height={32} style={{ color: '#a78bfa', filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.4))' }} /></span>
            <span>此目录为空</span>
            <span className="fm-empty-hint">拖放文件到此处上传</span>
          </div>
```

- [ ] **Step 10: 更新 handleRowClick 中的 fullPath 使用绝对路径**

在文件列表的 `tbody` 中，更新 `fullPath` 的计算：

```tsx
                {files.map((f) => {
                  const fullPath = cwd ? `${cwd}/${f.name}` : f.name
                  const isDir = f.path_type === 'Dir' || f.path_type === 'SymlinkDir'
                  const isEditing = editingName === fullPath
                  const isSel = selected.has(fullPath)
```

- [ ] **Step 11: 删除不再需要的 URL hash 逻辑**

删除文件顶部的 `useEffect`（读取 `window.location.hash` 的部分），因为现在路径由 session CWD 决定：

```tsx
  // 删除这段:
  // useEffect(() => {
  //   const hash = window.location.hash
  //     if (hash.startsWith('#/fm')) {
  //     const raw = hash.slice(4).replace(/^\//, '')
  //     setCurrentPath(decodeURIComponent(raw))
  //   }
  // }, [])
```

同时删除 `navigateTo` 中的 `window.location.hash = ...` 行。

- [ ] **Step 12: 验证 TypeScript 编译**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 13: Commit**

```bash
git add frontend/src/components/FileManager/FileManager.tsx
git commit -m "feat(fm): refactor FileManager to follow terminal CWD with dual mode"
```

---

### Task 9: 验证与收尾

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 编译检查（全项目）**

```bash
cd /home/pax/coding/OmniTerm-dev && cargo check
cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit
```

Expected: 两者均无错误。

- [ ] **Step 2: 启动并手动测试**

```bash
cd /home/pax/coding/OmniTerm-dev && ./dev.sh start
```

测试场景：
1. 创建 workspace + session → FM 跟随终端 CWD 显示文件
2. 在终端 `cd` 到子目录 → 3 秒后 FM 自动更新
3. 在 FM 中点击子目录 → 切换到手动模式，Home 按钮出现
4. 点击 Home 按钮 → 回到跟随模式
5. 在终端 `cd` 到 workspace 外 → FM 显示警告图标
6. 切换 session → FM 恢复该 session 的状态
7. 删除、上传、重命名文件 → 正常工作

- [ ] **Step 3: 更新 CHANGELOG.md**

在 `CHANGELOG.md` 的 `[Unreleased]` 区块下添加：

```markdown
### Added
- 文件管理器跟随终端 CWD 功能 (#fm-session-follow)
  - 新增 `GET /api/v1/sessions/{id}/cwd` 端点，查询终端实时工作目录
  - 文件 API 支持 `session` 参数，基于终端 CWD 而非 workspace root
  - 文件管理器双模式导航：跟随模式（自动同步终端 CWD）+ 手动导航
  - 超出 workspace 边界时显示 amber 警告图标
  - per-session FM 状态记忆（切换 session 自动恢复）
  - Home 按钮：从手动模式回到跟随模式
  - 新增 `WarningIcon`、`IconHome` 图标组件
  - UI 风格规范新增 `warning` 语义色（`#f59e0b`）
```

- [ ] **Step 4: Final Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: add FM session-follow feature to CHANGELOG"
```
