# 文件管理器工作区跟踪 实现计划

> **目标读者:** 实现此计划的 agent。每个步骤都是独立可测试的，带精确代码和命令。

**目标:** 用户点击工作区时 FileManager 展示工作区根目录，支持完整文件操作；脱离终端目录时"回到终端目录"按钮脉冲提醒。

**架构:** 前端 FileManager 新增 `useFmSource()` 封装数据源优先级（session > workspace），后端 `list_files` 新增 `workspace_id` 参数解析工作区路径。所有写操作（上传/删除/重命名等）同步适配。

**技术栈:** Rust/Axum 后端 + React/TypeScript 前端，不引入新依赖。

## 全局约束

- `workspace_id` 与 `session` 参数互斥，只能传一个
- 脉冲动画复用 UI 规范 §6.4 的呼吸动画模式（`.fm-btn-terminal-active`）
- 工作区模式下不启用 SSE 文件监听
- 工作区浏览位置不持久化
- 所有 API 参数名用 snake_case（后端），camelCase（前端）

---

### Task 1: 后端 — `list_files` 支持 `workspace_id`

**文件:**
- 修改: `src/api/files.rs:31-38` (FileQuery 结构体), `src/api/files.rs:166-254` (list_files 函数)

**接口:**
- 消费: `FileQuery` 已有字段 `workspace`(即 project_id), `session`, `path`
- 产出: `GET /api/v1/files?workspace_id=<id>&workspace=<project_id>` 返回工作区根目录文件列表

- [ ] **Step 1: 给 FileQuery 添加 `workspace_id` 字段**

在 `src/api/files.rs` 的 `FileQuery` 结构体中添加：

```rust
#[derive(Deserialize)]
struct FileQuery {
    path: Option<String>,
    workspace: Option<String>,      // project_id (existing, misnamed)
    session: Option<String>,
    workspace_id: Option<String>,   // NEW: actual workspace id
    sort: Option<String>,
    order: Option<String>,
}
```

- [ ] **Step 2: 添加 workspace 路径解析辅助函数**

在 `src/api/files.rs` 中，`resolve_base_from_query` 函数之后（约第 164 行后）添加：

```rust
/// Resolve workspace root path from workspace_id + project_id.
/// Workspaces are discovered dynamically from git worktrees.
async fn resolve_workspace_root(
    state: &AppState,
    workspace_id: &str,
    project_id: &str,
) -> Option<String> {
    use crate::workspaces;
    let Some(project_root) = resolve_project_root(state, project_id).await else {
        return None;
    };
    let project = crate::models::project::Project {
        id: project_id.to_string(),
        name: String::new(),
        path: project_root,
        target_id: None,
        created_at: String::new(),
    };
    let wts = workspaces::list_workspaces(&project).await;
    wts.into_iter()
        .find(|w| w.id == workspace_id)
        .map(|w| w.path)
}
```

- [ ] **Step 3: 修改 `list_files` 支持 `workspace_id`**

将 `list_files` 的 else 分支（project-based 模式，约第 225-253 行）改为以下：

```rust
    } else if let Some(workspace_id) = q.workspace_id.as_deref() {
        // Workspace-based mode: resolve workspace path from workspace_id
        let project_id = q.workspace.as_deref().unwrap_or("default");

        let Some(root) = resolve_workspace_root(&state, workspace_id, project_id).await else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "workspace not found" })),
            );
        };

        let base = std::path::Path::new(&root);
        if !base.exists() {
            return (StatusCode::OK, Json(json!({ "files": [], "cwd": root, "is_outside_workspace": false })));
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
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "path not found" })),
            );
        };

        match fs::list_dir(&canonical, "", sort, desc).await {
            Ok(entries) => (
                StatusCode::OK,
                Json(json!({ "files": entries, "cwd": canonical.to_string_lossy(), "is_outside_workspace": false })),
            ),
            Err(e) => {
                error!("list_files (workspace) failed: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({ "error": e.to_string() })),
                )
            }
        }
    } else if let Some(project_id) = q.workspace.as_deref() {
        // Project-based mode (existing fallback, unchanged)
        // ... keep existing project-based code ...
    } else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "session, workspace_id, or workspace parameter required" })),
        );
    }
```

注意：保留现有 project-based 分支（`q.workspace` fallback）在最后。

- [ ] **Step 4: 编译验证**

```bash
cd /home/pax/coding/OmniTerm-dev && source "$HOME/.cargo/env" && cargo check 2>&1 | tail -20
```

预期: `Finished` 无错误。如有编译错误，根据错误信息修复。

- [ ] **Step 5: 提交**

```bash
git add src/api/files.rs
git commit -m "feat: list_files 支持 workspace_id 参数展示工作区根目录"
```

---

### Task 2: 后端 — 所有文件操作适配 `workspace_id`

**文件:**
- 修改: `src/api/files.rs` (upload_file, delete_file, download_file, read_file, write_file, mkdir, rename, move_files, copy_files, search_files)
- 修改: `src/api/files.rs` (RenameRequest, MoveRequest, CopyRequest 结构体)
- 修改: `src/api/files.rs` (search_files 的 SearchQuery 结构体)
- 修改: `src/api/files.rs:149-164` (resolve_base_from_query 函数)

**接口:**
- 消费: Task 1 的 `resolve_workspace_root` 函数
- 产出: 所有文件操作均支持 `workspace_id` 参数

- [ ] **Step 1: 给请求结构体添加 `workspace_id` 字段**

```rust
#[derive(Deserialize)]
struct SearchQuery {
    q: String,
    path: Option<String>,
    workspace: Option<String>,
    session: Option<String>,
    workspace_id: Option<String>,   // NEW
}

#[derive(Deserialize)]
struct RenameRequest {
    path: String,
    #[serde(rename = "newName")]
    new_name: String,
    workspace: Option<String>,
    session: Option<String>,
    workspace_id: Option<String>,   // NEW
}

#[derive(Deserialize)]
struct MoveRequest {
    paths: Vec<String>,
    destination: String,
    workspace: Option<String>,
    session: Option<String>,
    workspace_id: Option<String>,   // NEW
}

#[derive(Deserialize)]
struct CopyRequest {
    paths: Vec<String>,
    destination: String,
    workspace: Option<String>,
    session: Option<String>,
    workspace_id: Option<String>,   // NEW
}
```

- [ ] **Step 2: 修改 `resolve_base_from_query` 支持 `workspace_id`**

将 `resolve_base_from_query` 函数签名和逻辑改为：

```rust
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
```

- [ ] **Step 3: 更新所有调用 `resolve_base_from_query` 的地方**

每个函数（`upload_file`, `delete_file`, `download_file`, `read_file`, `write_file`, `mkdir`, `rename`, `move_files`, `copy_files`, `search_files`）中，将调用：

```rust
// 旧:
let Some((base, _)) = resolve_base_from_query(&state, q.session.as_deref(), q.workspace.as_deref()).await

// 新:
let Some((base, _)) = resolve_base_from_query(&state, q.session.as_deref(), q.workspace_id.as_deref(), q.workspace.as_deref()).await
```

对于 `rename`, `move_files`, `copy_files`（使用 RenameRequest/MoveRequest/CopyRequest），改为：

```rust
let Some((base, _)) = resolve_base_from_query(&state, req.session.as_deref(), req.workspace_id.as_deref(), req.workspace.as_deref()).await
```

对于 `search_files`（使用 SearchQuery）：

```rust
let Some((base, _)) = resolve_base_from_query(&state, q.session.as_deref(), q.workspace_id.as_deref(), q.workspace.as_deref()).await
```

- [ ] **Step 4: 编译验证**

```bash
cd /home/pax/coding/OmniTerm-dev && source "$HOME/.cargo/env" && cargo check 2>&1 | tail -30
```

预期: `Finished` 无错误。逐一检查每个修改过的函数调用签名匹配。

- [ ] **Step 5: 提交**

```bash
git add src/api/files.rs
git commit -m "feat: 所有文件操作端点支持 workspace_id 参数"
```

---

### Task 3: 前端 — API Client 适配

**文件:**
- 修改: `frontend/src/api/client.ts:116-194`

**接口:**
- 消费: 后端新增的 `workspace_id` 参数
- 产出: 前端所有文件 API 调用统一支持 `session` 或 `workspaceId`

- [ ] **Step 1: 添加通用的 `listFiles` 方法**

在 `api` 对象中，添加一个新的 `listFiles` 方法（保留旧的作为兼容，后续 Task 可清理）：

```ts
// 通用文件列表 — 支持 session 或 workspaceId（二选一）
listFiles: (params: { session?: string; workspaceId?: string; projectId?: string; path?: string; sort?: string; desc?: boolean }) => {
  let url = `/files?path=${params.path || ''}`
  if (params.session) url += `&session=${params.session}`
  if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
  if (params.projectId) url += `&workspace=${params.projectId}`
  if (params.sort) url += `&sort=${params.sort}`
  if (params.desc) url += `&order=desc`
  return request<{ files: any[]; cwd: string; is_outside_workspace: boolean }>(url)
},
```

- [ ] **Step 2: 为所有写操作添加通用的 session/workspaceId 方法**

添加以下方法（每个操作接受 `{ session?, workspaceId?, projectId? }`）：

```ts
// 删除
deleteFile2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string }) => {
  let url = `/files?path=${encodeURIComponent(params.path)}`
  if (params.session) url += `&session=${params.session}`
  if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
  if (params.projectId) url += `&workspace=${params.projectId}`
  return request(url, { method: 'DELETE' })
},

// 上传
uploadFile2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string; file: File }) => {
  const form = new FormData()
  form.append('file', params.file)
  let url = `/api/v1/files?path=${encodeURIComponent(params.path)}`
  if (params.session) url += `&session=${params.session}`
  if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
  if (params.projectId) url += `&workspace=${params.projectId}`
  return fetch(url, { method: 'POST', body: form }).then((r) => {
    if (!r.ok) throw new Error(`Upload failed: ${r.status}`)
    return r.json()
  })
},

// 下载 URL
downloadUrl2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string }) => {
  let url = `/api/v1/files/download?path=${encodeURIComponent(params.path)}`
  if (params.session) url += `&session=${params.session}`
  if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
  if (params.projectId) url += `&workspace=${params.projectId}`
  return url
},

// 读取文件
readFile2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string }) => {
  let url = `/files/read?path=${encodeURIComponent(params.path)}`
  if (params.session) url += `&session=${params.session}`
  if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
  if (params.projectId) url += `&workspace=${params.projectId}`
  return request<{ content: string }>(url)
},

// 写入文件
writeFile2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string; content: string }) => {
  let url = `/files/write?path=${encodeURIComponent(params.path)}`
  if (params.session) url += `&session=${params.session}`
  if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
  if (params.projectId) url += `&workspace=${params.projectId}`
  return request(url, { method: 'POST', body: JSON.stringify({ content: params.content }) })
},

// 创建目录
mkdir2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string; name: string }) => {
  const body: any = { path: params.path, name: params.name }
  if (params.session) body.session = params.session
  if (params.workspaceId) body.workspace_id = params.workspaceId
  if (params.projectId) body.workspace = params.projectId
  return request('/files/mkdir', { method: 'POST', body: JSON.stringify(body) })
},

// 重命名
rename2: (params: { session?: string; workspaceId?: string; projectId?: string; path: string; newName: string }) => {
  const body: any = { path: params.path, newName: params.newName }
  if (params.session) body.session = params.session
  if (params.workspaceId) body.workspace_id = params.workspaceId
  if (params.projectId) body.workspace = params.projectId
  return request('/files/rename', { method: 'POST', body: JSON.stringify(body) })
},

// 搜索
searchFiles2: (params: { session?: string; workspaceId?: string; projectId?: string; query: string; path?: string }) => {
  let url = `/files/search?q=${encodeURIComponent(params.query)}&path=${params.path || ''}`
  if (params.session) url += `&session=${params.session}`
  if (params.workspaceId) url += `&workspace_id=${params.workspaceId}`
  if (params.projectId) url += `&workspace=${params.projectId}`
  return request<any[]>(url)
},
```

- [ ] **Step 3: TypeScript 类型检查**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && pnpm tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: 提交**

```bash
git add frontend/src/api/client.ts
git commit -m "feat: API client 新增通用文件操作方法支持 session/workspaceId 双模式"
```

---

### Task 4: 前端 — FileManager `useFmSource()` hook 与核心逻辑改造

**文件:**
- 修改: `frontend/src/components/FileManager/FileManager.tsx`

**接口:**
- 消费: appStore 的 `activeSessionId`, `activeWorkspaceId`, `activeProjectId`, `fmSessionStates`
- 消费: api.client 的通用文件方法（Task 3）
- 产出: `useFmSource()` 返回 `{ type: 'session' | 'workspace', id: string } | null`

- [ ] **Step 1: 读取 `activeWorkspaceId` 和 `activeProjectId`**

在 FileManager 组件顶部（约第 66 行），添加：

```ts
const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
const activeProjectId = useAppStore((s) => s.activeProjectId)
```

- [ ] **Step 2: 实现 `useFmSource()` 并替换 `activeSessionId` 的条件判断**

在 fetchFiles 上方（约第 124 行前）添加 source 计算：

```ts
// Data source: session > workspace > null
type FmSource = { type: 'session'; id: string } | { type: 'workspace'; id: string }
const fmSource: FmSource | null = activeSessionId
  ? { type: 'session', id: activeSessionId }
  : activeWorkspaceId
    ? { type: 'workspace', id: activeWorkspaceId }
    : null
const sourceKey = fmSource ? `${fmSource.type}:${fmSource.id}` : null
```

- [ ] **Step 3: 改造 `fetchFiles` 支持双模式**

将 `fetchFiles` 改为（替换第 125-148 行）：

```ts
const fetchFiles = useCallback(async (path?: string, sort?: string, desc?: boolean, silent = false): Promise<string | undefined> => {
  if (!fmSource) { setFiles([]); return undefined }
  if (!silent) setLoading(true)
  try {
    // In workspace mode, always manual (no terminal to follow)
    const effectiveMode = fmSource.type === 'workspace' ? 'manual' : fmState.mode
    const effectivePath = path ?? (effectiveMode === 'manual' && fmState.manualPath ? fmState.manualPath : '.')
    const data = await api.listFiles({
      session: fmSource.type === 'session' ? fmSource.id : undefined,
      workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
      projectId: activeProjectId ?? undefined,
      path: effectivePath,
      sort: sort ?? sortKey,
      desc: desc ?? sortDesc,
    })
    const newFiles = data.files ?? []
    setFiles((prev) => filesEqual(prev, newFiles) ? prev : newFiles)
    if (data.cwd) setCwd(data.cwd)
    setIsOutsideWorkspace(data.is_outside_workspace ?? false)
    if (data.cwd) {
      fileCache.current.set(sourceKey!, { files: newFiles, cwd: data.cwd, isOutsideWorkspace: data.is_outside_workspace ?? false })
    }
    if (!silent) setSelected(new Set())
    return data.cwd
  } catch (err: any) {
    if (!silent) addToast('error', err.message || t('fm.loadFailed'))
    if (!silent) setFiles([])
    return undefined
  } finally {
    if (!silent) setLoading(false)
  }
}, [fmSource, sourceKey, fmState.mode, fmState.manualPath, activeProjectId, sortKey, sortDesc])
```

- [ ] **Step 4: 更新所有 effect 依赖**

将所有依赖 `activeSessionId` 的 `useEffect` 改为依赖 `sourceKey`：

```ts
// SSE-driven refresh (第 151-154 行)
useEffect(() => {
  if (!fileChangeEvent || !fmSource || fmSource.type !== 'workspace') return  // only for session mode
  if (!fileChangeEvent || !activeSessionId) return  // keep existing guard
  fetchFiles(undefined, undefined, undefined, true)
}, [fileChangeEvent, activeSessionId])  // unchanged, SSE only relevant for sessions

// Manual mode fetch (第 162-165 行)
useEffect(() => {
  if (!fmSource || fmSource.type === 'workspace') return  // workspace mode: handled below
  if (fmState.mode !== 'manual' || !fmState.manualPath) return
  fetchFiles(fmState.manualPath)
}, [sourceKey, fmState.mode, fmState.manualPath, fetchFiles])

// Following mode fetch (第 168-171 行)
useEffect(() => {
  if (!fmSource || fmSource.type === 'workspace') return  // no following in workspace mode
  if (fmState.mode !== 'following') return
  fetchFiles('.')
}, [sourceKey, fmState.mode, fetchFiles])

// Source switch (formerly session switch, 第 174-189 行)
useEffect(() => {
  if (!fmSource) { setFiles([]); setCwd(''); return }
  const cached = fileCache.current.get(sourceKey!)
  if (cached) {
    setFiles(cached.files)
    setCwd(cached.cwd)
    setIsOutsideWorkspace(cached.isOutsideWorkspace)
  }
  if (fmSource.type === 'workspace') {
    // Always start from workspace root
    fetchFiles('.')
  } else if (fmState.mode === 'manual' && fmState.manualPath) {
    fetchFiles(fmState.manualPath)
  } else {
    fetchFiles('.')
  }
}, [sourceKey])
```

- [ ] **Step 5: 更新所有操作函数中的 `activeSessionId` guard**

将以下函数中的 `if (!activeSessionId) return` 替换为 `if (!fmSource) return`，并将 API 调用从 `*BySession` 改为通用方法：

- `navigateTo` (第 216 行): `setFmSessionMode` → 仅 session 模式；workspace 模式直接 `setFmManualPath`
- `handleRowClick` (第 226 行): guard 已有
- `handleRowClick` 中 `setFmDrawerPath` 需要 `activeSessionId`（workspace 模式暂不可用 drawer）
- `handleUpload` (第 390 行): 改用 `api.uploadFile2`
- `handleSearch` (第 410 行): 改用 `api.searchFiles2`
- `handleDownloadClick` (第 429 行): 改用 `api.downloadUrl2`
- `submitCreate` (第 502 行): 改用 `api.mkdir2` / `api.writeFile2`
- `commitRename` (第 364 行): 改用 `api.rename2`
- `handleDelete` (第 376 行): 改用 `api.deleteFile2`
- `handleDrop` (第 338 行): 改用 `api.uploadFile2`

示例 — `handleDelete`:

```ts
const handleDelete = async () => {
  if (selected.size === 0 || !fmSource) return
  if (!confirm(t('fm.confirmDelete', { count: selected.size }))) return
  try {
    for (const p of selected) {
      await api.deleteFile2({
        session: fmSource.type === 'session' ? fmSource.id : undefined,
        workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
        projectId: activeProjectId ?? undefined,
        path: p,
      })
    }
    addToast('success', t('fm.deleted', { count: selected.size }))
    fetchFiles()
  } catch (err: any) {
    addToast('error', err.message || t('fm.deleteFailed'))
  }
}
```

- [ ] **Step 6: 添加脉冲逻辑和终端按钮**

在 toolbar 区域（第 592-600 行），修改终端按钮：

```tsx
{/* "回到终端目录" 按钮 — 脱离终端时脉冲 */}
{activeSessionId && (
  <button
    className={`fm-bc-root ${(fmSource?.type === 'workspace' || (fmSource?.type === 'session' && fmState.mode === 'manual')) ? 'fm-btn-terminal-active' : ''}`}
    onClick={() => {
      if (activeSessionId) resetFmToFollowing(activeSessionId)
    }}
    title={t('fm.backToTerminalDir')}
    disabled={!activeSessionId}
  >
    <IconWorkbench width={13} height={13} />
  </button>
)}
```

脉冲条件：`fmSource.type === 'workspace'` 或 session 手动模式时添加 `fm-btn-terminal-active` class。

- [ ] **Step 7: 添加 CSS 动画**

在 FileManager 的 CSS 文件（`frontend/src/index.css` 或 FileManager 相关样式处）添加：

```css
/* Back-to-terminal button pulse — reuses §6.4 breathing animation pattern */
@keyframes fm-terminal-pulse {
  0%, 100% {
    background: rgba(196, 181, 253, 0.30);
    box-shadow:
      0 0 8px rgba(196, 181, 253, 0.55),
      inset 0 0 0 1px rgba(196, 181, 253, 0.55);
  }
  50% {
    background: rgba(196, 181, 253, 0.58);
    box-shadow:
      0 0 22px rgba(196, 181, 253, 0.95),
      inset 0 0 0 1px rgba(221, 214, 254, 0.85);
  }
}
.fm-btn-terminal-active {
  animation: fm-terminal-pulse 1.0s ease-in-out infinite;
  color: #c4b5fd;
}
.fm-btn-terminal-active:hover {
  background: rgba(196, 181, 253, 0.55);
  color: #ddd6fe;
  box-shadow: 0 0 22px rgba(196, 181, 253, 0.9);
}
```

- [ ] **Step 8: 更新空状态逻辑**

将第 732 行的 `!activeSessionId` 改为 `!fmSource`：

```tsx
{!fmSource ? (
  <div className="fm-empty">
    <span className="fm-empty-icon"><IconFolderOpen width={32} height={32} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.4))' }} /></span>
    <span>{t('fm.selectSessionFirst')}</span>
  </div>
) : ...
```

- [ ] **Step 9: TypeScript 检查**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && pnpm tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 10: 提交**

```bash
git add frontend/src/components/FileManager/FileManager.tsx frontend/src/index.css
git commit -m "feat: FileManager 支持工作区模式数据源与脉冲终端按钮"
```

---

### Task 5: 前端 — Sidebar 终端按钮

**文件:**
- 修改: `frontend/src/components/Sidebar/Sidebar.tsx`

**接口:**
- 消费: appStore 的 `activeSessionId`, `activeWorkspaceId`, `resetFmToFollowing`
- 消费: FileManager 的状态（通过 appStore 间接获取 `fmSessionStates`）
- 产出: Sidebar 折叠按钮旁终端图标按钮

- [ ] **Step 1: 读取所需状态并导入图标**

在 Sidebar 组件顶部添加导入：

```ts
import { IconWorkbench } from '../FileManager/icons'
```

以及状态读取：

```ts
const activeSessionId = useAppStore((s) => s.activeSessionId)
const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
const fmSessionStates = useAppStore((s) => s.fmSessionStates)
const resetFmToFollowing = useAppStore((s) => s.resetFmToFollowing)
```

- [ ] **Step 2: 计算脉冲条件**

```ts
// Terminal button pulse: when outside terminal CWD
const fmState = activeSessionId ? (fmSessionStates[activeSessionId] ?? { mode: 'following' as const, manualPath: null, drawerPath: null, drawerMode: 'view' as const }) : null
const isOutsideTerminalCwd = !activeSessionId
  ? !!activeWorkspaceId  // workspace mode, no session
  : fmState?.mode === 'manual'  // session in manual mode
```

- [ ] **Step 3: 展开状态添加终端按钮**

在展开状态的 header 区域（约第 423-432 行，折叠按钮前），添加：

```tsx
{/* Terminal CWD button — pulses when outside terminal CWD */}
<button
  className={`flex items-center justify-center rounded-md transition-all ${isOutsideTerminalCwd ? 'fm-btn-terminal-active' : ''}`}
  style={{ width: 24, height: 24, color: isOutsideTerminalCwd ? '#c4b5fd' : 'var(--text-faint)', fontSize: 14 }}
  onClick={() => {
    if (activeSessionId) resetFmToFollowing(activeSessionId)
  }}
  title={t('fm.backToTerminalDir')}
  disabled={!activeSessionId}
>
  <IconWorkbench width={13} height={13} />
</button>
```

- [ ] **Step 4: 折叠状态也添加终端按钮**

在折叠状态（约第 371-376 行，中间的装饰圆点区域）替换为终端按钮：

```tsx
<div className="flex-1 flex items-center justify-center">
  <button
    className={`flex items-center justify-center rounded-md transition-all ${isOutsideTerminalCwd ? 'fm-btn-terminal-active' : ''}`}
    style={{ width: 24, height: 24, color: isOutsideTerminalCwd ? '#c4b5fd' : 'var(--text-faint)', fontSize: 14 }}
    onClick={() => {
      if (activeSessionId) resetFmToFollowing(activeSessionId)
    }}
    title={t('fm.backToTerminalDir')}
    disabled={!activeSessionId}
  >
    <IconWorkbench width={14} height={14} />
  </button>
</div>
```

- [ ] **Step 5: TypeScript 检查**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && pnpm tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 6: 提交**

```bash
git add frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "feat: Sidebar 新增回到终端目录按钮（脉冲动画）"
```

---

### Task 6: 集成测试与收尾

**文件:**
- 无新文件

- [ ] **Step 1: 启动服务验证**

```bash
cd /home/pax/coding/OmniTerm-dev && ./dev.sh start
```

- [ ] **Step 2: 手动测试场景**

1. 点击工作区（无聚焦会话）→ FileManager 显示工作区根目录，终端按钮脉冲
2. 在工作区目录中导航子目录 → 保持在工作区手动模式
3. 再点同一工作区 → FileManager 清空
4. 点击会话 → FileManager 切换到终端 CWD，脉冲停止
5. 有聚焦会话时点击工作区 → FileManager 显示工作区根目录，脉冲开始
6. 脉冲中点击终端按钮 → 回到终端 CWD，脉冲停止

- [ ] **Step 3: 提交**

```bash
git add -A
git commit -m "chore: 完成工作区跟踪集成测试"
```
