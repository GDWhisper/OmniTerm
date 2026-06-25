# Proposal: Project → Workspace (Git Worktree) 三级架构

> **状态**: Draft  
> **日期**: 2026-06-25  
> **范围**: 后端数据模型重构 + git worktree 发现 + 前端 Sidebar 三级树

---

## 1. 问题

当前 OmniTerm 的 Workspace 概念模糊 — 它既是"一组 session 的容器"，又偶尔承载"项目路径"的语义（`root_path` 字段）。用户无法直观看到同一个 git 仓库的不同 branch/worktree 下分别有哪些 session。

实际开发场景中，开发者经常同时在多个 branch 上工作（`main`、`dev`、`feature-x`），每个 branch 对应一个 git worktree，每个 worktree 下需要独立的终端 session。当前的两级结构无法表达这种关系。

## 2. 设计目标

1. **Project = git 仓库**，持久化到 DB（用户决策）
2. **Workspace = git worktree**，实时查询不持久化（git 客观状态）
3. **Session 绑定到 worktree**，`pane_cwd` = worktree 路径
4. **非 git repo 退化**为单 workspace（= project 路径自身）
5. **Sidebar 只读展示 worktree**，创建 worktree 通过终端 git 命令

## 3. 数据模型

### 3.1 现有 schema

```sql
CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    target_id TEXT,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    name TEXT,
    tmux_session_name TEXT,
    hook_enabled BOOLEAN DEFAULT 0,
    hook_status TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
```

### 3.2 目标 schema

```sql
-- workspaces 改名为 projects
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    target_id TEXT,
    name TEXT NOT NULL,           -- 用户可编辑的显示名
    path TEXT NOT NULL,           -- git repo 路径（原 root_path）
    created_at TEXT NOT NULL,
    FOREIGN KEY(target_id) REFERENCES targets(id) ON DELETE SET NULL
);

-- sessions 关联到 project + workspace(worktree) 路径
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,          -- 原 workspace_id
    workspace_path TEXT NOT NULL,      -- worktree 绝对路径（新增）
    name TEXT,
    tmux_session_name TEXT,
    hook_enabled BOOLEAN DEFAULT 0,
    hook_status TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

### 3.3 Workspace（运行时对象，不存 DB）

```rust
#[derive(Debug, Serialize)]
pub struct Workspace {
    pub id: String,           // SHA1(project_id:path)[..12]，确定性
    pub project_id: String,
    pub path: String,         // worktree 绝对路径
    pub label: String,        // 分支名 或 "detached" 或 目录名
    pub branch: Option<String>,
    pub is_main: bool,        // path == project.path
    pub is_git_repo: bool,
    pub is_git_worktree: bool,
}
```

### 3.4 ID 生成策略

Workspace ID 不自增，用确定性哈希：

```rust
fn workspace_id(project_id: &str, path: &str) -> String {
    let hash = sha1(format!("{}:{}", project_id, path));
    hash[..12].to_string()
}
```

相同 project + 相同 path = 相同 ID，无需 upsert。

## 4. 后端变更

### 4.1 新增：git worktree 发现模块

**文件**: `src/git/mod.rs`

```rust
pub struct WorktreeInfo {
    pub path: String,
    pub branch: Option<String>,
    pub bare: bool,
    pub detached: bool,
}

pub async fn is_git_repo(path: &str) -> bool {
    // git -C {path} rev-parse --is-inside-work-tree
}

pub async fn discover_worktrees(path: &str) -> anyhow::Result<Vec<WorktreeInfo>> {
    // git -C {path} worktree list --porcelain
    // 解析输出，返回 WorktreeInfo 列表
}
```

### 4.2 新增：Workspace 构建逻辑

**文件**: `src/git/mod.rs`（或 `src/workspaces.rs`）

```rust
pub async fn list_workspaces(project: &Project) -> Vec<Workspace> {
    if !is_git_repo(&project.path).await {
        return vec![single_workspace(project, false)];
    }
    let worktrees = discover_worktrees(&project.path).await.unwrap_or_default();
    if worktrees.is_empty() {
        return vec![single_workspace(project, true)];
    }
    worktrees.into_iter().map(|w| Workspace {
        id: workspace_id(&project.id, &w.path),
        project_id: project.id.clone(),
        path: w.path.clone(),
        label: w.branch.clone().unwrap_or_else(|| {
            if w.detached { "detached".into() }
            else { Path::new(&w.path).file_name().unwrap().to_string() }
        }),
        branch: w.branch,
        is_main: w.path == project.path,
        is_git_repo: true,
        is_git_worktree: true,
    }).collect()
}
```

### 4.3 API 变更

| 现有端点 | 变更 |
|---------|------|
| `GET /workspaces` | → `GET /projects` |
| `POST /workspaces` | → `POST /projects`（path 必填，验证是 git repo 或普通目录） |
| `PATCH /workspaces/{id}` | → `PATCH /projects/{id}` |
| `DELETE /workspaces/{id}` | → `DELETE /projects/{id}` |
| `GET /workspaces/{wid}/sessions` | → `GET /projects/{pid}/sessions` |
| `POST /workspaces/{wid}/sessions` | → `POST /projects/{pid}/sessions`（新增 `workspace_path` 参数） |

**新增端点**:

| 端点 | 说明 |
|------|------|
| `GET /projects/{pid}/worktrees` | 实时查询该项目的所有 git worktree |

### 4.4 Session 创建流程变更

```
现有：
  POST /workspaces/{wid}/sessions
  → workspace.root_path 作为 tmux cwd

提案：
  POST /projects/{pid}/sessions
  → body: { name?, workspace_path }  ← 前端传入选中的 worktree 路径
  → tmux new-session -c {workspace_path}
  → INSERT INTO sessions (project_id, workspace_path, ...)
```

## 5. 前端变更

### 5.1 Sidebar 三级树

```
┌──────────────────────────────────┐
│  Projects                        │
│  ├─ 📁 OmniTerm          [▼]    │  ← Project（可展开/折叠）
│  │  ├─ 🌿 main                  │  ← Workspace（只读，显示分支名）
│  │  │  ├─ ● cargo run           │  ← Session（可切换/创建/删除）
│  │  │  └─ ● vim                 │
│  │  ├─ 🌿 dev                   │
│  │  │  └─ ● cargo watch         │
│  │  └─ 🌿 feature-x            │
│  │     └─ (empty)               │
│  ├─ 📁 AnotherRepo       [▼]    │
│  │  └─ 🌿 main                  │
│  │     └─ ● session 1           │
│  └─ [+ Add Project]             │
└──────────────────────────────────┘
```

**交互规则**：
- 点击 Project → 展开/折叠，加载 worktrees
- 点击 Workspace → 高亮，显示该 worktree 下的 sessions
- 点击 Session → 激活终端
- "Add Project" → 输入 git repo 路径（原 "Add Workspace" 对话框改造）
- Session "+" → 在当前选中的 worktree 下创建 session
- Workspace 层无创建/删除按钮（通过终端 git 命令管理）

### 5.2 状态管理（appStore）

```typescript
// 现有
interface AppState {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  sessions: Session[]
  activeSessionId: string | null
}

// 提案
interface AppState {
  projects: Project[]                              // 持久化
  activeProjectId: string | null
  worktrees: Record<string, Workspace[]>           // 实时，按 project 分组
  activeWorkspaceId: string | null                 // 当前选中的 worktree
  sessions: Session[]
  activeSessionId: string | null
}
```

### 5.3 文件管理器

文件管理器的根目录跟随当前 session 的 `workspace_path`：

```
现在: 全局 / 或 workspace root_path
提案: 当前 session 绑定的 worktree 路径
```

切换 session 时自动切换文件管理器的根目录。

## 6. 迁移策略

### 6.1 数据库迁移

```sql
-- Step 1: 重命名 workspaces → projects
ALTER TABLE workspaces RENAME TO projects;

-- Step 2: 重命名 root_path → path
ALTER TABLE projects RENAME COLUMN root_path TO path;

-- Step 3: sessions 添加 workspace_path 列
ALTER TABLE sessions ADD COLUMN workspace_path TEXT NOT NULL DEFAULT '';

-- Step 4: 填充 workspace_path（从 project 的 path）
UPDATE sessions SET workspace_path = (
    SELECT path FROM projects WHERE projects.id = sessions.workspace_id
) WHERE workspace_path = '';

-- Step 5: 重命名 workspace_id → project_id
-- SQLite 不支持 RENAME COLUMN（< 3.25），需要重建表
-- 方案：新建 sessions 表，迁移数据，删旧表
```

### 6.2 代码迁移

1. 后端：`models/workspace.rs` → `models/project.rs`（改名 + 调整字段）
2. 后端：`api/workspaces.rs` → `api/projects.rs`（路由改名 + 新增 worktrees 端点）
3. 后端：`api/sessions.rs`（FK 从 workspace_id 改为 project_id + workspace_path）
4. 前端：`api/client.ts`（端点路径更新）
5. 前端：`stores/appStore.ts`（状态结构更新）
6. 前端：`Sidebar.tsx`（三级树重构）

### 6.3 兼容性

- 迁移后所有现有 session 的 `workspace_path` = 原 workspace 的 `root_path`
- 现有 session 继续正常工作，tmux session 不受影响
- 用户需要重新创建 project（原 workspace 的 path 复用即可）

## 7. 依赖

| 依赖 | 用途 | 是否新增 |
|------|------|---------|
| `sha1` | workspace ID 生成 | 新增（或用现有 `uuid` 的变体） |
| `tokio::process::Command` | 执行 git 命令 | 已有 |

不需要引入 git2 库 — 纯 CLI 调用 `git worktree list --porcelain` 足够。

## 8. 风险与开放问题

### 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| git worktree list 性能 | 大型 monorepo 可能慢 | 加缓存（TTL 5s），或只在 sidebar 展开时查询 |
| 路径变化 | worktree 被移动后 session 失效 | 启动时校验路径是否存在，不存在则标记异常 |
| 非 git repo 用户 | 退化为单 workspace 体验退化 | 保持退化路径，体验等同于现在 |

### 开放问题

1. **Project 创建时是否验证 git repo？** — 建议：非 git repo 允许创建，退化为单 workspace
2. **worktree 缓存策略？** — 建议：不缓存，每次 sidebar 展开时实时查询（pi-web 做法）
3. **tmux session 命名是否包含 project/branch 信息？** — 建议：保持现有 `lt_{uuid}` 命名，不引入复杂度
4. **文件管理器是否需要感知 worktree 切换？** — 是，切换 session 时自动更新文件管理器根目录

## 9. 参考

- pi-web 实现：`coding/research/pi-web/src/server/workspaces/`
  - `gitWorktreeDiscovery.ts` — git worktree 发现
  - `workspaceService.ts` — workspace 构建逻辑
  - `workspaceContext.ts` — 解析链
