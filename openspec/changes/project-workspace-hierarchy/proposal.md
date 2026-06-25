## Why

当前 Workspace 概念模糊 — 既是"session 容器"又偶尔承载"项目路径"语义。用户无法直观看到同一 git 仓库不同 branch/worktree 下分别有哪些 session。实际开发中经常同时在多个 branch 上工作，需要独立的终端 session，当前两级结构无法表达这种关系。

## What Changes

- 将 `workspaces` 表重命名为 `projects`，语义明确为 git 仓库
- 新增 git worktree 发现模块，实时查询 project 下的所有 worktree
- Sidebar 从两级（Workspace → Session）变为三级（Project → Workspace → Session）
- Session 绑定到 worktree 路径，`pane_cwd` = worktree 路径
- 非 git repo 退化为单 workspace（= project 路径自身）
- 文件管理器根目录跟随当前 session 的 worktree 路径

## Capabilities

### New Capabilities
- `project-workspace-hierarchy`: Project（git repo）→ Workspace（worktree）→ Session 三级架构

### Modified Capabilities
- 现有 workspace/session CRUD API 改名并调整语义

## Impact

- `src/models/workspace.rs` → `src/models/project.rs`
- `src/api/workspaces.rs` → `src/api/projects.rs`
- `src/api/sessions.rs` — FK 变更 + workspace_path
- 新增 `src/git/mod.rs` — worktree 发现
- `frontend/src/stores/appStore.ts` — 状态结构重构
- `frontend/src/components/Sidebar/Sidebar.tsx` — 三级树
- `frontend/src/api/client.ts` — 端点路径更新
- `migrations/` — 新增迁移脚本
