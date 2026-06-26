# Changelog

All notable changes to OmniTerm are documented in this file.

## Conventions

This file follows [Keep a Changelog](https://keepachangelog.com/) with project-specific adaptations:

### Format

- Each release uses `## [version] - YYYY-MM-DD` or `## [Unreleased]` for in-progress work.
- Changes grouped by category: `Added`, `Changed`, `Fixed`, `Removed`, `Refactored`.
- One line per change — concise, describes **what** and **why**, not how.
- Each entry ends with a timestamp in `(YYYY-MM-DD HH:MM)` format.
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

### Added

- (2026-06-25 14:30) `[frontend]` 鼠标拖选自动复制 — Shift+拖拽绕过 tmux 鼠标模式，松手自动写入剪贴板，支持 navigator.clipboard 降级方案（`frontend/src/hooks/useTerminal.ts`）
- (2026-06-25 11:00) `[backend]` Git worktree 发现模块 — `git worktree list --porcelain` 解析，实时查询 project 下所有分支/工作树（`src/git/mod.rs`）
- (2026-06-25 11:00) `[backend]` Project 模型替代 Workspace — 语义明确为 git 仓库，持久化到 DB（`src/models/project.rs`）
- (2026-06-25 11:00) `[backend]` `GET /api/v1/projects/{pid}/worktrees` 端点 — 实时返回项目的所有 git worktree，确定性 ID（SHA1 前 12 位）（`src/api/projects.rs`）
- (2026-06-25 11:00) `[backend]` Workspace 运行时模块 — 非 git 仓库退化为单 workspace，git 仓库自动发现 worktree（`src/workspaces.rs`）
- (2026-06-25 11:00) `[backend]` 数据库迁移脚本 — `workspaces` → `projects` 改名，`sessions` 新增 `project_id` + `workspace_path` 列（`migrations/20260625_workspace_to_project.sql`）
- (2026-06-25 11:00) `[frontend]` GitBranchIcon 组件 — SVG 分支图标，模仿 git logo 节点分叉形状（`frontend/src/components/Icons/GitBranchIcon.tsx`）
- (2026-06-26 08:00) `[backend]` Agent 状态数据模型 — `AgentKind`/`AgentState`/`AttentionReason` 枚举、`AgentSnapshot` 结构体、`@omniterm_agent` session option 解析器（`src/tmux/agent_state.rs`）
- (2026-06-26 08:00) `[backend]` Agent hook 配置生成 — Claude Code `--settings` JSON + Codex `-c` 命令行参数自动注入，detect_agent_kind + augment_agent_command（`src/tmux/agent_hooks.rs`）
- (2026-06-26 08:00) `[backend]` Session 列表集成 agent 状态 — `list_sessions` 格式串改用 `|` 分隔，新增 `#{@omniterm_agent}` 字段，API 响应自动填充 agent 字段（`src/tmux/mod.rs`、`src/api/sessions.rs`）
- (2026-06-26 08:00) `[backend]` Session 创建时自动检测 agent CLI 并注入 hook — `CreateSession.command` 可选字段，`new_session` 返回是否注入（`src/tmux/mod.rs`、`src/api/sessions.rs`）
- (2026-06-26 08:00) `[backend]` WebSocket 实时 agent 状态推送 — 终端 WS 连接内嵌 1s 轮询 task，nonce 变化时 JSON push，2s timeout + 3 次连续失败自动停止，oneshot 显式关闭（`src/ws/terminal.rs`）
- (2026-06-26 08:00) `[backend]` hook-status API 重构 — 优先读 session option，fallback 到 capture-pane 启发式扫描（`src/api/hooks.rs`）
- (2026-06-26 08:00) `[frontend]` Attention 通知系统 — AttentionProvider Context、useAttention hook、Web Audio ping 声音、标签页闪烁、智能 diff 去抖（decision 2 周期确认）（`frontend/src/components/Attention/`、`frontend/src/hooks/useAttention.ts`）
- (2026-06-26 08:00) `[frontend]` Sidebar session 行 badge — ⏳/⚠️/✓ 图标 + 脉冲动画，点击清除，轮询间隔 3s（`frontend/src/components/Sidebar/Sidebar.tsx`）

### Changed

- (2026-06-25 14:30) `[frontend]` 亮色主题改为暖灰底色 — 背景 `#f0ece6`、文字 `#1c1917`，对比度 AAA 级，消除纯白刺眼（`frontend/src/index.css`）
- (2026-06-25 14:30) `[frontend]` 亮色终端主题同步改为暖灰 — 底色 `#ece8e1`、前景 `#1c1917`、ANSI 16 色暖调适配（`frontend/src/hooks/useTerminal.ts`）
- (2026-06-25 14:30) `[frontend]` Settings 面板 UI 比例优化 — 节标题 11px uppercase、按钮缩小、字号显示 18px、间距收紧（`frontend/src/components/Settings/Settings.tsx`）
- (2026-06-25 14:30) `[frontend]` 终端空状态 emoji ⌨️ 替换为 SVG KeyboardIcon — stroke-based、currentColor，符合 UI 规范（`frontend/src/components/Icons/KeyboardIcon.tsx`、`frontend/src/components/Terminal/Terminal.tsx`）
- (2026-06-25 14:30) `[frontend]` Slogan 更新为「万千智能体汇于一端」/ "All agents in one term"，移除 Phase 7 标签（`frontend/src/locales/*/translation.json`）
- (2026-06-25 11:00) `[frontend]` Sidebar 从两级（Workspace → Session）重构为三级树（Project → Workspace/Worktree → Session）— 展开 project 自动显示 git 分支，选中分支后显示关联 session（`frontend/src/components/Sidebar/Sidebar.tsx`）
- (2026-06-25 11:00) `[backend]` Session 绑定从 workspace 改为 worktree 路径 — `pane_cwd` 自动等于 `workspace_path`，文件管理器跟随切换（`src/api/sessions.rs`）
- (2026-06-25 11:00) `[api]` 端点从 `/workspaces/*` 迁移到 `/projects/*` — `POST /projects/{pid}/sessions` 新增 `workspace_path` 参数（`src/api/projects.rs`）
- (2026-06-25 11:00) `[frontend]` appStore 状态重构 — `workspaces` → `projects` + `worktrees`（Record 按 project 分组），新增 `activeProjectId`（`frontend/src/stores/appStore.ts`）
- (2026-06-25 11:00) `[frontend]` 移除 Sidebar 中的 emoji — 项目名去除 📁 前缀，worktree 使用 GitBranchIcon 替代 🌿（`frontend/src/components/Sidebar/Sidebar.tsx`）

### Removed

- (2026-06-25 11:00) `[backend]` Workspace 模型和 API — 被 Project 替代（`src/models/workspace.rs`、`src/api/workspaces.rs`）

### Fixed

- (2026-06-25 11:00) `[backend]` 迁移 SQL 中 `w.path` 修正为 `w.root_path` — 旧表列名错误导致迁移失败（`migrations/20260625_workspace_to_project.sql`）

- (2026-06-23 19:30) `[frontend]` FileManager 搜索框改为图标触发式弹出 — 点击搜索图标后输入框浮现在图标下方，支持 Escape 和点击外部关闭（`frontend/src/components/FileManager/FileManager.tsx`）
- (2026-06-23 19:35) `[frontend]` FileManager 面包屑根路径从 `/` 改为工作台图标 — 带紫色边框方框，风格与 WRKSPACES `+` 号一致（`frontend/src/components/FileManager/icons.tsx`）
- (未记录时间) `[frontend]` FileManager: replaced all emoji icons (📁🔗📄⬆⟳📂✏️🗑️) with stroke-based inline SVG icons (`frontend/src/components/FileManager/icons.tsx`) — unified with the dark-tech visual language defined in `docs/ui-style-guide.md`
- (未记录时间) `[frontend]` FileManager: merged dual-table architecture (main table + absolute-positioned actions overlay) into a single 4-column table — Actions header now aligns perfectly with Name/Last Modified/Size; removed ~80 lines of JS row-height/scroll sync code
- (未记录时间) `[frontend]` FileManager action icons: pencil hover → violet (`#a78bfa`), trash hover → red (`#ef4444`) via `.fm-act-icon` / `.fm-act-icon-danger` CSS classes
- (未记录时间) `[frontend]` FileManager: fixed `addToast` calls to use `(type, message)` signature matching `toastStore.ts` API (was passing object)
- (未记录时间) `[frontend]` FileManager: fixed API method names — `api.rename` (was `api.renameFile`), `api.mkdir` (was `api.createDir`)

### Removed

- (未记录时间) `[frontend]` Removed unused `handleMkdir` function and `showNewDir`/`newDirName` state (no UI was wired to them)
- (未记录时间) `[frontend]` Removed `.fm-table-actions`, `.fm-td-actions`, `.fm-action` CSS rules (dead overlay-table styles)

### Added

- (未记录时间) `[frontend]` `frontend/src/components/FileManager/icons.tsx` — 10 SVG icon components (Folder, File, Link, ArrowUp, Refresh, Upload, FolderPlus, Pencil, Trash, FolderOpen), all 16×16 stroke-based with `currentColor`
- (2026-06-23 00:44) `[backend]` 新增 `GET /api/v1/sessions/{id}/cwd` 端点 — 查询终端实时工作目录（`src/api/sessions.rs`）
- (2026-06-23 00:47) `[backend]` 文件 API 全面支持 `session` 参数 — list/upload/delete/download/read/write/mkdir/rename/move/copy/search 均可基于终端 CWD 操作（`src/api/files.rs`）
- (2026-06-23 00:51) `[frontend]` FileManager 跟随终端 CWD 功能 — 双模式导航（跟随模式 + 手动导航），3 秒轮询同步，per-session 状态记忆（`frontend/src/components/FileManager/FileManager.tsx`）
- (2026-06-23 00:48) `[frontend]` 新增 WarningIcon、HomeIcon 图标组件（`frontend/src/components/FileManager/icons.tsx`）
- (2026-06-23 00:48) `[frontend]` appStore 新增 `fmSessionStates` 状态及 `setFmSessionMode`、`setFmManualPath`、`resetFmToFollowing` actions（`frontend/src/stores/appStore.ts`）
- (2026-06-23 00:48) `[frontend]` API client 新增 7 个 session-based 文件操作方法（`frontend/src/api/client.ts`）
- (2026-06-23 00:48) `[docs]` UI 风格规范新增 `warning` 语义色（`#f59e0b`）（`docs/ui-style-guide.md`）
- (2026-06-23 19:30) `[frontend]` 新增 IconSearch、IconWorkbench 图标组件（`frontend/src/components/FileManager/icons.tsx`）
- (未记录时间) `[infra]` `react-refresh` dev dependency — fixes pre-existing `$RefreshSig$ is not defined` error caused by missing peer dependency of `@vitejs/plugin-react` 6.x

### Fixed

- (2026-06-23 01:01) `[frontend]` FileManager 轮询改为只检查 CWD 变化，CWD 不变时不刷新文件列表 — 消除终端未 cd 时的闪烁
- (2026-06-23 01:07) `[frontend]` FileManager 静默轮询 + 浅比较：后台刷新不显示 loading 状态，文件列表无变化时跳过 setFiles() — 消除 agent 频繁增删文件时的闪烁

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
