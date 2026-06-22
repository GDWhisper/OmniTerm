# Changelog

All notable changes to OmniTerm are documented in this file.

## Conventions

This file follows [Keep a Changelog](https://keepachangelog.com/) with project-specific adaptations:

### Format

- Each release uses `## [version] - YYYY-MM-DD` or `## [Unreleased]` for in-progress work.
- Changes grouped by category: `Added`, `Changed`, `Fixed`, `Removed`, `Refactored`.
- One line per change — concise, describes **what** and **why**, not how.
- Breaking API changes prefixed with **BREAKING**.
- File paths are relative to project root (e.g. `src/api/files.rs`, `frontend/src/components/...`).

### When to add an entry

- New API endpoint, new component, new feature → `Added`
- Behavior change, UI adjustment, dependency bump → `Changed`
- Bug fix → `Fixed`
- Deleted code, removed endpoint, dropped dependency → `Removed`
- Code reorganization without behavior change → `Refactored`

### When NOT to add an entry

- Typo fixes in comments, whitespace cleanup, lint fixes
- Changes to `AGENTS.md`, `PROGRESS.md`, or other internal docs
- Dev-only tooling tweaks (`.gitignore`, editor config)

### Scope tags

Prefix each entry with the area it affects:

| Tag | Scope |
|-----|-------|
| `[backend]` | Rust backend (`src/`) |
| `[frontend]` | React frontend (`frontend/src/`) |
| `[api]` | REST/WebSocket API contract |
| `[infra]` | Docker, CI, build, dev scripts |
| `[docs]` | User-facing documentation |

---

## [Unreleased]

### Changed

- `[frontend]` FileManager: replaced all emoji icons (📁🔗📄⬆⟳📂✏️🗑️) with stroke-based inline SVG icons (`frontend/src/components/FileManager/icons.tsx`) — unified with the dark-tech visual language defined in `docs/ui-style-guide.md`
- `[frontend]` FileManager: merged dual-table architecture (main table + absolute-positioned actions overlay) into a single 4-column table — Actions header now aligns perfectly with Name/Last Modified/Size; removed ~80 lines of JS row-height/scroll sync code
- `[frontend]` FileManager action icons: pencil hover → violet (`#a78bfa`), trash hover → red (`#ef4444`) via `.fm-act-icon` / `.fm-act-icon-danger` CSS classes
- `[frontend]` FileManager: fixed `addToast` calls to use `(type, message)` signature matching `toastStore.ts` API (was passing object)
- `[frontend]` FileManager: fixed API method names — `api.rename` (was `api.renameFile`), `api.mkdir` (was `api.createDir`)

### Removed

- `[frontend]` Removed unused `handleMkdir` function and `showNewDir`/`newDirName` state (no UI was wired to them)
- `[frontend]` Removed `.fm-table-actions`, `.fm-td-actions`, `.fm-action` CSS rules (dead overlay-table styles)

### Added

- `[frontend]` `frontend/src/components/FileManager/icons.tsx` — 10 SVG icon components (Folder, File, Link, ArrowUp, Refresh, Upload, FolderPlus, Pencil, Trash, FolderOpen), all 16×16 stroke-based with `currentColor`
- `[backend]` 新增 `GET /api/v1/sessions/{id}/cwd` 端点 — 查询终端实时工作目录（`src/api/sessions.rs`）
- `[backend]` 文件 API 全面支持 `session` 参数 — list/upload/delete/download/read/write/mkdir/rename/move/copy/search 均可基于终端 CWD 操作（`src/api/files.rs`）
- `[frontend]` FileManager 跟随终端 CWD 功能 — 双模式导航（跟随模式 + 手动导航），3 秒轮询同步，per-session 状态记忆（`frontend/src/components/FileManager/FileManager.tsx`）
- `[frontend]` 新增 WarningIcon、HomeIcon 图标组件（`frontend/src/components/FileManager/icons.tsx`）
- `[frontend]` appStore 新增 `fmSessionStates` 状态及 `setFmSessionMode`、`setFmManualPath`、`resetFmToFollowing` actions（`frontend/src/stores/appStore.ts`）
- `[frontend]` API client 新增 7 个 session-based 文件操作方法（`frontend/src/api/client.ts`）
- `[docs]` UI 风格规范新增 `warning` 语义色（`#f59e0b`）（`docs/ui-style-guide.md`）
- `[infra]` `react-refresh` dev dependency — fixes pre-existing `$RefreshSig$ is not defined` error caused by missing peer dependency of `@vitejs/plugin-react` 6.x

---

## Phase 1–8b (completed 2026-06-22)

Initial build. See `AGENTS.md` Current Progress table and `PROGRESS.md` for full details.

### Added

- `[backend]` Axum server with SQLite, JWT auth, CRUD APIs for targets/workspaces/sessions
- `[backend]` tmux session management, PTY bridge (portable-pty), WebSocket terminal
- `[backend]` Agent hook monitoring — pane content scanning, heuristic state detection
- `[backend]` File management API — list/upload/download/read/write/mkdir/delete/rename/move/copy/search
- `[frontend]` Vite + React 19 + Tailwind 4 + xterm.js, three-panel layout (Sidebar | Terminal | FileManager)
- `[frontend]` Custom dufs-inspired file table replacing `@cubone/react-file-manager`
- `[frontend]` Dark violet-on-black palette, shared drag-bar styling, localized empty states
- `[frontend]` Drag-bar architecture upgrade — MutationObserver-based pane boundary relocation
- `[infra]` Dockerfile, docker-compose, `dev.sh` dev orchestration script
