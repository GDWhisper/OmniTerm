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
3. **用 CodeGraph 查源码**：先 `codegraph sync` 确认索引最新，再用 `codegraph_explore` / `codegraph_node`。配置文件、文档、非索引文件才用 Read/Grep

## 工程准则

1. **长期主义** — 代码将长期留存并被他人接手。禁止为快速完成当前任务而牺牲可维护性或制造新技术债。
2. **严守分层** — 遵循项目分层架构（Controller/Service/Repository），严禁越权调用。不盲从历史遗留代码（超长函数、硬编码、全局状态），新代码必须高内聚低耦合。
3. **局部改善** — 修改某文件时，顺手清理当前修改区域内的重复代码或硬编码。禁止扩大到不相关范围。
4. **缺陷修复** — 追溯根因而非掩盖症状（禁止仅用 try-catch 吞异常或 if-else 绕过）。修复后评估对依赖模块的副作用，确保方案普适。
5. **技术债红线**（严禁）：
   - 禁 Copy-Paste 代码（须提取公共函数）
   - 禁魔法数字/硬编码（须提取至常量/配置）
   - 禁留存无用死代码
6. **自主执行与沟通边界**
   - **先规划后编码**：接收任务后，须先理清实现思路（可简述方案），确认无架构冲突后再编写代码。
   - **常规任务自主推进**：对于**明确**的 Bug 修复、局部重构、遵循现有模式的常规开发，无需反复人类请示确认，直接实施。
   - **仅在以下高风险或方向模糊情况停止编码并请示**：
     1. 必须破坏现有分层架构或修改核心基础类才能完成任务。
     2. 需引入新的外部依赖或重大框架升级。
     3. 存在多种实现方案，且各方案在性能/可维护性上有明显取舍，你无法确定最优解。
   - **请示时汇报**：1. 结构阻碍/方案分歧；2. 你的倾向性建议；3. 影响范围。

## 配置统一管理

**分支专属变量（端口/域名/版本/binary 名等）必须通过 `.env.local` 统一管理，不得硬编码到代码里。**

### `.env.local` 可用变量

| 变量 | 含义 | 消费者 |
|------|------|--------|
| `BACKEND_PORT` | dev.sh 启动的后端 HTTP 端口 | Rust `Args.port` (clap env) / Vite proxy |
| `FRONTEND_PORT` | dev.sh 启动的前端 HTTP 端口 | Vite `server.port` |
| `DOCKER_PORT` | Docker 容器内监听端口 | Dockerfile `ARG` / docker-compose `BIND_ADDR` |
| `DOCKER_PORT_MAPPING` | Docker 端口映射 `host:container` | docker-compose `ports` |
| `BRANCH_NAME` | 当前 worktree 分支名 | Rust 启动日志 |
| `BRANCH_BINARY_NAME` | 二进制名（`omniterm-main` / `omniterm-dev`） | Dockerfile `CMD` / 日志 |
| `BRANCH_VERSION` | 版本号 | Vite `define` → `import.meta.env.VITE_APP_VERSION` / Rust 启动日志 |
| `DOMAIN` | 部署域名 | Vite `allowedHosts` |

### 硬性规则

- ❌ **禁止在代码里硬编码**端口/域名/版本/binary 名（`src/main.rs` `default_value`、Vite `allowedHosts`、Dockerfile `EXPOSE`、docker-compose `ports` 等）
- ✅ 改这些值时**只改 `.env.local`**（各 worktree 独立）
- ✅ dev.sh 已 `source .env.local` 并 export 全部变量；Dockerfile 用 `ARG` + 默认值；docker-compose 用 `env_file` 引入
- ⚠️ **例外**：`Cargo.toml` 的 `[package] name` 和 `[[bin]] name` 仍手动维护（cargo 不读 env）— 改 `BRANCH_BINARY_NAME` 时**同时改** `Cargo.toml`

### 首次初始化新 worktree

```bash
# 1. cp 模板（保留注释）
cp branch.config.example .env.local  # 如果有模板文件
# 2. 改值（参考其他 worktree）
# 3. ./dev.sh start 验证
```

`branch.config.example` 缺失时直接编辑 `.env.local`（参考 `docs/branch-workflows.md` 表）。

## 文档索引

> **强制执行**：接收任务后、编码前，必须先扫描此表，将任务与「触发条件」列逐一比对，**命中即读**。读完全部命中文档后再动手。跳过此步骤导致遗漏架构约束、工作流规则或已有踩坑记录，属违规。

| 文档 | 何时读取（触发条件） | 何时维护（写回触发） |
|------|---------------------|---------------------|
| `docs/architecture-backend.md` | 修改 Rust 后端（API 路由、中间件、数据库模型、tmux/fs 模块） | 新增 API 端点、模块拆分/合并、变更 CLI 参数或环境变量 |
| `docs/architecture-frontend.md` | 修改 React 前端（组件、store、hook、路由、依赖升级） | 新增组件/store/hook、目录结构变化、关键依赖版本变更 |
| `docs/frontend-patterns.md` | 决定组件是否要拆出 data.ts、复用已有前端模式时 | 新增前端模式 entry、记录已有约定 |
| `docs/agent-edit-manual.md` | 接具体修改任务（加命令/改配置/修 bug/加翻译）时，搜目标组件列文件 | 新增「有特殊维护约定的组件」entry、记录修改路径 |
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
