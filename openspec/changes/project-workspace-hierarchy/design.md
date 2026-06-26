## Context

当前数据模型：`workspaces` → `sessions`（两级）。workspace 有 `root_path` 字段但语义不明确。session 通过 `workspace_id` FK 关联到 workspace，tmux session 的 cwd 取自 workspace 的 `root_path`。

目标：Project（git repo，持久化）→ Workspace（git worktree，实时发现）→ Session（tmux session）。

参考实现：pi-web（`coding/research/pi-web/src/server/workspaces/`）已验证此模式可行。

## Goals / Non-Goals

**Goals:**
- Project 持久化到 DB，worktree 实时查询不持久化
- Sidebar 只展示 worktree，不提供创建功能（创建用终端 git 命令）
- Session 绑定到 worktree，pane_cwd = worktree 路径
- 非 git repo 退化为单 workspace
- 确定性 workspace ID（SHA1 hash）

**Non-Goals:**
- 不引入 git2 库，纯 CLI 调用
- 不支持远程 git 仓库（只支持本地路径）
- 不在 UI 中提供 worktree 创建/删除功能
- 不改变 tmux session 命名策略（保持 `lt_{uuid}`）

## Decisions

### D1: Worktree 实时发现 vs 持久化

**选择**：实时查询，不存 DB。

**理由**：git worktree 状态随时在变（用户在终端里 git worktree add/remove），持久化会过时。pi-web 验证了此方案可行。

### D2: Session 绑定方式

**选择**：session 存 `workspace_path`（worktree 绝对路径），不用 hash ID。

**理由**：路径更直觉，OmniTerm 是单机应用，路径不会变。

### D3: Workspace ID 生成

**选择**：`SHA1(project_id:path)[..12]`，确定性哈希。

**理由**：相同 project + 相同 path = 相同 ID，无需 upsert，前端可以安全引用。

### D4: 非 git repo 退化

**选择**：退化为单 workspace（label = project name，path = project path，isGitRepo = false）。

**理由**：保持向后兼容，不是所有 project 都有 git。

### D5: API 路由改名

**选择**：`/workspaces/*` → `/projects/*`，新增 `GET /projects/{pid}/worktrees`。

**理由**：语义更清晰，worktrees 端点返回实时数据。

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  后端                                                       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Project API  │    │ Worktree     │    │ Session API  │  │
│  │ (CRUD)       │    │ Discovery    │    │ (CRUD)       │  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘  │
│         │                   │                   │          │
│         ▼                   ▼                   ▼          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ SQLite       │    │ git CLI      │    │ tmux CLI     │  │
│  │ projects     │    │ worktree list│    │ new-session  │  │
│  │ sessions     │    │              │    │ kill-session │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  前端                                                       │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Sidebar                                              │  │
│  │ ├─ Project (expand/collapse)                         │  │
│  │ │  ├─ Workspace (worktree, 只读)                     │  │
│  │ │  │  ├─ Session (可操作)                            │  │
│  │ │  │  └─ Session                                     │  │
│  │ │  └─ Workspace                                      │  │
│  │ └─ [+ Add Project]                                   │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐                        │
│  │ Terminal     │  │ FileManager  │                        │
│  │ (xterm.js)   │  │ (跟随 worktree path)                 │
│  └──────────────┘  └──────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```
