# OmniTerm

Web-based tmux terminal manager. Three-panel layout: Sidebar | Terminal | FileManager.
Rust (Axum) backend + React (Vite + TypeScript) frontend. MIT licensed.

> 进度里程碑见 `PROGRESS.md`

## Quick Start

```bash
./dev.sh start|stop|status|logs
```

## 核心规则

1. **每次改动后提交**：功能/修复用 `feat:` / `fix:`，文档/配置用 `docs:` / `chore:`
2. **CHANGELOG 只写用户确认过的内容**
3. **用 CodeGraph 查源码**（`codegraph_explore` / `codegraph_node`），配置文件/文档才用 Read/Grep

## 文档索引

| 你要做的事 | 先读这个 |
|------------|----------|
| 改后端代码 | `docs/architecture-backend.md` |
| 改前端代码 | `docs/architecture-frontend.md` |
| 分支/merge/release 操作 | `docs/branch-workflows.md` |
| 环境搭建 / Git worktree 配置 | `docs/worktree-setup.md` |
| 发布正式版本 | `docs/release-plan.md` |
| 改 UI 样式或组件 | `docs/ui-style-guide.md`（必读） |
| 功能回归测试 | `docs/user-testing.md` |
| 排查类似 bug | `docs/debug-log.md` |
| 规划新功能 | `docs/requirements.md` |
| 查看参考实现 | `docs/references.md` |
| 了解项目进展 | `PROGRESS.md` |

## 脚本速查

| 脚本 | 用途 |
|------|------|
| `dev.sh` | 一键启停（所有 worktree 通用） |
| `scripts/bump-version.sh` | 同步版本号：`./scripts/bump-version.sh 0.2.0` |
