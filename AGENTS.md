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

| 文档 | 何时读取（触发条件） | 何时维护（写回触发） |
|------|---------------------|---------------------|
| `docs/architecture-backend.md` | 修改 Rust 后端（API 路由、中间件、数据库模型、tmux/fs 模块） | 新增 API 端点、模块拆分/合并、变更 CLI 参数或环境变量 |
| `docs/architecture-frontend.md` | 修改 React 前端（组件、store、hook、路由、依赖升级） | 新增组件/store/hook、目录结构变化、关键依赖版本变更 |
| `docs/branch-workflows.md` | 执行 git 分支操作（merge、rebase、cherry-pick）、操作多 worktree | 分支策略变更、新增分支类型、安全守则调整 |
| `docs/worktree-setup.md` | 初始化开发环境、添加新 worktree、配置 remote、执行 release 排除脚本 | worktree 目录/用途变更、remote 地址变更、排除文件列表调整 |
| `docs/release-plan.md` | 发布正式版本（打 tag、推送 CI、多平台构建） | 发布流程变更、CI 配置调整 |
| `docs/ui-style-guide.md` | 任何涉及 UI 的修改（组件样式、布局、色板、字体、动效）— **必读** | 新增通用组件规范、调整设计语言（色板/圆角/间距） |
| `docs/user-testing.md` | 功能开发完成后的手动回归测试 | 新增测试用例、发现并记录已知限制 |
| `docs/debug-log.md` | 遇到 bug 先查是否有类似记录 | 新踩坑后追加（问题 → 根因 → 解决方案） |
| `docs/requirements.md` | 规划新功能、确认待办优先级 | 新增/变更功能需求、标记需求完成 |
| `docs/references.md` | 需要查看外部参考实现或 License 合规规则 | 新增参考仓库、License 规则变更 |
| `PROGRESS.md` | 了解项目整体进展、架构决策背景 | 完成一个完整阶段（如 Phase N）后更新里程碑 |
| `CHANGELOG.md` | 查看面向用户的版本变更历史 | 每次用户确认的新功能/修复后**必须添加条目** |
| `dev.sh` | 启动/停止开发环境（`./dev.sh start\|stop\|status\|logs`） | 端口配置变更、启动逻辑调整 |
| `scripts/bump-version.sh` | 准备发布时同步版本号：`./scripts/bump-version.sh 0.2.0` | 版本号文件路径变更 |
