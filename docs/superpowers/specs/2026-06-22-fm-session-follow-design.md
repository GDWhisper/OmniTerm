# 文件管理器跟随终端 CWD 设计文档

> 状态：待实现
> 日期：2026-06-22
> 作者：Claude Code (brainstorming)

## 1. 背景与目标

### 当前问题

文件管理器 (FileManager) 的根目录锚定在 Workspace 的 `root_path`，所有文件操作都相对于这个路径。终端从同一个 `root_path` 启动，但用户可以 `cd` 到任何目录——此时文件管理器仍然停留在 workspace 根目录，无法反映终端的当前位置。

### 设计目标

1. **文件管理器跟随终端 CWD** — 当用户在终端中 `cd` 时，文件管理器自动切换到对应目录
2. **Workspace 降级为默认路径** — Workspace 的 `root_path` 仅在创建新 session 时作为初始 CWD，不再约束文件管理器的浏览范围
3. **双模式导航** — 支持"跟随模式"和"手动导航"，用户可以在文件管理器中独立浏览其他目录
4. **超出边界警告** — 当终端 CWD 超出原始 workspace root_path 时，显示视觉警告

## 2. 架构概览

```
┌─────────────┐     每 3s 轮询      ┌─────────────┐
│  FileManager │ ◄────────────────── │  REST API    │
│  (前端)      │                     │  /sessions/  │
│              │                     │  {id}/cwd    │
│  跟随模式:   │     GET /files      │              │
│  显示 CWD    │ ◄────────────────► │  /files      │
│  手动模式:   │  session={id}       │  ?session=   │
│  显示手动路径│                     │              │
└──────┬──────┘                     └──────┬───────┘
       │                                    │
       │ WebSocket (PTY)                    │ tmux display-message
       │                                    │ '#{pane_current_path}'
       ▼                                    ▼
┌─────────────┐                     ┌─────────────┐
│  xterm.js   │                     │  tmux pane   │
│  终端 UI     │                     │  (实时 CWD)  │
└─────────────┘                     └─────────────┘
```

## 3. 后端变更

### 3.1 新增 API：获取 session 实时 CWD

**端点：** `GET /api/v1/sessions/{id}/cwd`

**响应：**
```json
{
  "cwd": "/home/pax/projects/myapp"
}
```

**错误：**
- `404` — session 不存在或 tmux session 已关闭
- `500` — tmux 查询失败

**实现：** 复用已有的 `tmux::pane_cwd()` 函数（当前未使用），内部执行：
```
tmux display-message -p -t <session_name> '#{pane_current_path}'
```

### 3.2 修改文件列表 API

**当前：** `GET /api/v1/files?workspace={wid}&path={rel}`

**新增模式：** `GET /api/v1/files?session={sid}&path={rel}`

当传入 `session` 参数时：
1. 查询 tmux pane CWD 作为基准路径
2. `path` 为空或 `.` 时，返回 CWD 本身的内容
3. `path` 为相对路径时，基于 CWD 解析（如 `path=subdir` → `CWD/subdir`）
4. `path` 为绝对路径时（以 `/` 开头），直接使用该路径
5. 基础安全检查：不允许 `..` 越过文件系统根 `/`

**响应新增字段：**
```json
{
  "files": [...],
  "cwd": "/home/pax/projects/myapp",
  "is_outside_workspace": false
}
```

- `cwd` — 当前实际列出的目录（方便前端更新面包屑）
- `is_outside_workspace` — 当 CWD 不在 workspace root_path 内时为 `true`

### 3.3 安全模型调整

| 场景 | 当前行为 | 新行为 |
|------|---------|--------|
| FM 浏览 workspace 内 | ✅ 允许 | ✅ 允许 |
| FM 浏览 workspace 外 | ❌ sanitize_path 阻止 | ✅ 允许 + 警告 |
| FM 浏览 `/` 以上 | ❌ 不可能 | ❌ 基础安全检查阻止 |

`sanitize_path` 的职责从"限制在 workspace 内"降级为"防止路径遍历攻击"（即不允许 `..` 逃逸到 `/` 之上）。

### 3.4 修改 Workspace 的语义

Workspace 的 `root_path` 字段保留，但语义变为：
- **创建新 session 时的默认 CWD**（不变）
- **判断"是否超出边界"的参考线**（新增）
- **不再约束文件管理器的浏览范围**（移除）

## 4. 前端变更

### 4.1 appStore 新增状态

```typescript
// 每个 session 独立的 FM 状态
interface FmSessionState {
  mode: 'following' | 'manual'
  manualPath: string | null  // 手动模式下的绝对路径，null 表示跟随模式
}

// appStore 新增
fmSessionStates: Record<string, FmSessionState>

// Actions
setFmSessionMode: (sessionId: string, mode: 'following' | 'manual') => void
setFmManualPath: (sessionId: string, path: string | null) => void
resetFmToFollowing: (sessionId: string) => void  // home 按钮
```

**切换 session 时：** 从 `fmSessionStates` 恢复该 session 的状态。新 session 默认 `{ mode: 'following', manualPath: null }`。

### 4.2 FileManager 重构

#### 轮询逻辑

```typescript
const POLL_MS = 3000

// 跟随模式：每 3 秒查询 CWD + 文件列表
useEffect(() => {
  if (fmState.mode !== 'following' || !activeSessionId) return
  const id = setInterval(async () => {
    const { cwd, files, is_outside_workspace } = await api.listFilesBySession(activeSessionId, '.')
    setCwd(cwd)
    setFiles(files)
    setIsOutsideWorkspace(is_outside_workspace)
  }, POLL_MS)
  return () => clearInterval(id)
}, [fmState.mode, activeSessionId])
```

#### 手动导航

```typescript
const handleNavigateTo = (absolutePath: string) => {
  // 切换到手动模式，记录绝对路径
  store.setFmSessionMode(activeSessionId, 'manual')
  store.setFmManualPath(activeSessionId, absolutePath)
  // 立即加载该目录
  fetchFilesBySession(activeSessionId, absolutePath)
}
```

注意：`manualPath` 是绝对路径（如 `/home/pax/projects/myapp/src`），不再相对于 workspace root。

#### Home 按钮

```typescript
const handleHome = () => {
  store.resetFmToFollowing(activeSessionId)
  // 下一个轮询周期会自动切换到终端 CWD
}
```

#### 切换 Session

```typescript
useEffect(() => {
  // 切换 session 时，从 store 恢复 FM 状态
  const state = store.fmSessionStates[activeSessionId]
  if (state?.mode === 'manual' && state.manualPath) {
    fetchFilesBySession(activeSessionId, state.manualPath)
  }
  // following 模式会在下一个轮询周期自动更新
}, [activeSessionId])
```

### 4.3 UI 组件变更

#### 面包屑路径

当前面包屑基于 workspace root 的相对路径。新设计中：
- 跟随模式：显示终端的绝对 CWD 路径
- 手动模式：显示手动导航的绝对路径
- 路径段可点击导航

#### 警告指示器

当 `is_outside_workspace === true` 时，在面包屑路径旁显示警告图标：

- **图标：** stroke-based SVG，与 `icons.tsx` 风格一致
- **颜色：** `#f59e0b`（amber），需在 UI 风格规范中新增 `warning` 语义色
- **hover 效果：** tooltip 显示"当前目录超出 workspace 边界"
- **过渡动效：** `0.15s ease`（遵循规范）

#### Home 按钮

在 toolbar 中添加 Home 按钮（仅在手动模式下显示）：
- 图标：house SVG
- 点击：回到跟随模式
- 样式：遵循 toolbar button 规范（`accent-violet-10` hover 背景）

## 5. "当前 Session" 定义

**当前 session = 用户在终端面板中选中并正在查看/交互的 session**，即 Sidebar 中高亮的那个 session。

- 文件管理器始终跟随**当前 session** 的 CWD
- 后台可能有其他 session 在运行任务，FM 不跟随它们
- 用户在 Sidebar 中切换 session 时，FM 切换到新 session 的状态
- appStore 中的 `activeSessionId` 即为当前 session 的标识

## 6. 轮询控制策略

| 条件 | 是否轮询 |
|------|---------|
| 有活跃 session + FM 可见 + 跟随模式 | ✅ 每 3 秒 |
| 有活跃 session + FM 可见 + 手动模式 | ❌ 不轮询 CWD |
| 无活跃 session | ❌ 不轮询 |
| FM 面板被隐藏（移动端 tab 切走） | ❌ 不轮询 |

**性能考量：**
- `tmux display-message` 是轻量 IPC 调用，本地 < 1ms
- 目录列表（`ls`）通常 < 5ms
- 3 秒间隔 = 每分钟约 20 次调用，开销可忽略
- tmuxes 在 SSH/WSL（有网络延迟）上都用 3 秒间隔，本地无压力

## 7. 边界情况处理

| 场景 | 处理方式 |
|------|---------|
| tmux session 不存在/已关闭 | 返回 404，FM 显示空状态 + 提示"终端会话已断开" |
| CWD 路径不存在（被删除） | FM 显示"目录不存在"错误，保持上一次的文件列表 |
| 终端 CWD 变化极快（用户快速 cd） | 3 秒延迟可接受，FM 最终会同步 |
| 用户在手动模式下终端 cd 到同一目录 | 无影响，手动模式不跟随 |
| 切换到新 session（无历史状态） | 默认跟随模式 |
| Workspace 被删除 | session 一起被删除，FM 回到空状态 |

## 8. 文件操作行为

上传、创建、删除等文件操作在新模式下的行为：

| 操作 | 跟随模式 | 手动模式 |
|------|---------|---------|
| 上传文件 | 上传到终端当前 CWD | 上传到手动路径 |
| 创建文件夹 | 在终端当前 CWD 创建 | 在手动路径创建 |
| 删除/重命名 | 操作终端 CWD 内的文件 | 操作手动路径内的文件 |

实现方式：这些操作的后端 API 也需要支持 `session` 参数（与文件列表相同），后端根据 session 查询 CWD 或使用前端传入的绝对路径。

## 9. 文件 API 兼容性

新增 `session` 参数后，原有 `workspace` 参数仍然保留：

- `GET /api/v1/files?workspace={wid}&path={rel}` — 原有行为不变（基于 workspace root）
- `GET /api/v1/files?session={sid}&path={rel}` — 新增行为（基于 session CWD）
- 两者互斥，优先使用 `session` 参数

这确保了：
- 向后兼容（其他使用 workspace 的功能不受影响）
- 未来可以逐步迁移到 session-based 模式

## 10. UI 风格规范补充

需在 `docs/ui-style-guide.md` 中新增：

### Warning 语义色

```css
warning:     #f59e0b  /* amber-500 — 警告状态、超出边界 */
warning-12:  rgba(245, 158, 11, 0.12)  /* 警告背景 */
warning-glow: 0 0 6px rgba(245, 158, 11, 0.3)  /* 警告辉光 */
```

### 新增图标

在 `icons.tsx` 中添加：
- `WarningIcon` — 感叹号三角形，stroke-based
- `HomeIcon` — 房子图标，stroke-based

## 11. 变更文件清单

### 后端 (Rust)
- `src/api/sessions.rs` — 新增 `GET /sessions/{id}/cwd` 端点
- `src/api/files.rs` — 修改 `list_files` + 所有文件操作（upload/write/mkdir/delete/rename/move/copy）支持 `session` 参数
- `src/tmux/mod.rs` — 确认 `pane_cwd()` 函数可用
- `src/api/mod.rs` — 注册新路由

### 前端 (TypeScript)
- `frontend/src/stores/appStore.ts` — 新增 `fmSessionStates` 状态
- `frontend/src/components/FileManager/FileManager.tsx` — 重构为双模式 + 轮询
- `frontend/src/api/client.ts` — 新增 `getSessionCwd()` 和 `listFilesBySession()` 方法
- `frontend/src/components/FileManager/icons.tsx` — 新增 WarningIcon、HomeIcon
- `docs/ui-style-guide.md` — 新增 warning 语义色

## 12. 参考实现

tmuxes 项目的相同功能：
- `server/src/files.ts` — `getSessionCwd()` + `SESSION_DIRECTORY_SCRIPT`
- `client/src/components/FileExplorer.tsx` — 轮询 + 双模式
- 轮询间隔：3 秒
- 同步方式：REST API 轮询（非 WebSocket）
