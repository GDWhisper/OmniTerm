# OmniTerm Development Progress

## Completed (2026-06-20)

### Phase 1: Backend Skeleton ✅
- Axum HTTP server on :9777
- SQLite database with migrations (users, targets, workspaces, sessions)
- Auth system (bcrypt + HttpOnly cookie + JWT)
- REST APIs: health, auth, targets, workspaces, sessions

### Phase 2: Terminal Persistence ✅
- tmux management module (new_session, kill_session, list_sessions, capture_pane, pane_cwd)
- PTY bridge using portable-pty
- WebSocket terminal endpoint at /api/v1/ws/terminal/{session_id}
- Protocol: binary frames for I/O, JSON for control (resize/attached/pong/exit)
- Session creation auto-creates tmux session; deletion auto-kills it

### Phase 3: Agent Hook Monitoring ✅
- Pane content scanner (scan_agent_state) with heuristic detection
- States: Running, Decision, Finished, Error, Idle
- Agent kind detection: claude, codex
- API: GET /sessions/{id}/hook-status, POST hook-enable|hook-disable

### Phase 4: File Management API ✅
- sanitize_path (canonicalize + strip_prefix) for path security
- Endpoints: list, upload (multipart), download, read, write, mkdir, delete, rename, move, copy, search
- Workspace-scoped file operations

### Phase 5: Frontend Skeleton ✅
- Vite 8 + React 19 + TypeScript + Tailwind CSS 4
- Three-panel layout with drag resize (width persisted to localStorage)
- Mobile layout with bottom tab navigation
- Sidebar: workspace tree + session list + create buttons
- Terminal: xterm.js + WebSocket connection
- FileManager: file list + navigate + delete + mkdir
- Zustand stores: appStore (layout/data), themeStore
- API client with typed fetch wrapper
- Vite proxy: /api → localhost:9777

### Phase 6: File Manager Integration ✅
- @cubone/react-file-manager integrated (grid/list view, breadcrumb, context menu, multi-select)
- File upload with drag-and-drop zone
- Dark theme CSS overrides for cubone
- API client completed: upload, download, move, copy, search

### Phase 7: Polish ✅
- Theme system: light/dark/system with Tailwind v4 @custom-variant
- Settings panel: theme toggle + terminal font size slider (10-24px)
- Toast notification system (auto-dismiss, 4 types)
- Mobile IME support (compositionstart/compositionend)
- Docker multi-stage build (Dockerfile + docker-compose)
- Static file serving in production (ServeDir + SPA fallback)

### Phase 8: Frontend UI Unification ✅ (2026-06-21)

Comprehensive visual restyle so every surface in the app (Sidebar, Terminal,
FileManager, empty states, drag bars) shares the same dark violet-on-black
palette and JetBrains Mono typography.

**Sidebar / FileManager palette (`#0a0a0f` canvas, `#1e293b` / `#334155` borders, `#a78bfa` violet accents)**
- Sidebar: deep-black bg, violet gradient logo, glowing active-indicator bar,
  session RUN badge, modal inputs with violet focus rings
- FileManager wrapper: dark bg + `#1e293b` left border, replaces the old gray Tailwind border
- Desktop layout root: full `#0a0a0f` background so no gray bleeds between panes

**@cubone/react-file-manager deep theme (`frontend/src/index.css`)**
- Scoped `.omnifm-root` overrides for 20+ cubone selectors: toolbar, nav-pane,
  breadcrumb, file rows, context menu, modals, inputs, drop-zone, progress bar,
  loader, buttons (primary/secondary/danger)
- Layout flipped from side-by-side to vertical stack: folder tree on top, main
  file listing below, sharing the full panel width
- Hidden redundant cubone toolbar icons that overlapped the home directory
- Column headers restyled (uppercase, letter-spacing, `#1e293b` rule)
- Empty state ("该文件夹为空") and metadata text aligned to the OmniTerm palette
- `primaryColor="#a78bfa"`, JetBrains Mono font propagated

**Vertical drag bar between folder tree and main listing**
- Mirrors the Sidebar horizontal-drag pattern: save `startY + startHeight` in
  pixels, compute live delta on document mousemove, clamp (80px ↔ container-80px)
- Capture-phase mousedown with `stopImmediatePropagation()` suppresses cubone's
  own horizontal drag handler so its `isDragging` never flips true
- DOM queries via `handle.closest('.files-container')` with a 150ms retry in
  case cubone mounts the handle after the first effect run

**Shared drag-bar visual language**
- New `.omniterm-drag-bar` base + `.omniterm-drag-bar-v` (vertical, Sidebar ↔
  Terminal ↔ FileManager) and cubone's `.sidebar-resize` (horizontal)
- 4px layout slot, `#0a0a0f` bg, centered 4×48 / 36×2 violet pill indicator,
  hover glow `rgba(167,139,250,0.5)`
- Layout.tsx drag handles stripped of inline style in favor of the shared class

**Terminal empty state**
- "Select or create a session" placeholder restyled to `#0a0a0f` bg + JetBrains
  Mono, violet glow on the keyboard emoji, localized to 中文
- Terminal wrapper itself is `#0a0a0f` so no white bleeds when a session closes

### Phase 8b: FileManager Drag-Bar Architecture Upgrade ✅ (2026-06-22)

**Problem (PUA 味道: 🔴 华为 RCA)**
Cubone ships `.sidebar-resize` (the drag handle) as a *child* of
`.navigation-pane`. Two symptoms from this one root cause:
1. When the folder tree scrolls, the bar scrolls away with it — it's inside
   the scrolling container.
2. An earlier `position:absolute + top:40%` workaround tried to pin the bar
   at the pane boundary, but percentage `top` resolves against the nearest
   positioned ancestor, which shifts with viewport size and breaks the
   alignment with the actual pane split.

**Solution: physical DOM relocation + flex sibling**
- `MutationObserver` watches both `.navigation-pane` (tree mutations: folder
  expand/collapse, file selection refresh) and `.files-container` (workspace
  switch recreates cubone's DOM).
- Every time cubone re-injects `.sidebar-resize` inside `.navigation-pane`,
  the observer's callback physically moves it to be the next sibling of
  `.navigation-pane` inside `.files-container` — between nav and preview.
- A `suppressNext` flag prevents the container observer from reacting to
  our own `insertBefore` move (which would otherwise cause redundant work).
- The bar is now a `flex: 0 0 8px` item in the column layout. Flex places
  it at the pane boundary by construction — no percentage math, no
  containing-block tricks, no drift on scroll.

**Capture-phase mousedown handler**
- `stopImmediatePropagation()` on capture phase blocks cubone's bubble-phase
  `handleMouseDown`, so its internal `isDragging` state never flips.
- Live drag uses pixel deltas: save `startNavPx` + `startPreviewPx`, compute
  `delta = clientY - startY`, apply `height:<px> !important` via `cssText`
  on both panes. Clamped to `min 80px` on each side.

**Unified dark-tech scrollbar**
- `::-webkit-scrollbar` rules (8px width, `#334155` thumb on `#0a0a0f` track,
  violet `#a78bfa` on hover) plus `scrollbar-color` / `scrollbar-width: thin`
  for Firefox.
- Scoped under `.omnifm-root .file-explorer *` so it never bleeds into the
  Sidebar or Terminal panels.

**Verified (sub-agent headless Chromium + production build)**
- `files-container.children` order: `[navigation-pane, sidebar-resize, folders-preview]`
- `gapNavToBar` = 0.00px, `gapBarToPreview` = 0.00px
- Drag 50px down: nav +50px, preview -50px (exact pixel transfer)
- Scroll before/after: drag-bar `top` delta = 0.00px (scroll-immune)
- `scrollbarColor` = `rgb(51,65,85) rgb(10,10,15)` = `#334155 #0a0a0f`
- `pnpm build` green: 39 modules, 245ms

**Files touched**
- `frontend/src/components/FileManager/FileManager.tsx` — `useEffect` drag
  logic rewritten; MutationObserver + DOM relocation
- `frontend/src/index.css` — removed `position:absolute` / `top:40%` rules,
  added `flex: 0 0 8px` bar style + unified scrollbar rules
- `frontend/src/cubone-file-manager.d.ts` — new; type shim for the cubone
  package (was missing, blocked `pnpm build`)
- `FileManager.tsx:357` — `err` callback parameter typed as `any` to pass
  strict mode (blocked `pnpm build`)

## How to Continue

```bash
cd /home/pax/coding/OmniTerm

# 一键启动（推荐）
./dev.sh start     # 后端 :9777 + 前端 :9778
./dev.sh stop      # 停止
./dev.sh status    # 查看状态
./dev.sh logs      # 实时日志

# 手动启动
. "$HOME/.cargo/env"
cargo run          # 后端 :9777
cd frontend && pnpm dev  # 前端 :9778
```

## Key Files

- `CLAUDE.md` — full architecture documentation
- `dev.sh` — 开发环境一键管理脚本
- `docs/user-testing.md` — 用户测试文档（27 个测试用例）
- `docs/ui-style-guide.md` — UI 风格规范（色板、字体、圆角、动效、组件规范、自检清单）
- `src/main.rs` — backend entry point
- `frontend/src/App.tsx` — frontend entry point
- `frontend/src/components/Layout/Layout.tsx` — three-panel layout
- `Dockerfile` + `docker-compose.yml` — 生产部署
