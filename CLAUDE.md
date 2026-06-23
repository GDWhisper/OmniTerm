# OmniTerm

Web-based tmux terminal manager. Three-panel layout: Sidebar | Terminal | FileManager.
Rust (Axum) backend + React (Vite + TypeScript) frontend. MIT licensed.

## Current Progress

**Phase 1-8b complete (2026-06-22). ~3500 lines total.**

| Phase | Status | Notes |
|-------|--------|-------|
| 1. Backend skeleton | ✅ | Axum, SQLite, auth, CRUD APIs |
| 2. Terminal persistence | ✅ | tmux management, PTY (portable-pty), WebSocket bridge |
| 3. Agent Hook monitoring | ✅ | Pane scanning, heuristic state detection |
| 4. File management API | ✅ | List/upload/download/read/write/mkdir/delete/rename/move/copy/search |
| 5. Frontend skeleton | ✅ | Vite + React + Tailwind + xterm.js, three-panel layout |
| 6. File manager integration | ✅ | Custom dufs-inspired file table (replaced cubone), upload, dark theme |
| 7. Polish | ✅ | Themes, mobile IME, font sizing, toast errors, Dockerfile |
| 8. Frontend UI unification | ✅ | Dark violet-on-black palette across Sidebar/Terminal/FileManager, vertical file-manager layout with drag bar, shared drag-bar styling, localized empty states |
| 8b. Drag-bar architecture upgrade | ✅ | MutationObserver relocates cubone's `.sidebar-resize` out of nav-pane into a flex sibling (real pane boundary, scroll-immune); unified dark-tech scrollbar (`#334155` thumb / `#0a0a0f` track) |

## Development Conventions

1. **开发/debug 后必须提交 git** — 每完成一个功能点或修复一个 bug 后，立即 `git commit`，提交信息说明修改内容。
2. **CHANGELOG 只写用户确认的内容** — 只有经过用户确认的新功能和修复才写入 `CHANGELOG.md`，不要自行添加未确认的条目。

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

项目使用 git worktree 管理开发分支：

| 目录 | 分支 | 用途 |
|------|------|------|
| `/home/pax/coding/OmniTerm` | `main` | 稳定版本 |
| `/home/pax/coding/OmniTerm-dev` | `dev` | 开发分支 |
| `/home/pax/coding/OmniTerm-debug` | `debug` | 调试分支（基于 dev） |

- 三个 worktree 共享 `.git` 对象，各自独立工作
- 在 `OmniTerm-dev` 目录启动独立的 Claude Code 会话进行开发
- debug 分支用于独立调试，不影响 dev 主开发流程
- 开发完成后将 `dev` 合并回 `main`
- 修改版本号时只需编辑 `frontend/src/version.ts`

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

| File | Purpose | When to consult |
|---|---|---|
| `docs/ui-style-guide.md` | **UI 风格规范** — 色板、字体、圆角、动效、drag bar 语言、组件规范、新增组件自检清单 | 任何涉及 UI 的修改（前端新增组件、改样式、调 cubone 覆盖规则）都**必须先读**此文档，确保视觉语言一致 |
| `docs/user-testing.md` | 用户测试文档 — 10 个章节、27 个测试用例（P0/P1/P2 三级）、6 个已知限制 | 改完功能后手动回归、或新增测试覆盖时 |
| `docs/2026-06-20-sidebar-redesign-design.md` | Sidebar 重设计的设计决策与方案记录 | 修改 Sidebar 相关组件时了解历史背景 |
| `CHANGELOG.md` | **变更日志** — 按 Keep a Changelog 格式记录每次变更，含 scope 标签和写入规范 | 每次有意义的代码变更后**必须添加条目**；提交前检查是否遗漏 |

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
