# OmniTerm

Web-based tmux terminal manager. Three-panel layout: Sidebar | Terminal | FileManager.
Rust (Axum) backend + React (Vite + TypeScript) frontend. MIT licensed.

> 进度里程碑见 `PROGRESS.md`

## Development Conventions

1. **开发/debug 后必须提交 git** — 每完成一个功能点或修复一个 bug 后，立即 `git commit`
2. **CHANGELOG 只写用户确认的内容** — 只有经过用户确认的新功能和修复才写入 `CHANGELOG.md`
3. **提交前缀规范**：
   - 功能/修复：`feat:` / `fix:`
   - 开发文档/配置：`docs:` / `chore:` — 合入 release 时会被过滤

---

## 各分支工作流

### debug 分支

1. **拉取最新 dev**：`cd ~/coding/OmniTerm-debug && git merge dev`
2. **原子化提交**：核心修复 → `fix:`，本地定制 → `chore: 本地调试配置` 单独提交
3. **只做修复，不加功能**
4. **独立验证**：在 debug 专属端口（19777/19778）启动服务测试
5. **合入 dev**：切换到 `~/coding/OmniTerm-dev` 执行 `git merge debug`

### dev 分支

- 在 `~/coding/OmniTerm-dev` 中开发、提交
- 开发文档/配置用 `docs:` 或 `chore:` 前缀
- 定期合并 `debug` 的修复

### main 分支（发布前哨站）

- **作用**：以用户视角体验即将发布的新版本，冻结后不再加功能
- **启动**：`cd ~/coding/OmniTerm && ./dev.sh start`（后端 9075 + 前端 9076）
- **文档**：保留 AGENTS.md、dev.sh、docs/ 等开发文件
- **排除**：main 不含 npm/、install.sh、.github/workflows/release.yml（这些是 release 专属）

### release 分支

- **作用**：干净的公开代码，剔除所有开发文件
- **发布**：tag push → CI 自动构建多平台 binary + GitHub Release + npm + Docker
- 详见 `docs/release-plan.md`（dev 分支）

---

## 脚本与文档索引

| 路径 | 用途 | 何时使用 |
|------|------|----------|
| `dev.sh` | **一键启动**（`start\|stop\|restart\|status\|logs`） | 在任何工作树中启动开发环境 |
| `scripts/bump-version.sh` | 同步更新 Cargo.toml + version.ts 版本号 | 准备发布时：`./scripts/bump-version.sh 0.2.0` |
| `docs/release-plan.md` | 正式发布计划与操作步骤（在 dev 分支） | 进行发布操作时查阅 |
| `docs/ui-style-guide.md` | UI 风格规范：色板、字体、圆角、组件自检清单 | 任何 UI 修改必先读 |
| `docs/user-testing.md` | 27 个测试用例（P0/P1/P2），已知限制 | 改完功能后手动回归 |
| `docs/debug-log.md` | bug 修复踩坑记录 | 遇到类似问题时查阅；新踩坑后追加 |
| `docs/requirements.md` | 产品功能需求和待办事项 | 规划新功能时查阅 |
| `CHANGELOG.md` | 面向用户的变更日志（Keep a Changelog 格式） | 每次有意义的变更后添加条目 |
| `PROGRESS.md` | 开发里程碑与架构决策 | 了解项目整体进展 |

---

## 多 Agent 协作安全守则

- **撤销已推送提交**：必须用 `git revert`，严禁 `git reset --hard` 或 `--force`
- **禁止**从 debug/dev 直接 `git push origin debug:dev` 覆盖其他分支
- **冲突处理**：发生在哪个工作树，就在哪个工作树解决

---

## Quick Start

```bash
# 所有分支通用：./dev.sh 自动读取 .env.local 端口配置
./dev.sh start    # 后端 + 前端
./dev.sh stop     # 停止所有
./dev.sh status   # 查看状态
./dev.sh logs     # 实时日志

# 手动启动
cd ~/coding/OmniTerm    # 或 OmniTerm-dev / OmniTerm-debug
. "$HOME/.cargo/env"
cargo run               # 后端
cd frontend && pnpm dev  # 前端（开发模式）
```

---

## Git Worktree

**文件约定**：`CLAUDE.md` 是 `AGENTS.md` 的符号链接（`CLAUDE.md → AGENTS.md`），两个名称指向同一份规范文件，实文件为 `AGENTS.md`。

三个 worktree 共享 `.git` 对象，各自独立工作：

| 目录 | 默认分支 | 用途 |
|------|----------|------|
| `~/coding/OmniTerm` | `main` | 发布前哨站（可 checkout release 进行发布操作） |
| `~/coding/OmniTerm-dev` | `dev` | 日常开发 |
| `~/coding/OmniTerm-debug` | `debug` | 紧急修复 |

### 远程仓库

- **私有仓**（`origin`）：存放所有分支（main/dev/debug/release）
- **公开仓**（`public`）：只推送 `release` 分支，用于对外发布

### 远程仓库策略

- **私有仓**（`origin`）：存放所有分支（main/dev/debug），完整开发历史
- **公开仓**（`public`）：只推送 `release` 分支（干净代码），用于对外发布

```bash
git remote add origin git@github.com:yourname/OmniTerm-private.git
git remote add public git@github.com:yourname/OmniTerm.git
```

### Release 分支发布流程

```bash
cd ~/coding/OmniTerm          # main worktree
git checkout release
git merge main --no-commit     # 合并 main 最新代码

# 排除开发相关文件
git reset HEAD \
  CLAUDE.md AGENTS.md Agent \
  .pi/ .qoder/ .codegraph/ \
  openspec/ \
  docs/superpowers/ docs/proposal-* docs/requirements.md \
  .dev/ omniterm.db.bak \
  dev.sh PROGRESS.md CHANGELOG.md
git checkout -- \
  CLAUDE.md AGENTS.md Agent \
  .pi/ .qoder/ .codegraph/ \
  openspec/ \
  docs/superpowers/ docs/proposal-* docs/requirements.md \
  .dev/ omniterm.db.bak \
  dev.sh PROGRESS.md CHANGELOG.md

git commit -m "release: v1.x.x"
git push public release:main   # 推送到公开仓
```

## CodeGraph

本项目已索引（`.codegraph/` 存在），优先使用 CodeGraph 工具：

| 场景 | 工具 | 替代 |
|------|------|------|
| 理解代码、追踪流程 | `codegraph_explore` | — |
| 读取文件或查看符号 | `codegraph_node` | 替代 Read |
| 搜索符号 | `codegraph_search` | 替代 Grep |
| 查找调用点 | `codegraph_callers` | — |

使用前先 `codegraph sync` 确认索引最新。只有 CodeGraph 无法覆盖时（配置文件、文档、非索引文件），才用 Read/Grep。

---

## Backend Architecture (`src/`)

```
src/
├── main.rs              # Entry: Axum + clap CLI args, SQLite pool, migrations, embedded static serving
├── embedded.rs           # rust-embed: frontend dist/ compiled into binary
├── api/
│   ├── mod.rs            # Route registration, state wiring
│   ├── health.rs         # GET /api/v1/health
│   ├── auth.rs           # POST /api/v1/auth/setup|login|logout, GET /auth/check
│   ├── targets.rs        # CRUD /api/v1/targets
│   ├── projects.rs       # CRUD /api/v1/projects
│   ├── sessions.rs       # CRUD /api/v1/sessions (auto-creates tmux session)
│   ├── hooks.rs          # GET /sessions/{id}/hook-status, POST hook-enable|hook-disable
│   ├── files.rs          # /api/v1/files — list/upload/download/read/write/mkdir/delete/rename/move/copy/search
│   └── files_watch.rs    # File watcher: SSE endpoint for live directory updates
├── auth/mod.rs           # JWT token creation/verification, RequireAuth extractor
├── models/               # SQLx-derived structs: User, Project, Session
├── tmux/
│   ├── mod.rs            # tmux command wrappers: new_session, kill_session, capture_pane, pane_cwd
│   └── hooks.rs          # Agent state scanner: scan_agent_state()
├── fs/mod.rs             # File ops: sanitize_path, list_dir, read_file, write_file, delete, rename, move, copy, search
├── git/mod.rs            # Git worktree discovery
├── ws/
│   ├── mod.rs
│   └── terminal.rs       # WebSocket terminal bridge: PTY ↔ WS binary frames, JSON control
├── utils/path.rs         # Path security: sanitize_path
└── workspaces.rs         # Workspace operations
```

### API Endpoints

```
GET  /api/v1/health
POST /api/v1/auth/setup|login|logout
GET  /api/v1/auth/check
GET  /api/v1/projects
POST /api/v1/projects
DELETE /api/v1/projects/{id}
GET  /api/v1/projects/{pid}/worktrees (git worktree discovery)
GET  /api/v1/projects/{pid}/sessions
POST /api/v1/projects/{pid}/sessions
PATCH/DELETE /api/v1/sessions/{id}
GET  /api/v1/sessions/{id}/hook-status
POST /api/v1/sessions/{id}/hook-enable|hook-disable
GET  /api/v1/files (list)
POST /api/v1/files (upload multipart)
DELETE /api/v1/files
GET  /api/v1/files/download|read|search
POST /api/v1/files/write|mkdir|rename|move|copy
WS   /api/v1/ws/terminal/{session_id}
GET  /api/v1/files/watch (SSE)
```

### CLI Reference

```
omniterm [OPTIONS]

Options:
  -p, --port <PORT>              监听端口 (默认: 9075 [main], 9777 [dev], 9077 [release])
      --db <DB>                  数据库连接 [env: DATABASE_URL]
      --jwt-secret <KEY>         JWT 签名密钥 [env: JWT_SECRET]
  -V, --version                  版本号
  -h, --help                     帮助
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `sqlite:omniterm.db?mode=rwc` | SQLite connection string |
| `JWT_SECRET` | `omniterm-default-secret-change-me` | JWT signing secret |
| `BIND_ADDR` | `127.0.0.1:<port>` | Listen address (legacy, prefer --port) |
| `OMNITERM_PORT` | 9075 (main) / 9077 (release) | CLI --port override via env |
| `FRONTEND_DIR` | `frontend/dist` | Static files dir; falls back to embedded |

---

## Frontend Architecture (`frontend/src/`)

```
src/
├── main.tsx, App.tsx, index.css
├── version.ts           # Single source of truth for version
├── i18n.ts              # i18n configuration
├── api/client.ts        # Typed fetch wrapper for all API endpoints
├── stores/
│   ├── appStore.ts      # Zustand: layout, projects, sessions, font size, mobile detection
│   ├── themeStore.ts    # Zustand: light/dark/system theme + .dark class on <html>
│   └── toastStore.ts    # Zustand: toast notifications (auto-dismiss)
├── hooks/
│   ├── useTerminal.ts   # xterm.js + WebSocket + IME composition + live font size
│   ├── useMediaQuery.ts # Mobile breakpoint detection
│   └── useFileWatcher.ts # SSE file watcher for live directory updates
├── locales/
│   ├── en/translation.json
│   └── zh/translation.json
└── components/
    ├── Layout/  — Layout.tsx, MobileNav.tsx
    ├── Sidebar/ — Sidebar.tsx
    ├── Terminal/ — Terminal.tsx
    ├── FileManager/ — FileManager.tsx, FileDrawer.tsx, FileEditor.tsx, FilePreview.tsx, icons.tsx
    ├── Settings/ — Settings.tsx, SettingsPopup.tsx
    ├── Icons/ — GitBranchIcon.tsx, KeyboardIcon.tsx
    ├── Modal/ — Modal.tsx, ConfirmDialog.tsx
    └── Toast/ — Toast.tsx
```

### Key Frontend Dependencies

- `react` 19 / `vite` 8 / `tailwindcss` 4
- `zustand` 5 (state management)
- `@xterm/xterm` 6 + `@xterm/addon-fit` + `@xterm/addon-web-links`
- Vite proxy: `/api` → backend port (varies by branch .env.local)

---

## Documentation (`docs/`)

| File | Purpose | When to consult | When to maintain |
|---|---|---|---|
| `docs/ui-style-guide.md` | **UI 风格规范** — 色板、字体、圆角、动效、drag bar 语言、组件规范、新增组件自检清单 | 任何涉及 UI 的修改都**必须先读** | 新增组件规范、调整设计语言时 |
| `docs/user-testing.md` | 用户测试文档 — 27 个测试用例（P0/P1/P2 三级） | 改完功能后手动回归 | 新增测试用例、更新已知限制时 |
| `docs/debug-log.md` | **bug修复踩坑记录** — 问题、根因分析和解决方案 | 遇到类似问题时查阅 | 新踩坑后追加 |
| `CHANGELOG.md` | **变更日志** — Keep a Changelog 格式，面向用户 | 发布时查阅历史变更 | 每次有意义的代码变更后**必须添加条目**（需用户确认） |
| `PROGRESS.md` | **开发里程碑** — 已完成阶段、架构决策、技术选型 | 了解项目整体进展、向新人介绍项目 | 完成一个完整阶段（如 Phase 8b）后更新 |

All under `/home/pax/coding/research/`:

| Repo | Path | License | Role |
|------|------|---------|------|
| tmuxes | `research/tmuxes` | MIT | Backend architecture reference |
| dufs | `research/dufs` | Apache-2.0/MIT | Rust file server reference |
| mansio | `research/mansio` | GPL-3.0 | **Architecture reference ONLY** — do NOT copy code |

## License Compliance

- Mansio (GPL-3.0): read only at `research/mansio`, NEVER copy code into this project
- All new code files: MIT license header
- Root LICENSE: MIT
