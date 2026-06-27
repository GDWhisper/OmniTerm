# File Manager Workspace Tracking

**Date:** 2026-06-27
**Status:** design

## Overview

When a user clicks a workspace in the sidebar and no session is focused, FileManager should display the workspace root directory with full file operations. When a session is focused, show terminal's CWD as before. A pulsing "back to terminal CWD" button signals the user is outside the terminal's current directory.

## Data Source Priority

```
activeSessionId → show terminal CWD (existing behavior)
    ↓ null
activeWorkspaceId → show workspace root directory
    ↓ null
empty state
```

## Backend Changes

### `GET /api/v1/files` — add `workspace_id` parameter

**`src/api/files.rs`** — `list_files` handler:

- Query param `workspace_id` is mutually exclusive with `session`
- When `workspace_id` is provided:
  - Look up workspace from DB by id to get its `path`
  - Use workspace `path` as the base directory (instead of tmux pane CWD)
  - `is_outside_workspace` is always `false` (you can't be outside the workspace root)
- When neither `session` nor `workspace_id` is provided → 400 Bad Request

## Frontend Changes

### API Client (`frontend/src/api/client.ts`)

Rename `listFilesBySession` → `listFiles`, accept `{ session?: string, workspaceId?: string }`:

```ts
listFiles(params: { session?: string, workspaceId?: string, path?: string, sort?: string, desc?: boolean })
```

### FileManager (`frontend/src/components/FileManager/FileManager.tsx`)

**`useFmSource()` hook:**

```ts
const source = activeSessionId
  ? { type: 'session', id: activeSessionId }
  : activeWorkspaceId
    ? { type: 'workspace', id: activeWorkspaceId }
    : null
```

- `useFmSource()` replaces all direct `activeSessionId` reads in FileManager
- When `source` changes (session switch, workspace switch, collapse), re-fetch

**fetchFiles adaptation:**

- `source.type === 'session'` → pass `session: id` (existing logic)
- `source.type === 'workspace'` → pass `workspaceId: id`, use `fmState.manualPath` or root
- `source === null` → clear files, show empty state

**Following mode:** only active when `source.type === 'session'`. In workspace mode, there is no terminal to follow — user is always in manual navigation.

**File operations:** All operations (upload, download, create, delete, rename, etc.) work identically in workspace mode. The only API parameter difference is `session` vs `workspace_id`.

**File watcher (SSE):** Not enabled in workspace mode. Manual refresh only.

### Pulse Logic

The "back to terminal CWD" button in FileManager toolbar pulses when the displayed directory does not belong to the focused terminal's workspace directory:

```ts
const isOutsideTerminalCwd =
  source?.type === 'workspace' ||
  (source?.type === 'session' && fmState.mode === 'manual')
```

- When pulsing: the button uses a CSS pulse/glow animation
- Click with active session: `resetFmToFollowing(sessionId)` — returns to terminal CWD, pulse stops
- Click without active session: no-op

### Sidebar Terminal Button (`frontend/src/components/Sidebar/Sidebar.tsx`)

Add a terminal icon button next to the collapse/sidebar-toggle button. Same behavior as the FileManager terminal button: pulses when outside terminal CWD, click returns FileManager to following mode (if a session is active).

## Interaction Matrix

| Action | FileManager Behavior | Button State |
|--------|---------------------|--------------|
| Click workspace (session focused) | Show workspace root | Pulse |
| Click workspace (no session) | Show workspace root | Pulse |
| Click same workspace again (collapse) | Clear (empty state) | — |
| Navigate within workspace dir | Stay, manual mode | Pulse |
| Click a session | Switch to session's previous FM state or terminal CWD | Depends on mode |
| Click pulse button (session active) | Back to terminal CWD | Pulse stops |
| Click pulse button (no session) | No-op | Pulse continues |

## Files Affected

| File | Change |
|------|--------|
| `src/api/files.rs` | Add `workspace_id` query param to `list_files` |
| `frontend/src/api/client.ts` | Refactor `listFilesBySession` → `listFiles` |
| `frontend/src/stores/appStore.ts` | No changes needed |
| `frontend/src/components/FileManager/FileManager.tsx` | `useFmSource()` hook, API adaptation, pulse logic |
| `frontend/src/components/Sidebar/Sidebar.tsx` | Terminal icon button next to collapse toggle |

## Non-Goals

- Persisting workspace browse position (every workspace click starts fresh at root)
- SSE file watching in workspace mode
