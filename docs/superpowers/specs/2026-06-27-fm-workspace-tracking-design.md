# 文件管理器工作区跟踪

**日期:** 2026-06-27
**状态:** 设计中

## 概述

用户点击 Sidebar 中的工作区（无聚焦会话）时，FileManager 应展示工作区根目录，支持完整文件操作。有聚焦会话时，行为与现有一致（跟随终端 CWD）。"回到终端目录"按钮脉冲闪烁，提醒用户当前目录不在终端所在位置。

## 数据源优先级

```
activeSessionId → 跟随终端 CWD（现有行为）
    ↓ 为空
activeWorkspaceId → 展示工作区根目录
    ↓ 为空
空状态（无文件显示）
```

## 后端改动

### `GET /api/v1/files` — 新增 `workspace_id` 参数

**`src/api/files.rs`** — `list_files` 处理函数：

- `workspace_id` 与 `session` 互斥，只能传一个
- 传 `workspace_id` 时：
  - 从数据库按 id 查 workspace，获取其 `path`
  - 以 workspace `path` 为根目录（不走 tmux pane CWD）
  - `is_outside_workspace` 始终为 `false`（工作区根目录不会"在外面"）
- 两个都不传 → 返回 400

## 前端改动

### API Client (`frontend/src/api/client.ts`)

重命名 `listFilesBySession` → `listFiles`，参数改为 `{ session?, workspaceId? }`：

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

- `useFmSource()` 替代 FileManager 中所有直接读取 `activeSessionId` 的地方
- `source` 变化时（切换会话、切换工作区、折叠）自动重新获取文件列表

**fetchFiles 适配:**

- `source.type === 'session'` → 传 `session: id`（现有逻辑）
- `source.type === 'workspace'` → 传 `workspaceId: id`，路径用 `fmState.manualPath` 或根目录
- `source === null` → 清空文件列表，显示空状态

**跟随模式:** 仅在 `source.type === 'session'` 时生效。工作区模式下没有终端可跟随，用户始终处于手动导航模式。

**文件操作:** 所有操作（上传、下载、新建、删除、重命名等）在工作区模式下完全一致，唯一差别是 API 参数传 `session` 还是 `workspace_id`。

**文件监听（SSE）:** 工作区模式下不启用。仅支持手动刷新。

### 脉冲逻辑

FileManager 顶部的"回到终端目录"按钮，当显示目录不属于聚焦终端的 workspace 目录时脉冲闪烁：

```ts
const isOutsideTerminalCwd =
  source?.type === 'workspace' ||
  (source?.type === 'session' && fmState.mode === 'manual')
```

- 脉冲动画：复用 UI 规范 §6.4 的呼吸动画模式（与下载按钮 `fm-download-pulse` 一致）—— `accent-bright` 双层 box-shadow + 0.9–1.0s `ease-in-out` 呼吸，类名 `.fm-btn-terminal-active`
- 有活跃会话时点击：`resetFmToFollowing(sessionId)` → 回到终端 CWD，脉冲停止
- 无活跃会话时点击：无效果

### Sidebar 终端按钮 (`frontend/src/components/Sidebar/Sidebar.tsx`)

在折叠/侧边栏切换按钮旁新增一个终端图标按钮。行为与 FileManager 的终端按钮一致：脱离终端目录时脉冲，点击后回到跟随模式（需有活跃会话）。

## 交互矩阵

| 操作 | 文件管理器行为 | 按钮状态 |
|------|---------------|----------|
| 点工作区（有聚焦会话） | 展示工作区根目录 | 脉冲 |
| 点工作区（无聚焦会话） | 展示工作区根目录 | 脉冲 |
| 再点同一工作区（折叠） | 清空 | — |
| 工作区内手动导航 | 保持手动模式 | 脉冲 |
| 点会话 | 切换到该会话的上次状态或终端 CWD | 取决于模式 |
| 点脉冲按钮（有活跃会话） | 回到终端 CWD | 脉冲停止 |
| 点脉冲按钮（无活跃会话） | 无效果 | 继续脉冲 |

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/api/files.rs` | `list_files` 增加 `workspace_id` 查询参数 |
| `frontend/src/api/client.ts` | `listFilesBySession` 重构为 `listFiles` |
| `frontend/src/stores/appStore.ts` | 无需改动 |
| `frontend/src/components/FileManager/FileManager.tsx` | `useFmSource()` hook、API 适配、脉冲逻辑 |
| `frontend/src/components/Sidebar/Sidebar.tsx` | 折叠按钮旁新增终端图标按钮 |

## 不做

- 工作区浏览位置持久化（每次点工作区都从根目录重新开始）
- 工作区模式下的 SSE 文件监听
