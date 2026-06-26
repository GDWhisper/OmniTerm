## 1. 数据库迁移

- [x] 1.1 创建迁移脚本：workspaces → projects 改名，root_path → path，sessions 新增 workspace_path 列，workspace_id → project_id

## 2. 后端：数据模型

- [x] 2.1 新增 `src/models/project.rs`（Project, CreateProject, UpdateProject）
- [x] 2.2 修改 `src/models/session.rs`（workspace_id → project_id，新增 workspace_path）
- [x] 2.3 删除 `src/models/workspace.rs`，更新 `src/models/mod.rs`

## 3. 后端：Git Worktree 发现

- [x] 3.1 新增 `src/git/mod.rs`：is_git_repo(), discover_worktrees(), WorktreeInfo
- [x] 3.2 新增 `src/workspaces.rs`：list_workspaces(), Workspace 运行时对象, workspace_id()

## 4. 后端：API 路由

- [x] 4.1 `src/api/workspaces.rs` → `src/api/projects.rs`：改名 + 新增 GET /projects/{pid}/worktrees
- [x] 4.2 修改 `src/api/sessions.rs`：路由从 /workspaces/{wid}/sessions 改为 /projects/{pid}/sessions，create_session 接收 workspace_path 参数
- [x] 4.3 更新 `src/api/mod.rs`：路由注册

## 5. 前端：API 客户端

- [x] 5.1 更新 `frontend/src/api/client.ts`：端点路径 + 类型定义

## 6. 前端：状态管理

- [x] 6.1 更新 `frontend/src/stores/appStore.ts`：projects/worktrees/activeWorkspaceId 状态

## 7. 前端：Sidebar 三级树

- [x] 7.1 重构 `Sidebar.tsx`：Project → Workspace(worktree) → Session 三级展示
- [x] 7.2 "Add Project" 对话框：输入 git repo 路径

## 8. 前端：文件管理器联动

- [x] 8.1 文件管理器根目录跟随当前 session 的 workspace_path（已由 session CWD 机制自动处理）

## 9. 清理与验证

- [x] 9.1 清理旧 workspace 相关引用，确保编译通过（cargo check + tsc --noEmit 均通过）
- [ ] 9.2 端到端验证：创建 project → 展开 worktree → 创建 session → 终端 cwd 正确
