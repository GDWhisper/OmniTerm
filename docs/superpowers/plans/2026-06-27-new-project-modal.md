# 新建项目窗口：嵌入式目录浏览 实现计划

> **目标读者:** 实现此计划的 agent。每个步骤都是独立可测试的，带精确代码和命令。

**目标:** 在 Sidebar「新建项目」模态框中增加嵌入式目录列表（单层），点选 / 手输两种方式都能定位路径且实时同步；保持现有创建流程（409 覆盖检测 + 自动建目录）不变。

**架构:** 后端新增 `GET /api/v1/system/dirs?path=<abs>` 端点（复用 `fs::list_dir`），前端 Sidebar 模态框加 browse 状态机（`browsePath` / `browseEntries` / `browseLoading` / `browseError`），目录列表区域按 UI 规范渲染。提取 `getParentPath` 到 `utils/path.ts` 供 Sidebar 与 FileManager 共用。

**技术栈:** Rust/Axum 后端 + React/TypeScript 前端，不引入新依赖。

**测试约定:** 本项目无前后端测试框架（仅 `AttentionProvider.test.tsx` 一个例外），沿用手动测试 + `curl` 验证后端。

## 全局约束

- 后端端点不接受未认证请求（沿用 `RequireAuth` middleware）
- 不修改 `create_project` 自动建目录行为（避免 breaking change）
- 视觉严格遵循 `docs/visual-design/ui-style-guide.md` §1-§9（不引入 emoji、4px 列表项圆角、focus ring、hover 0.08、selected 0.14）
- name 字段 Enter = 创建；path 字段 Enter = 应用路径
- API 参数名：后端 snake_case，前端 camelCase
- 端点响应 JSON 字段：`files: FileEntry[]`（与 `/files` 一致）
- 错误用现有 toast 模式，不弹额外 dialog

---

### Task 1: 后端 — 新增 `GET /api/v1/system/dirs` 端点

**文件:**
- 修改: `src/api/system.rs` (全文件 19 行改写)

- [ ] **Step 1: 改写 `src/api/system.rs`**

将整个文件替换为：

```rust
use axum::{extract::Query, routing::get, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::fs::{self, SortKey};
use crate::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/system/info", get(system_info))
        .route("/system/dirs", get(list_dirs))
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
```

- [ ] **Step 2: 检查编译**

```bash
cd /home/pax/coding/OmniTerm-dev && cargo build 2>&1 | tail -20
```

预期：`Finished ...` 0 错误。可能 0-2 个 unused import warning（State 未使用是因为 `_state` 占位），不阻断。

- [ ] **Step 3: 启动后端并 curl 验证**

后端启动（如果尚未运行）：
```bash
cd /home/pax/coding/OmniTerm-dev && ./dev.sh start
```

curl 测试：
```bash
# 先拿 token（如果有 auth）
TOKEN=$(curl -s -c - -X POST http://localhost:9777/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"<your-password>"}' | grep omniterm_token | awk '{print $7}')

# 列出 home 目录
curl -s "http://localhost:9777/api/v1/system/dirs?path=$HOME" \
  -H "Authorization: Bearer $TOKEN" | head -c 500
```

预期：返回 `{"files":[{"path_type":"Dir","name":"...","mtime":...,"size":...}, ...]}`。

- [ ] **Step 4: 验证错误路径**

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:9777/api/v1/system/dirs?path=/nonexistent-xyz123" \
  -H "Authorization: Bearer $TOKEN"
```

预期：`404`

```bash
# 验证 path 是文件而非目录时返回 400
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:9777/api/v1/system/dirs?path=/etc/hostname" \
  -H "Authorization: Bearer $TOKEN"
```

预期：`400`

- [ ] **Step 5: 提交**

```bash
cd /home/pax/coding/OmniTerm-dev
git add src/api/system.rs
git commit -m "feat: 新增 GET /api/v1/system/dirs 端点（无上下文目录浏览）"
```

---

### Task 2: 前端 — 创建 `utils/path.ts` 工具

**文件:**
- 创建: `frontend/src/utils/path.ts`

- [ ] **Step 1: 创建 `frontend/src/utils/path.ts`**

```ts
// frontend/src/utils/path.ts
//
// Pure path utilities. Currently only used by file browsing UIs
// (FileManager, new-project modal) but kept generic for future reuse.

/**
 * Return the parent directory of `path`, or '' if `path` is root or empty.
 *
 * - ''  /  '/'  → '' (root has no parent)
 * - '/a'         → ''
 * - '/a/b'       → '/a'
 * - '/a/b/'      → '/a'
 * - 'a/b'        → 'a'  (relative paths work too)
 */
export function getParentPath(path: string): string {
  if (!path || path === '/') return ''
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '' : trimmed.slice(0, idx)
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit 2>&1 | head -20
```

预期：0 错误（如果 tsc 报告未使用，先继续 Task 3 之后再回头检查）。

- [ ] **Step 3: 提交**

```bash
cd /home/pax/coding/OmniTerm-dev
git add frontend/src/utils/path.ts
git commit -m "feat: 新增 utils/path.ts 工具（getParentPath）"
```

---

### Task 3: 前端 — FileManager 改用 `utils/path` 共享函数

**文件:**
- 修改: `frontend/src/components/FileManager/FileManager.tsx:36-41` (删除本地 getParentPath)

- [ ] **Step 1: 在 FileManager 顶部 imports 块添加导入**

在 `frontend/src/components/FileManager/FileManager.tsx` 第 1-7 行附近的 imports 块，**保留原有 imports 不动**，在最前面添加：

```ts
import { getParentPath } from '../../utils/path'
```

> 注释：放到第一行，遵循现有 imports 风格（项目内已有 `from '../...'` 风格的相对导入）。

- [ ] **Step 2: 删除文件内本地 `getParentPath` 函数**

删除第 36-41 行（`FileManager.tsx:36-41`）的整个函数定义：

```ts
function getParentPath(path: string): string {
  if (!path || path === '/') return ''
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '' : trimmed.slice(0, idx)
}
```

（删除后留下的空白行可清理也可保留——空行不影响行为。）

- [ ] **Step 3: 验证编译**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit 2>&1 | head -20
```

预期：0 错误。如果有「`getParentPath` is declared but never used」之类的 warning（说明本地版本被删除后整个文件没用上），先做下面 Step 4 验证 FileManager 真的在用。

- [ ] **Step 4: 启动前端并确认 FileManager 工作**

```bash
# 如果前端未运行
cd /home/pax/coding/OmniTerm-dev && ./dev.sh status
cd /home/pax/coding/OmniTerm-dev && ./dev.sh start  # 如需要
```

浏览器访问 `http://<dev-server>:9778`，点击 Sidebar 中的会话，验证 FileManager：
- 正常列出文件
- 目录可以点击进入
- 路径不会因为删除 `getParentPath` 而报错

- [ ] **Step 5: 提交**

```bash
cd /home/pax/coding/OmniTerm-dev
git add frontend/src/components/FileManager/FileManager.tsx
git commit -m "refactor: FileManager 改用 utils/path 的 getParentPath（消除重复）"
```

---

### Task 4: 前端 — `api.listDirs` 与 `FileEntry` 类型

**文件:**
- 修改: `frontend/src/api/client.ts`

- [ ] **Step 1: 添加 `FileEntry` 类型导出**

打开 `frontend/src/api/client.ts`，找到 `Workspace` 接口附近（约 65 行），在 `Workspace` 之前添加：

```ts
// Minimal file entry shape returned by /files and /system/dirs.
// Kept here (not in a component file) so both FileManager and
// the new-project modal can use the same type without coupling.
export interface FileEntry {
  path_type: 'Dir' | 'File' | 'SymlinkDir' | 'SymlinkFile'
  name: string
  mtime: number
  size: number | null
}
```

- [ ] **Step 2: 添加 `api.listDirs` 方法**

在 `frontend/src/api/client.ts` 的 `api` 对象中（`System` 一节，约 102 行后），紧跟 `systemInfo` 之后添加：

```ts
  // System
  systemInfo: () => request<{ home_dir: string }>('/system/info'),
  listDirs: (path: string) =>
    request<{ files: FileEntry[] }>(`/system/dirs?path=${encodeURIComponent(path)}`),
```

- [ ] **Step 3: 验证 TypeScript 编译**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit 2>&1 | head -20
```

预期：0 错误。

- [ ] **Step 4: 验证前端 HMR 不报错**

刷新浏览器，打开 DevTools console；点击任意会话触发 FileManager 加载，console 不应出现 `Cannot find module 'FileEntry'` 或 `api.listDirs is not a function` 等错误。

- [ ] **Step 5: 提交**

```bash
cd /home/pax/coding/OmniTerm-dev
git add frontend/src/api/client.ts
git commit -m "feat: api client 新增 listDirs 方法 + FileEntry 类型导出"
```

---

### Task 5: 前端 Sidebar — Modal state 与 fetchDirs 逻辑

**文件:**
- 修改: `frontend/src/components/Sidebar/Sidebar.tsx`

这一步只加 state / handler / effect，**不**改 JSX（Task 6 才动 JSX）。

- [ ] **Step 1: 添加 import**

在 `Sidebar.tsx` 顶部 imports 块（约 1-14 行）找到 `import { IconWorkbench } from '../FileManager/icons'`，**在同一条 import 中扩展**为：

```ts
import { IconFolder, IconArrowUp, IconRefresh, IconWarning, IconWorkbench } from '../FileManager/icons'
```

然后在 `import type { Project, Workspace, Session, DuplicateGroup } from '../../api/client'` 那一行**的同 import 中扩展**为：

```ts
import type { Project, Workspace, Session, DuplicateGroup, FileEntry } from '../../api/client'
```

- [ ] **Step 2: 添加本地 `getParentPath` 副本**

**不**，直接用 `import { getParentPath } from '../../utils/path'`，加到 Sidebar.tsx 顶部 imports 块：

```ts
import { getParentPath } from '../../utils/path'
```

（注意：Task 3 已把 FileManager 改用 utils/path 的版本，但 Sidebar.tsx 也得 import。本步 import 一次即可。）

- [ ] **Step 3: 添加 browse 状态**

在 `Sidebar.tsx` 现有的 `projName` / `projPath` state 后（约 91 行后）添加：

```ts
  // Browse state for the create-project modal's embedded directory list
  const [browsePath, setBrowsePath] = useState('')
  const [browseEntries, setBrowseEntries] = useState<FileEntry[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
```

- [ ] **Step 4: 添加 `fetchDirs` 函数和 useEffect**

在 `Sidebar.tsx` 现有的 `loadDuplicates` 回调后（约 161 行后，`useEffect(() => { loadDuplicates() }, [loadDuplicates])` 之后），添加：

```ts
  // Fetch directory entries for the new-project modal's browse list.
  const fetchDirs = useCallback(async (path: string) => {
    setBrowseLoading(true)
    setBrowseError(null)
    try {
      const data = await api.listDirs(path)
      setBrowseEntries(
        data.files.filter(
          (f) => f.path_type === 'Dir' || f.path_type === 'SymlinkDir',
        ),
      )
    } catch (e: any) {
      setBrowseError(e.message || '无法访问该目录')
    } finally {
      setBrowseLoading(false)
    }
  }, [])

  // Auto-fetch when browsePath changes (covers click-dir, go-up, and type-apply)
  useEffect(() => {
    if (!browsePath) return
    fetchDirs(browsePath)
  }, [browsePath, fetchDirs])
```

- [ ] **Step 5: 添加打开 / 关闭 modal 的 effect 和 close handler**

在 `Sidebar.tsx` 现有的 `useEffect(() => { api.systemInfo()...` （约 237-244 行）**之后**添加：

```ts
  // Reset browse state when the create-project modal opens
  useEffect(() => {
    if (createProjOpen && homeDir) {
      setBrowsePath(homeDir)
      setProjPath(homeDir)
      setBrowseError(null)
    }
  }, [createProjOpen, homeDir])

  // Unified close: clear form + browse state
  const closeCreateProj = () => {
    setCreateProjOpen(false)
    setProjName('')
    setProjPath(homeDir)
    setBrowsePath('')
    setBrowseEntries([])
    setBrowseError(null)
  }
```

- [ ] **Step 6: 添加 click / goUp / path-apply 三个 handler**

在 `Sidebar.tsx` 现有的 `handleCreateProject` 之前（约 277 行前）添加：

```ts
  // Browse handlers for the new-project modal
  const handleEnterDir = (entry: FileEntry) => {
    const newPath = browsePath.endsWith('/')
      ? `${browsePath}${entry.name}`
      : `${browsePath}/${entry.name}`
    setProjPath(newPath)
    setBrowsePath(newPath)
  }

  const handleGoUp = () => {
    const parent = getParentPath(browsePath)
    if (!parent) return
    setProjPath(parent)
    setBrowsePath(parent)
  }

  const handlePathApply = () => {
    const trimmed = projPath.trim()
    if (!trimmed || trimmed === browsePath) return
    setBrowsePath(trimmed)
  }

  const handleRefresh = () => {
    if (browsePath) fetchDirs(browsePath)
  }
```

- [ ] **Step 7: 拆分 keyDown handler**

在 `Sidebar.tsx` 现有 `handleProjKeyDown`（约 405-410 行）**之前**添加 name 专用 handler：

```ts
  // Enter in name field = create project
  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreateProject()
    }
  }

  // Enter in path field = apply path (don't create)
  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handlePathApply()
    }
  }
```

**保留** `handleProjKeyDown`（仍用于 create session / rename），不动。

- [ ] **Step 8: 验证 TypeScript 编译**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit 2>&1 | head -30
```

预期：0 错误。这一步只加 logic，不动 JSX，刷新页面后行为应无变化。

- [ ] **Step 9: 提交**

```bash
cd /home/pax/coding/OmniTerm-dev
git add frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "feat: Sidebar 新项目 modal — browse state + fetchDirs + handlers（不含 UI）"
```

---

### Task 6: 前端 Sidebar — 渲染目录列表 UI

**文件:**
- 修改: `frontend/src/components/Sidebar/Sidebar.tsx:932-977` (整个 Create Project Modal JSX)

这一步把 Task 5 的 logic 接入 UI。

- [ ] **Step 1: 替换 Modal 标签的 `onClose`**

找到第 933 行：

```tsx
      <Modal open={createProjOpen} onClose={() => { setCreateProjOpen(false); setProjName(''); setProjPath(homeDir) }} title={...}>
```

改为：

```tsx
      <Modal
        open={createProjOpen}
        onClose={closeCreateProj}
        title={t('sidebar.createProject') ?? 'Create Project'}
        maxWidth="max-w-lg"
      >
```

> 关键改动：内联 `onClose` 改为 `closeCreateProj`；新增 `maxWidth="max-w-lg"`。

- [ ] **Step 2: 修改 name input 的 `onKeyDown`**

在 Create Project Modal 的 name input（`<input ... onKeyDown={handleProjKeyDown} ...`）中，把 `onKeyDown={handleProjKeyDown}` 改为：

```tsx
              onKeyDown={handleNameKeyDown}
```

- [ ] **Step 3: 修改 path input 的 `onKeyDown` 和 `onBlur`**

找到 path input（`<input ... value={projPath} onChange={...} onKeyDown={handleProjKeyDown} ...`），改为：

```tsx
            <input
              type="text"
              value={projPath}
              onChange={(e) => setProjPath(e.target.value)}
              onKeyDown={handlePathKeyDown}
              onBlur={handlePathApply}
              placeholder={homeDir}
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.2)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
```

> 注意：这里有**两个 onBlur**。第二个 `onBlur`（清 focus ring 的那个）覆盖了 `handlePathApply`！需要做以下调整：

把第二个 `onBlur` 合并为一个：

```tsx
            <input
              type="text"
              value={projPath}
              onChange={(e) => setProjPath(e.target.value)}
              onKeyDown={handlePathKeyDown}
              onBlur={(e) => {
                handlePathApply()
                e.currentTarget.style.borderColor = 'var(--border-strong)'
                e.currentTarget.style.boxShadow = 'none'
              }}
              placeholder={homeDir}
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.2)' }}
            />
```

- [ ] **Step 4: 在 path input 下添加提示文字**

紧跟 path input `</div>` 闭合后（仍是同一个外层 `<div>` 内），在 path label 的 input 后添加：

```tsx
            <div className="text-[10px] mt-1" style={{ color: 'var(--text-faint)' }}>
              {t('sidebar.pathHint') ?? '回车或失焦以应用路径'}
            </div>
```

- [ ] **Step 5: 添加浏览区域 JSX**

在 path `<div>` 块（label + input + hint）**之后**、footer `<div className="flex justify-end gap-2 pt-1">` **之前**插入：

```tsx
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                {t('sidebar.browse') ?? '浏览'}
              </label>
              <button
                onClick={handleRefresh}
                title={t('sidebar.refresh') ?? '刷新'}
                className="flex items-center gap-1 px-2 py-0.5 rounded transition-all"
                style={{
                  border: '1px solid var(--border-strong)',
                  color: 'var(--text-secondary)',
                  fontSize: 11,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent)'
                  e.currentTarget.style.color = 'var(--accent)'
                  e.currentTarget.style.background = 'var(--accent-10)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-strong)'
                  e.currentTarget.style.color = 'var(--text-secondary)'
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <IconRefresh width={10} height={10} />
                {t('sidebar.refresh') ?? '刷新'}
              </button>
            </div>
            <div
              className="overflow-y-auto"
              style={{
                height: 200,
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 5,
                padding: 4,
              }}
            >
              {/* ".." parent entry */}
              <div
                onClick={handleGoUp}
                className="flex items-center gap-2 px-2.5 py-1.5 text-xs transition-all"
                style={{
                  borderRadius: 4,
                  color: 'var(--text-faint)',
                  cursor: getParentPath(browsePath) ? 'pointer' : 'not-allowed',
                  opacity: getParentPath(browsePath) ? 1 : 0.5,
                }}
                onMouseEnter={(e) => {
                  if (!getParentPath(browsePath)) return
                  e.currentTarget.style.background = 'rgba(167,139,250,0.08)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <IconArrowUp width={14} height={14} />
                <span>..</span>
              </div>

              {/* Loading state */}
              {browseLoading && (
                <div className="flex items-center justify-center py-6 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {t('sidebar.loading') ?? '加载中…'}
                </div>
              )}

              {/* Error state */}
              {!browseLoading && browseError && (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-xs">
                  <IconWarning width={20} height={20} style={{ color: 'var(--warning)' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{browseError}</div>
                  <button
                    onClick={handleRefresh}
                    className="px-2 py-0.5 rounded transition-all"
                    style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', fontSize: 11 }}
                  >
                    {t('sidebar.retry') ?? '重试'}
                  </button>
                </div>
              )}

              {/* Empty state */}
              {!browseLoading && !browseError && browseEntries.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-1 py-6 text-xs">
                  <IconFolder width={24} height={24} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 6px rgba(167,139,250,0.4))' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{t('sidebar.emptyDir') ?? '空目录'}</div>
                </div>
              )}

              {/* Directory entries */}
              {!browseLoading && !browseError && browseEntries.map((entry) => (
                <div
                  key={entry.name}
                  onClick={() => handleEnterDir(entry)}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs transition-all"
                  style={{
                    borderRadius: 4,
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(167,139,250,0.08)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <IconFolder width={14} height={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <span className="truncate">{entry.name}</span>
                  <span className="ml-auto" style={{ color: 'var(--text-faint)', fontSize: 11 }}>{entry.size ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
```

- [ ] **Step 6: 验证 TypeScript 编译**

```bash
cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit 2>&1 | head -30
```

预期：0 错误。如果提示 `i18n key missing`（如 `t('sidebar.browse')`），先用 fallback 字符串即可，**不**为了这几个 key 改 i18n 文件（保持本次改动最小）。

- [ ] **Step 7: 启动 dev 服务并打开新建项目窗口**

```bash
cd /home/pax/coding/OmniTerm-dev && ./dev.sh status
# 如未运行则 ./dev.sh start
```

浏览器 `http://<lan-ip>:9778` → Sidebar → 点击「+」或「新建项目」。

视觉自检（对照 spec §3 和 UI 规范）：
- [ ] Modal 宽度 = 512px（比之前略宽）
- [ ] 顺序：名称 → 路径 + 提示 → 浏览（标签 + 刷新按钮）→ 目录列表 → 取消/创建
- [ ] 列表高度 200px，背景 #0a0a0f
- [ ] 目录项有 hover（淡紫）、点击进入
- [ ] 「..」在根目录禁用（`opacity: 0.5`, `cursor: not-allowed`）
- [ ] 刷新按钮在右上
- [ ] 不出现任何 emoji

- [ ] **Step 8: 提交**

```bash
cd /home/pax/coding/OmniTerm-dev
git add frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "feat: 新建项目 modal 渲染嵌入式目录浏览 UI（UI 规范合规）"
```

---

### Task 7: 端到端手动测试 + CHANGELOG

**文件:**
- 修改: `CHANGELOG.md`（如果用户已确认要 changelog 条目）

这一步是 spec §"测试计划" 的 10 个用例的执行检查清单。

- [ ] **Step 1: 启动 dev 服务**

```bash
cd /home/pax/coding/OmniTerm-dev && ./dev.sh status
# 如未运行则 ./dev.sh start
```

- [ ] **Step 2: 用例 1-5 — 浏览交互**

| 编号 | 操作 | 预期 |
|---|---|---|
| 1 | 打开「新建项目」窗口 | 路径默认 home；列表显示 home 的子目录（仅目录，无文件）|
| 2 | 点击列表中的一个目录 | 路径输入框更新为该目录；列表显示其子目录 |
| 3 | 点 `..` | 回到父目录；根目录时 `..` 禁用 |
| 4 | 在路径框打一个新路径并回车 | 列表尝试加载新路径；成功则更新；失败则提示「路径无效」+ 保留旧列表 |
| 5 | 点击「刷新」 | 强制重新拉取当前路径的子目录 |

- [ ] **Step 3: 用例 6-7 — 创建流程**

| 编号 | 操作 | 预期 |
|---|---|---|
| 6 | 创建项目：路径不存在 | 后端自动创建（沿用现状），成功 toast；新项目出现在 Sidebar |
| 7 | 创建项目：路径已被另一 project 覆盖 | 弹出 coverConflict 弹窗（沿用现状） |

- [ ] **Step 4: 用例 8-9 — 边界态**

| 编号 | 操作 | 预期 |
|---|---|---|
| 8 | 浏览一个空目录 | 显示「空目录」空状态（含 IconFolder + 提示）|
| 9 | 浏览无读权限的目录（如 `/root` 从普通用户）| 显示「无法访问」+ 重试按钮（按重试可重新拉） |

- [ ] **Step 5: 用例 10 — 主题切换**

| 编号 | 操作 | 预期 |
|---|---|---|
| 10 | 设置 → 切换深色 ↔ 浅色 | 模态框在两种主题下视觉一致；文字、图标、边框、背景都可读 |

- [ ] **Step 6: 边界补充 — Enter 键语义**

| 编号 | 操作 | 预期 |
|---|---|---|
| 11 | name 字段输入后按 Enter | 触发创建（即使 path 是别的目录）|
| 12 | path 字段输入后按 Enter | 应用路径到 browse 列表（**不**触发创建）|
| 13 | path 字段输入后失焦（点别处）| 应用路径到 browse 列表 |

- [ ] **Step 7: 视觉对照 spec mockup**

对照 `docs/superpowers/specs/2026-06-27-new-project-modal-design.md` 的「视觉结构」ASCII 截图检查：
- 名称、路径、浏览三段顺序
- 目录列表 200px 高
- 「..」在最上
- 目录项右侧显示子项数
- 取消/创建按钮在底部右侧

- [ ] **Step 8: 询问用户是否要写 CHANGELOG 条目**

按 `AGENTS.md` 约定：CHANGELOG 只写用户确认的内容。询问用户：

> 「功能已通过手动测试。要我写一条 CHANGELOG 条目吗？例如：
> `### 新增
> - 新建项目窗口：嵌入式目录浏览，点击 / 输入任一方式定位路径，UI 规范合规」

如果用户确认：
- 打开 `CHANGELOG.md`，找到最新版本段（`## [Unreleased]` 或最新 release）
- 在「新增」或对应小节添加条目
- 提交：

```bash
cd /home/pax/coding/OmniTerm-dev
git add CHANGELOG.md
git commit -m "docs: CHANGELOG 记录新建项目窗口目录浏览功能"
```

如果用户不写，跳过本步。

- [ ] **Step 9: 验收**

确认所有 checkbox 已勾选；如有失败，回到对应 Task 修复后重测。

---

## 完成标准

- [ ] Task 1: 后端 `list_dirs` 端点编译通过 + curl 200/404/400 行为正确
- [ ] Task 2: `utils/path.ts` 存在且 tsc 通过
- [ ] Task 3: FileManager 改用共享函数，原有行为不变
- [ ] Task 4: `api.listDirs` 和 `FileEntry` 类型可用
- [ ] Task 5: Sidebar 状态机 logic 完成，tsc 通过
- [ ] Task 6: 目录列表 UI 渲染完成，UI 规范合规，tsc 通过
- [ ] Task 7: 10+ 手动测试用例全部通过
- [ ] 7 次原子提交，commit message 全部为 `feat:` / `refactor:` / `docs:`
