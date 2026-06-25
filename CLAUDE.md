# OmniTerm

Web-based tmux terminal manager. Three-panel layout: Sidebar | Terminal | FileManager.
Rust (Axum) backend + React (Vite + TypeScript) frontend. MIT licensed.

> 进度里程碑见 `PROGRESS.md`

## Development Conventions

1. **开发/debug 后必须提交 git** — 每完成一个功能点或修复一个 bug 后，立即 `git commit`，提交信息说明修改内容。
2. **CHANGELOG 只写用户确认的内容** — 只有经过用户确认的新功能和修复才写入 `CHANGELOG.md`，不要自行添加未确认的条目。
3. **提交前缀规范**：
   - 功能/修复：`feat:` / `fix:`
   - 开发文档/配置：`docs:` / `chore:` — 合入 main 时会被过滤

## 分支合并铁律

- **代码永远从「不稳定」流向「稳定」：`debug → dev → main`**
- 合并必须在**接收方的工作树**里执行，严禁反向推送

| 合并动作 | 执行位置 | 命令 |
|----------|----------|------|
| 吸收 debug 修复 | `~/coding/OmniTerm-dev` | `git merge debug` |
| 吸收 dev 开发成果 | `~/coding/OmniTerm` | `git merge dev`（需用户要求，过滤文档） |
| 同步 dev 到 debug | `~/coding/OmniTerm-debug` | `git merge dev`（仅拉取参考代码） |

## Debug 分支工作流

1. **拉取最新 dev**：`cd ~/coding/OmniTerm-debug && git merge dev`
2. **原子化提交**：
   - 核心修复 → `fix: 描述`
   - 本地定制配置（端口、AGENTS.md 等）→ `chore: 本地调试配置` 单独提交
3. **只做修复，不加功能** — debug 分支仅用于 bugfix
4. **独立验证**：在 debug 专属端口（19777/19778）启动服务测试
5. **合入 dev**：切换到 `~/coding/OmniTerm-dev` 执行 `git merge debug`

```bash
cd ~/coding/OmniTerm-dev   # dev worktree
git merge debug
git push origin dev
```

### 端口隔离

| 分支 | 后端 | 前端 |
|------|------|------|
| dev | 9777 | 9778 |
| debug | 19777 | 19778 |

端口配置在 `.env.local`（已 gitignore），merge debug 不会带入。dev.sh 和 vite.config.ts 均读取环境变量，fallback 为 9777/9778。

## Dev 分支工作流

- 直接在 `~/coding/OmniTerm-dev` 中开发、提交
- **开发文档/配置**用 `docs:` 或 `chore:` 前缀，合入 main 时会被过滤
- 定期合并 `debug` 的修复，过滤 debug 专用的 AGENTS.md、特殊配置

## Main 分支发布

- **禁止主动合并 dev 到 main** — 只有用户明确要求时才允许执行
- 合并时排除：`openspec/`、`docs/`、`AGENTS.md`、`chore:` 前缀提交
- 推荐方式：cherry-pick 功能/修复提交，跳过文档提交

```bash
cd ~/coding/OmniTerm   # main worktree
# 方式1：合并后排除
git merge dev --no-commit
git reset HEAD openspec/ docs/ AGENTS.md
git checkout -- openspec/ docs/ AGENTS.md
git commit

# 方式2：cherry-pick 只摘取功能/修复提交
git cherry-pick <commit-hash>
```

发布推送：
```bash
git push origin main      # 私有仓
git push public main      # 公开仓（只含干净代码）
```

## 多 Agent 协作安全守则

- **撤销已推送提交**：必须用 `git revert`，严禁 `git reset --hard` 或 `--force`
- **禁止**从 debug/dev 直接 `git push origin debug:dev` 覆盖其他分支
- **冲突处理**：发生在哪个工作树，就在哪个工作树解决

## Quick Start

```bash
# 一键启动（推荐）
./dev.sh start    # 后端 :9777 + 前端 :9778
./dev.sh stop     # 停止所有
./dev.sh status   # 查看状态
./dev.sh logs     # 实时日志

# 手动启动
cd /home/pax/coding/OmniTerm
. "$HOME/.cargo/env"
cargo run                    # 后端 :9777
cd frontend && pnpm dev      # 前端 :9778, proxies /api → :9777

# Docker (production)
docker compose up --build    # 后端 :9777
```

## Git Worktree

**文件约定**：`AGENTS.md` 是 `CLAUDE.md` 的 symlink（`AGENTS.md -> CLAUDE.md`），两个名称指向同一份规范文件。

项目使用 git worktree 管理开发分支：

| 目录 | 分支 | 用途 | 端口 |
|------|------|------|------|
| `~/coding/OmniTerm` | `main` | 最终发布 | 无需常驻服务 |
| `~/coding/OmniTerm-dev` | `dev` | 日常开发 | 9777/9778 |
| `~/coding/OmniTerm-debug` | `debug` | 紧急修复 | 19777/19778 |

- 三个 worktree 共享 `.git` 对象，各自独立工作
- 在 `OmniTerm-dev` 目录启动独立的 Claude Code 会话进行开发
- debug 分支用于独立调试，不影响 dev 主开发流程
- **禁止主动合并 dev 到 main** — 只有用户明确要求时才允许执行合并操作
- 修改版本号时只需编辑 `frontend/src/version.ts`

### 远程仓库策略

- **私有仓**（`origin`）：存放所有分支，日常 push/pull
- **公开仓**（`public`）：只推送 `main` 分支，用于对外发布

```bash
git remote add origin git@github.com:yourname/OmniTerm-private.git
git remote add public git@github.com:yourname/OmniTerm.git
```

## CodeGraph

本项目已索引（`.codegraph/` 存在），必须优先使用 CodeGraph 工具查询和理解代码：

| 场景 | 工具 | 替代 |
|------|------|------|
| 理解代码、追踪流程、回答问题 | `codegraph_explore` | — |
| 读取文件或查看单个符号 | `codegraph_node` | 替代 Read |
| 按名称搜索符号 | `codegraph_search` | 替代 Grep |
| 查找调用点（含回调注册） | `codegraph_callers` | — |

**规则：**
1. 使用前先 `codegraph sync` 确认索引最新
2. 只有 CodeGraph 无法覆盖时（配置文件、文档、非索引文件），才用 Read/Grep

## Backend Architecture (`src/`)

```
src/
├── main.rs              # Entry: Axum server, SQLite pool, migrations, static file serving
├── api/
│   ├── mod.rs           # Route registration, state wiring
│   ├── health.rs        # GET /api/v1/health
│   ├── auth.rs          # POST /api/v1/auth/setup|login|logout, GET /auth/check
│   ├── targets.rs       # CRUD /api/v1/targets
│   ├── workspaces.rs    # CRUD /api/v1/workspaces
│   ├── sessions.rs      # CRUD /api/v1/workspaces/{wid}/sessions (auto-creates tmux session)
│   ├── hooks.rs         # GET /sessions/{id}/hook-status, POST hook-enable|hook-disable
│   └── files.rs         # /api/v1/files — list/upload/download/read/write/mkdir/delete/rename/move/copy/search
├── auth/mod.rs          # JWT token creation/verification, RequireAuth extractor
├── models/              # SQLx-derived structs: User, Target, Workspace, Session
├── tmux/
│   ├── mod.rs           # tmux command wrappers: new_session, kill_session, list_sessions, capture_pane, pane_cwd
│   └── hooks.rs         # Agent state scanner: scan_agent_state() — heuristic pane content analysis
├── fs/mod.rs            # File ops: sanitize_path, list_dir, read_file, write_file, delete, rename, move, copy, search
├── ws/
│   ├── mod.rs
│   └── terminal.rs      # WebSocket terminal bridge: PTY ↔ WS binary frames, JSON control
└── utils/path.rs        # Path security: sanitize_path (canonicalize + strip_prefix)
```

### API Endpoints

```
GET  /api/v1/health
POST /api/v1/auth/setup|login|logout
GET  /api/v1/auth/check
GET  /api/v1/targets
POST /api/v1/targets
DELETE /api/v1/targets/{id}
GET  /api/v1/workspaces
POST /api/v1/workspaces
PATCH/DELETE /api/v1/workspaces/{id}
GET  /api/v1/workspaces/{wid}/sessions
POST /api/v1/workspaces/{wid}/sessions
PATCH/DELETE /api/v1/sessions/{id}
GET  /api/v1/sessions/{id}/hook-status
POST /api/v1/sessions/{id}/hook-enable|hook-disable
GET  /api/v1/files (list)
POST /api/v1/files (upload multipart)
DELETE /api/v1/files (delete)
GET  /api/v1/files/download|read|search
POST /api/v1/files/write|mkdir|rename|move|copy
WS   /api/v1/ws/terminal/{session_id}
```

### WebSocket Protocol

```
Client → Server | Binary:  terminal stdin (raw bytes)
Server → Client | Binary:  terminal stdout (raw bytes)
Client → Server | Text:    { type: "resize", cols, rows }
Server → Client | Text:    { type: "attached", session }
Server → Client | Text:    { type: "pong" }
Server → Client | Text:    { type: "error", message }
Server → Client | Text:    { type: "exit", code }
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `sqlite:omniterm.db?mode=rwc` | SQLite connection string |
| `JWT_SECRET` | `omniterm-default-secret-change-me` | JWT signing secret |
| `BIND_ADDR` | `127.0.0.1:9777` | Listen address (dev: localhost only, Docker: 0.0.0.0) |
| `FRONTEND_DIR` | `frontend/dist` | Static files directory for SPA |

### Key Dependencies

- `axum` 0.8 (ws, multipart) / `tokio` / `tower-http`
- `sqlx` 0.8 (sqlite, migrate) / `serde` / `serde_json`
- `bcrypt` / `jsonwebtoken` / `axum-extra` (cookie)
- `portable-pty` 0.9 / `futures-util`
- `chrono` / `uuid` / `anyhow` / `tracing`

## Frontend Architecture (`frontend/src/`)

```
src/
├── main.tsx, App.tsx, index.css
├── api/client.ts        # Typed fetch wrapper for all API endpoints
├── stores/
│   ├── appStore.ts      # Zustand: layout, workspaces, sessions, font size, mobile detection
│   ├── themeStore.ts    # Zustand: light/dark/system theme + .dark class on <html>
│   └── toastStore.ts    # Zustand: toast notifications (auto-dismiss)
├── hooks/
│   ├── useTerminal.ts   # xterm.js + WebSocket + IME composition + live font size
│   └── useMediaQuery.ts # Mobile breakpoint detection
└── components/
    ├── Layout/
    │   ├── Layout.tsx    # Three-panel container + drag resize + mobile tab layout
    │   └── MobileNav.tsx # Bottom tab navigation (终端/文件/会话/设置)
    ├── Sidebar/
    │   └── Sidebar.tsx   # Workspace tree + session list + create buttons
    ├── Terminal/
    │   └── Terminal.tsx  # xterm.js container + WebSocket connection + dark empty-state ("选择或创建一个会话")
    ├── FileManager/
    │   ├── FileManager.tsx # dufs-inspired single-page file table: breadcrumb, sortable columns, upload, search
    │   └── icons.tsx       # 10 inline SVG icon components (stroke-based, currentColor, dark-tech style)
    ├── Settings/
    │   └── Settings.tsx  # Theme toggle + terminal font size slider
    └── Toast/
        └── Toast.tsx     # Toast notification container (fixed bottom-right)
```

### Key Frontend Dependencies

- `react` 19 / `vite` 8 / `tailwindcss` 4
- `zustand` 5 (state management)
- `@xterm/xterm` 6 + `@xterm/addon-fit` + `@xterm/addon-web-links`
- `@cubone/react-file-manager` 1.35 — **removed**, replaced by custom dufs-inspired FileManager
- Vite proxy: `/api` → `http://localhost:9777`

## Documentation (`docs/`)

| File | Purpose | When to consult | When to maintain |
|---|---|---|---|
| `docs/ui-style-guide.md` | **UI 风格规范** — 色板、字体、圆角、动效、drag bar 语言、组件规范、新增组件自检清单 | 任何涉及 UI 的修改都**必须先读** | 新增组件规范、调整设计语言时 |
| `docs/user-testing.md` | 用户测试文档 — 27 个测试用例（P0/P1/P2 三级） | 改完功能后手动回归 | 新增测试用例、更新已知限制时 |
| `docs/debug-log.md` | **bug修复踩坑记录** — 问题、根因分析和解决方案 | 遇到类似问题时查阅 | 新踩坑后追加 |
| `CHANGELOG.md` | **变更日志** — Keep a Changelog 格式，面向用户 | 发布时查阅历史变更 | 每次有意义的代码变更后**必须添加条目**（需用户确认） |
| `PROGRESS.md` | **开发里程碑** — 已完成阶段、架构决策、技术选型 | 了解项目整体进展、向新人介绍项目 | 完成一个完整阶段（如 Phase 8b）后更新 |

## Reference Repos (local paths)

All under `/home/pax/coding/research/`:

| Repo | Path | License | Role |
|------|------|---------|------|
| tmuxes | `research/tmuxes` | MIT | Backend architecture reference |
| dufs | `research/dufs` | Apache-2.0/MIT | Rust file server reference |
| mansio | `research/mansio` | GPL-3.0 | **Architecture reference ONLY** — do NOT copy code |
| react-file-manager | `research/react-file-manager` | MIT | Frontend file manager component |

## License Compliance

- Mansio (GPL-3.0): read only at `research/mansio`, NEVER copy code into this project
- tmuxes (MIT): reference architecture, implement independently in Rust
- dufs (Apache-2.0/MIT): reference algorithms, implement independently
- All new code files: MIT license header
- Root LICENSE: MIT
