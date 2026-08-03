# Sidebar.tsx 拆分实施计划（Phase 1 · P0）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 状态：设计稿（2026-08-03）
> 触发条件：`docs/dev/plans/2026-08-03-large-file-optimization.md` Phase 1（P0：Sidebar 拆分）
> 关联：`docs/architecture/frontend-patterns.md`（Section 拆分原则）、`docs/architecture/frontend.md` §Source Tree、AGENTS.md §6/§7

**Goal:** 将 2,618 行的 God Component `Sidebar.tsx` 拆为「列表渲染 + 状态提升」的主组件（≤800 行）与 13 个自带状态的子组件/模块，行为零变化。

**Architecture:** 每个 modal/dialog 拆为 `Sidebar/` 目录下独立子组件，自持表单与提交状态；跨切面数据（projects/worktrees/sessions 的 load 函数、修复/释放等编排）仍由 `Sidebar` 持有，通过回调 prop 下发。纯机械搬移优先，仅两处新写代码：`useDirBrowser` hook（消除两份目录浏览重复实现，AGENTS §7.1）与共享样式/行按钮模块。

**Tech Stack:** React 19 + TypeScript strict + zustand + vitest（无新依赖）。

## Global Constraints

- **不引入任何新依赖**（含 devDependencies）。
- **不改变任何视觉/交互行为**：纯结构重组；i18n key 一字不改（无 locale 文件变更）。
- 每个 Task 结束时质量门禁全绿：`pnpm exec tsc -b`、`pnpm exec vitest run`、`pnpm lint`（pre-commit hook 亦会拦截）。
- 每 Task 一个 commit，前缀 `refactor:`（提交信息用中文，遵循仓库现有风格）。
- 已注释掉的 "pending notification scheme decision" 死代码块（`AgentOnboardingBanner`、`handleHookEnable` 等）**原样保留在 Sidebar.tsx**，不搬不删（属另一决策范畴）。
- 所有 git 操作在本 worktree（`OmniTerm-dev`，dev 分支）内进行。

## 验证命令速查

```bash
cd frontend
pnpm exec tsc -b                              # 类型检查
pnpm exec vitest run src/components/Sidebar   # Sidebar 相关测试
pnpm exec vitest run                          # 全量测试
pnpm lint                                     # eslint
wc -l src/components/Sidebar/Sidebar.tsx      # 行数验收（Task 10，目标 ≤800）
```

## 文件结构（拆分决策在此固化）

**新建（13 个）**：

| 文件 | 职责 | 来源 |
|------|------|------|
| `frontend/src/hooks/useDirBrowser.ts` | 目录浏览共享 hook（entries/loading/error/notFound + loadDirs），统一 `fetchDirs` 与 `fetchRepairDirs` | 新写（合并 `Sidebar.tsx:375-421` 两份实现） |
| `frontend/src/hooks/useDirBrowser.test.ts` | `filterDirEntries` 纯函数单测 | 新写 |
| `frontend/src/components/Sidebar/sidebarModalStyles.ts` | `inputClass` / `inputStyle` 共享常量（5 个 modal 复用） | 搬自 `Sidebar.tsx:1104-1109` |
| `frontend/src/components/Sidebar/RowActionButtons.tsx` | `EditButton` / `DeleteButton` / `ReleaseButton` | 搬自 `Sidebar.tsx:2594-2664` |
| `frontend/src/components/Sidebar/RenameDialog.tsx` | 重命名（project/session 复用），自持 `renameName`/`submitting` | 搬自 `Sidebar.tsx:2181-2229` + `926-952` |
| `frontend/src/components/Sidebar/DeleteConfirmDialog.tsx` | 删除 project/session 确认，自持 `submitting` | 搬自 `Sidebar.tsx:2231-2245` + `968-1012` |
| `frontend/src/components/Sidebar/DeleteWorktreeDialog.tsx` | 删除 worktree 确认（含知悉勾选），自持 `checked`/`submitting` | 搬自 `Sidebar.tsx:2247-2292` + `757-780` |
| `frontend/src/components/Sidebar/ReleaseConfirmDialog.tsx` | 释放 ACP 进程确认（薄壳，release 逻辑留 Sidebar） | 搬自 `Sidebar.tsx:2294-2302` |
| `frontend/src/components/Sidebar/CreateSessionModal.tsx` | 创建会话，自持 `sessName`/`sessAgentId`/`submitting` | 搬自 `Sidebar.tsx:2030-2073` + `883-924` |
| `frontend/src/components/Sidebar/CreateWorktreeModal.tsx` | 创建 worktree + git init 确认（open-modal/submit-worktree 两模式），自持全部分支表单状态 | 搬自 `Sidebar.tsx:2075-2179` + `2304-2318` + `784-881` + `1344-1367`（+ 按钮内预检） |
| `frontend/src/components/Sidebar/CreateProjectModal.tsx` | 创建项目 + 目录浏览/自动补全 + 409 覆盖冲突子弹窗 | 搬自 `Sidebar.tsx:1869-2028` + `2514-2575` + `725-755` + `1038-1088` + `615-629` |
| `frontend/src/components/Sidebar/RepairPathDialog.tsx` | 修复项目路径，自持 repair 表单与浏览状态（用 `useDirBrowser`） | 搬自 `Sidebar.tsx:2320-2512` + `631-694` + `401-427` |
| `frontend/src/components/Sidebar/ExternalSessionsSection.tsx` | 外部 tmux 会话区（10s 轮询 + adopt 内联交互） | 搬自 `Sidebar.tsx:1629-1794` + `276-286` |
| `frontend/src/components/Sidebar/ProjectCard.tsx` | 单个项目卡片：项目头 + worktree 行 + 会话行（内含 `sessionsForWorktree`） | 搬自 `Sidebar.tsx:1287-1627` + `1111-1134` |

**修改**：`frontend/src/components/Sidebar/Sidebar.tsx`（逐 Task 瘦身）、`docs/architecture/frontend.md:32`、`docs/architecture/frontend-patterns.md`、`CHANGELOG.md`、`docs/dev/plans/2026-08-03-large-file-optimization.md`（Task 10）。

**明确不做**（翻盘条件见方向计划 D1）：
- 不抽 `useSidebarData` / agent_state 轮询 hook —— modal 外移后主文件已达标，无行数压力则不增实体（奥卡姆）。
- 不动 `index.css`、不改任何 CSS 类名、不动 store 结构。
- 不新增除 `useDirBrowser.test.ts` 外的测试文件 —— 现有 `Sidebar.test.tsx` 5 条用例全部经由 `<Sidebar />` 入口渲染，拆分后原样通过即为回归证据；被搬移代码非新写代码，不重复补测。

---

### Task 1: 共享基础层（useDirBrowser + 样式 + 行按钮）

**Files:**
- Create: `frontend/src/hooks/useDirBrowser.ts`
- Create: `frontend/src/hooks/useDirBrowser.test.ts`
- Create: `frontend/src/components/Sidebar/sidebarModalStyles.ts`
- Create: `frontend/src/components/Sidebar/RowActionButtons.tsx`
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`（`inputClass`/`inputStyle` 定义与 `EditButton`/`DeleteButton`/`ReleaseButton` 定义改为 import；此 Task 不删任何 JSX）

**Interfaces:**
- Consumes: `api.listDirs`、`ApiError`（`frontend/src/api/client.ts`）；`FileEntry` 类型
- Produces:
  - `useDirBrowser(): { entries: FileEntry[]; loading: boolean; error: string | null; notFound: boolean; loadDirs: (path: string, prefix?: string) => Promise<void>; reset: () => void }`（`reset` 为 Task 6 勘误 E2 追加）
  - `filterDirEntries(files: FileEntry[], prefix?: string): FileEntry[]`（纯函数，供单测）
  - `inputClass: string`、`inputStyle: React.CSSProperties`
  - `EditButton` / `DeleteButton` / `ReleaseButton`：`({ onClick }: { onClick: (e: React.MouseEvent) => void }) => JSX`

- [ ] **Step 1: 建立基线——全量测试通过**

```bash
cd frontend && pnpm exec vitest run && pnpm exec tsc -b
```
Expected: 全绿。若不绿，先停止排查（拆分必须在绿色基线上进行）。

- [ ] **Step 2: 写失败测试 `useDirBrowser.test.ts`**

项目现有 hook 测试惯例是测**纯函数**（参照 `src/hooks/useAcpChat.permission.test.ts`），不引入 testing-library。hook 的异步分支与 `fetchDirs` 现状逐字同源（搬移而非新写逻辑），由 Sidebar 测试兜底；此处只测过滤纯函数：

```typescript
import { describe, it, expect, vi } from 'vitest'

vi.mock('../api/client', () => ({
  api: { listDirs: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number
    body: unknown
    constructor(message: string, status: number, body?: unknown) {
      super(message)
      this.status = status
      this.body = body
    }
  },
}))

import { filterDirEntries } from './useDirBrowser'

const files = [
  { name: 'OmniTerm', path: '/home/OmniTerm', path_type: 'Dir', size: 0 },
  { name: 'omniterm-dev', path: '/home/omniterm-dev', path_type: 'Dir', size: 0 },
  { name: 'notes.txt', path: '/home/notes.txt', path_type: 'File', size: 10 },
  { name: 'link-dir', path: '/home/link-dir', path_type: 'SymlinkDir', size: 0 },
  { name: 'other', path: '/home/other', path_type: 'Dir', size: 0 },
] as never as Parameters<typeof filterDirEntries>[0]

describe('filterDirEntries', () => {
  it('keeps only directories and symlinked directories', () => {
    expect(filterDirEntries(files).map(f => f.name)).toEqual(['OmniTerm', 'omniterm-dev', 'link-dir', 'other'])
  })

  it('filters case-insensitively by prefix when given', () => {
    expect(filterDirEntries(files, 'om').map(f => f.name)).toEqual(['OmniTerm', 'omniterm-dev'])
  })

  it('returns empty array when nothing matches prefix', () => {
    expect(filterDirEntries(files, 'zzz')).toEqual([])
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd frontend && pnpm exec vitest run src/hooks/useDirBrowser.test.ts
```
Expected: FAIL（`./useDirBrowser` 不存在）。

- [ ] **Step 4: 实现 `useDirBrowser.ts`**

```typescript
import { useCallback, useState } from 'react'
import { api, ApiError, type FileEntry } from '../api/client'

/** 只保留目录与符号链接目录；给定 prefix 时按名称前缀（大小写不敏感）过滤。 */
export function filterDirEntries(files: FileEntry[], prefix?: string): FileEntry[] {
  let dirs = files.filter((f) => f.path_type === 'Dir' || f.path_type === 'SymlinkDir')
  if (prefix) {
    const lower = prefix.toLowerCase()
    dirs = dirs.filter((f) => f.name.toLowerCase().startsWith(lower))
  }
  return dirs
}

/**
 * 目录浏览共享状态（创建项目弹窗的自动补全与修复路径弹窗的浏览列表共用）。
 * 404 时 entries 置空且 notFound=true（创建项目弹窗显示「将自动创建」提示，
 * 修复弹窗忽略该标志照常显示空目录态——与拆分前两处实现行为一致）。
 */
export function useDirBrowser() {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  const loadDirs = useCallback(async (path: string, prefix?: string) => {
    setLoading(true)
    setError(null)
    setNotFound(false)
    try {
      const data = await api.listDirs(path)
      setEntries(filterDirEntries(data.files, prefix))
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 404) {
        setNotFound(true)
        setEntries([])
      } else {
        setError((e instanceof Error ? e.message : String(e)) || '无法访问该目录')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  return { entries, loading, error, notFound, loadDirs }
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd frontend && pnpm exec vitest run src/hooks/useDirBrowser.test.ts
```
Expected: 3 passed。

- [ ] **Step 6: 建 `sidebarModalStyles.ts`（逐字搬移）**

把 `Sidebar.tsx` 中 `const inputClass = ...` 与 `const inputStyle: React.CSSProperties = {...}`（约 `:1104-1109`）逐字移出为导出常量：

```typescript
import type React from 'react'

export const inputClass = "w-full px-3 py-2 text-sm focus:outline-none transition-all"
export const inputStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-strong)',
  color: 'var(--text-primary)',
}
```

`Sidebar.tsx` 中原定义处改为 `import { inputClass, inputStyle } from './sidebarModalStyles'`（本 Task 内 Sidebar 仍是唯一消费者）。

- [ ] **Step 7: 建 `RowActionButtons.tsx`（逐字搬移）**

把 `Sidebar.tsx` 底部 `EditButton`、`DeleteButton`、`ReleaseButton` 三个函数（约 `:2594-2664`）**逐字**移入新文件并导出；三者的 `useTranslation`、`IconPencil`/`IconTrash`/`IconPower` import 一并带过去。`Sidebar.tsx` 改为 `import { EditButton, DeleteButton, ReleaseButton } from './RowActionButtons'`。

- [ ] **Step 8: 全门禁验证**

```bash
cd frontend && pnpm exec tsc -b && pnpm exec vitest run && pnpm lint
```
Expected: 全绿。

- [ ] **Step 9: Commit**

```bash
git add frontend/src/hooks/useDirBrowser.ts frontend/src/hooks/useDirBrowser.test.ts \
  frontend/src/components/Sidebar/sidebarModalStyles.ts frontend/src/components/Sidebar/RowActionButtons.tsx \
  frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "refactor: 抽离 Sidebar 共享基础层（useDirBrowser/modal 样式/行按钮）"
```

---

### Task 2: RenameDialog

**Files:**
- Create: `frontend/src/components/Sidebar/RenameDialog.tsx`
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

**Interfaces:**
- Consumes: `sidebarModalStyles`（Task 1）；`api.updateProject` / `api.updateSession`；`useToastStore`
- Produces:
  ```tsx
  export interface RenameTarget { type: 'project' | 'session'; id: string; name: string }
  export function RenameDialog(props: {
    target: RenameTarget | null          // null = 关闭
    onClose: () => void
    onRenamed: (type: 'project' | 'session') => Promise<void>  // Sidebar 侧 loadProjects/loadSessions
  }): JSX
  ```

- [ ] **Step 1: 建 `RenameDialog.tsx`**

逐字搬移 Rename Modal 的 JSX（`Sidebar.tsx` 中 `{/* ── Rename Modal (Project or Session, reused) ── */}` 起的整个 `<Modal>...</Modal>`）与 `handleRename`/`handleRenameKeyDown` 逻辑，改造点仅：
- 组件内本地状态：`renameName`、`submitting`（原 Sidebar 的共享 `submitting` 在此独立化，行为不变——同一时刻只有一个弹窗在提交）。
- `open={target !== null}`；`onClose` 时额外 `setRenameName('')`（对齐原 `setRenameOpen(false); setRenameTarget(null); setRenameName('')`）。
- `handleRename` 中 `loadProjects()`/`loadSessions()` 替换为 `await props.onRenamed(renameTarget.type)`；成功后 `props.onClose()`。
- 目标对象在提交中不会变 null，原 `renameTarget?.` 可选链写法保留即可。

Sidebar 侧：
- 删除 `renameOpen`、`renameName` 状态与 `handleRename`、`handleRenameKeyDown`、`renameTarget` 类型内联声明（改用 import 的 `RenameTarget`）。
- `renameTarget` 状态保留在 Sidebar（项目头/会话行的编辑按钮写入）。
- 原 JSX 位置替换为：
  ```tsx
  <RenameDialog
    target={renameTarget}
    onClose={() => setRenameTarget(null)}
    onRenamed={(type) => (type === 'project' ? loadProjects() : loadSessions())}
  />
  ```
- 行内编辑按钮回调简化为 `setRenameTarget({ type: 'project', id: proj.id, name: proj.name })`（删去伴随的 `setRenameName`/`setRenameOpen` 调用）。

- [ ] **Step 2: 门禁验证**

```bash
cd frontend && pnpm exec tsc -b && pnpm exec vitest run src/components/Sidebar && pnpm lint
```
Expected: 全绿。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Sidebar/RenameDialog.tsx frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "refactor: 拆出 RenameDialog 子组件（自持表单状态）"
```

---

### Task 3: 删除/释放确认对话框组（DeleteConfirm / DeleteWorktree / ReleaseConfirm）

**Files:**
- Create: `frontend/src/components/Sidebar/DeleteConfirmDialog.tsx`
- Create: `frontend/src/components/Sidebar/DeleteWorktreeDialog.tsx`
- Create: `frontend/src/components/Sidebar/ReleaseConfirmDialog.tsx`
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

**Interfaces:**
- Consumes: `api.deleteProject` / `api.deleteSession` / `api.deleteWorktree`；`useAppStore`（`setActiveProject`/`setActiveWorkspace`/`setActiveSession`/`setSessions`/`workspaceSessionMemory`/`clearWorkspaceSession`/`worktrees`/`activeWorkspaceId`/`activeProjectId`/`activeSessionId`）；`useChatStore`（markEnded）
- Produces:
  ```tsx
  export interface DeleteTarget { type: 'project' | 'session'; id: string; name: string }
  export function DeleteConfirmDialog(props: {
    target: DeleteTarget | null
    onClose: () => void
    reloadProjects: () => Promise<void>
    reloadSessions: () => Promise<void>
  }): JSX

  export interface DeleteWorktreeTarget { projectId: string; path: string; label: string }
  export function DeleteWorktreeDialog(props: {
    target: DeleteWorktreeTarget | null
    onClose: () => void
    reloadWorktrees: (projectId: string) => Promise<void>
  }): JSX

  export interface ReleaseTarget { id: string; name: string | null }
  export function ReleaseConfirmDialog(props: {
    target: ReleaseTarget | null
    onClose: () => void
    onRelease: (id: string) => Promise<void>   // Sidebar 的 releaseSessionNow
  }): JSX
  ```

- [ ] **Step 1: 建 `DeleteConfirmDialog.tsx`**

逐字搬移 `{/* ── Delete Confirmation Dialog ── */}` 的 `<ConfirmDialog>` JSX 与 `handleDeleteProject`/`handleDeleteSession`（约 `:968-1012`）。改造点：
- 自持 `submitting`。
- store 操作（删项目后清 active 三件套与 `setSessions(id, [])`；删会话前先清 `activeSessionId`、删后清 `workspaceSessionMemory`）在组件内经 `useAppStore` 完成——选择器与 Sidebar 现状一致。
- 刷新改为 `await props.reloadProjects()` / `await props.reloadSessions()`；结束 `props.onClose()`（等价原 `setConfirmDelete(null)`）。
- `onConfirm={target.type === 'project' ? handleDeleteProject : handleDeleteSession}` 逻辑保留。

- [ ] **Step 2: 建 `DeleteWorktreeDialog.tsx`**

逐字搬移 `{/* ── Delete Worktree Confirmation Dialog ── */}` 的 `<Modal>` JSX 与 `handleDeleteWorktree`（约 `:757-780`）。改造点：
- 自持 `checked`（原 `confirmDeleteWtChecked`）与 `submitting`；关闭时 `setChecked(false)`。
- 删除成功后「若被删的是当前 workspace 则清选中」逻辑用 `useAppStore` 读取 `worktrees[projectId]`/`activeWorkspaceId`（与原实现逐字一致，仅数据源从闭包改为 store 选择器）。
- 刷新 `await props.reloadWorktrees(target.projectId)`。

- [ ] **Step 3: 建 `ReleaseConfirmDialog.tsx`**

薄壳：逐字搬移 `{/* ── Release Confirmation Dialog ── */}` 的 `<ConfirmDialog>`，`onConfirm` 调 `props.onRelease(target.id)` 后 `props.onClose()`。**release 主逻辑保留在 Sidebar**（见 Step 4）。

- [ ] **Step 4: Sidebar 侧收敛**

- 删除状态：`confirmDeleteWtChecked`；删除函数：`handleDeleteProject`、`handleDeleteSession`、`handleDeleteWorktree`、`handleConfirmRelease`。
- `handleReleaseSession` 原地重命名为 `releaseSessionNow`（逻辑不变：`api.releaseSession` → `loadSessions()` → 若为当前会话 `useChatStore.getState().markEnded(id)` → toast），后续 Task 9 的 ProjectCard 与 ReleaseConfirmDialog 共用。
- 三个弹窗挂载点替换为 Step 3 的签名调用（`onClose` 分别为 `setConfirmDelete(null)` / `setConfirmDeleteWt(null)` / `setConfirmRelease(null)`）。
- 行内触发回调（项目/会话 DeleteButton、worktree 删除按钮、ReleaseButton）只保留 `setConfirmDelete(...)` / `setConfirmDeleteWt(...)` / 释放判断（释放判断在 Task 9 随 ProjectCard 迁走，本 Task 不动）。

- [ ] **Step 5: 门禁验证**

```bash
cd frontend && pnpm exec tsc -b && pnpm exec vitest run src/components/Sidebar && pnpm lint
```
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Sidebar/DeleteConfirmDialog.tsx \
  frontend/src/components/Sidebar/DeleteWorktreeDialog.tsx \
  frontend/src/components/Sidebar/ReleaseConfirmDialog.tsx \
  frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "refactor: 拆出删除/释放确认对话框组（DeleteConfirm/DeleteWorktree/ReleaseConfirm）"
```

---

### Task 4: CreateSessionModal

**Files:**
- Create: `frontend/src/components/Sidebar/CreateSessionModal.tsx`
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

**Interfaces:**
- Consumes: `sidebarModalStyles`；`AgentPicker`；`useAgentStore`（命名生成）；`useAppStore`（`activeProjectId`/`worktrees`/`activateSession`/`multiplexer`）；`api.createSession`
- Produces:
  ```tsx
  export function CreateSessionModal(props: {
    workspaceId: string | null           // null = 关闭；即原 createSessOpen + sessWorkspaceId 合一
    onClose: () => void
    reloadSessions: () => Promise<void>
  }): JSX
  ```

- [ ] **Step 1: 建 `CreateSessionModal.tsx`**

逐字搬移 `{/* ── Create Session Modal ── */}` 的 `<Modal>` JSX 与 `handleCreateSession`/`handleSessKeyDown`（约 `:883-924`、`1090-1095`）。改造点：
- 自持 `sessName`、`sessAgentId`、`submitting`。
- `open={workspaceId !== null}`；原 `sessWorkspaceId` 由 prop `workspaceId` 取代。
- `activeProjectId`、`worktrees`、`activateSession`、`multiplexer`（hint 文案用）经 `useAppStore` 选择器读取——`multiplexer` 不再需要 prop 传递。
- 成功路径：`await props.reloadSessions()` → `activateSession(newSession.id)` → toast → `props.onClose()`（等价原 `setCreateSessOpen(false)` + 清空三状态；清空动作移入 `onClose` 的组件内实现）。

- [ ] **Step 2: Sidebar 侧收敛**

- 删除状态：`createSessOpen`、`sessName`、`sessAgentId`、`sessWorkspaceId`；删除 `handleCreateSession`、`handleSessKeyDown`。
- 新增 `const [createSessWorkspaceId, setCreateSessWorkspaceId] = useState<string | null>(null)`。
- worktree 行「+」按钮回调（`Sidebar.tsx` 中 `sidebar-wt-add-btn` 创建会话处）简化为：
  ```tsx
  setActiveProject(proj.id)
  setActiveWorkspace(wt.id)
  setCreateSessWorkspaceId(wt.id)
  ```
- 挂载点：
  ```tsx
  <CreateSessionModal
    workspaceId={createSessWorkspaceId}
    onClose={() => setCreateSessWorkspaceId(null)}
    reloadSessions={loadSessions}
  />
  ```

- [ ] **Step 3: 门禁验证（含既有两条 createSession 用例）**

```bash
cd frontend && pnpm exec tsc -b && pnpm exec vitest run src/components/Sidebar && pnpm lint
```
Expected: 全绿。`Sidebar.test.tsx` 的 "creates session..." 两条用例经由 portal 操作弹窗，必须原样通过——这是本 Task 的回归证据。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Sidebar/CreateSessionModal.tsx frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "refactor: 拆出 CreateSessionModal 子组件（自持表单状态）"
```

---

### Task 5: CreateWorktreeModal（含 git init 确认流）

**Files:**
- Create: `frontend/src/components/Sidebar/CreateWorktreeModal.tsx`
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

**Interfaces:**
- Consumes: `sidebarModalStyles`；`api.listBranches` / `api.createWorktree` / `api.initGit`；`ApiError`；`useAppStore`（`projects`，用于 submit 失败时取项目名与路径占位）
- Produces:
  ```tsx
  export function CreateWorktreeModal(props: {
    projectId: string | null             // null = 关闭
    onClose: () => void
    reloadWorktrees: (projectId: string) => Promise<void>
  }): JSX
  ```

- [ ] **Step 1: 建 `CreateWorktreeModal.tsx`**

逐字搬移：Create Worktree `<Modal>` JSX（`{/* ── Create Worktree Modal ── */}` 块）、Git Init `<ConfirmDialog>`（`{/* ── Git Init Confirmation ... */}` 块）、`submitWorktree`/`handleCreateWorktree`/`handleConfirmGitInit`（约 `:784-881`），以及项目头「+」按钮内的分支预检逻辑（约 `:1344-1367`）。改造为三段式内部状态机：

```tsx
type Phase = 'loading-branches' | 'form' | 'git-init-confirm'
```

- 自持状态：`phase`、`branch`、`path`、`baseBranch`、`branches`、`currentBranch`、`branchesLoading`、`gitInitConfirm`（原类型定义逐字保留：`mode`/`hasGitignore`/`params`）、`submitting`。
- `useEffect(() => { if (projectId) open(projectId) }, [projectId])`：`open()` 即原「+」按钮回调中 `setCreateWtBranchesLoading(true)` 之后的部分——`api.listBranches` 成功 → 填充分支 → `phase='form'`；`not_a_git_repo` → `phase='git-init-confirm'`（mode='open-modal'）；其他错误 → 照常 `phase='form'`。
- 渲染：`<Modal open={projectId !== null && (phase === 'form' || (phase === 'git-init-confirm' && gitInitConfirm?.mode === 'submit-worktree'))} ...>` + `<ConfirmDialog open={projectId !== null && phase === 'git-init-confirm'} ...>`——**loading-branches 阶段两者都不出现**（与现状「预检完成才开弹窗」逐帧一致）；**submit-worktree 模式下表单 Modal 保持挂载、ConfirmDialog 叠加其上**（与原实现一致：Esc 关闭全部、取消返回带值表单、无重挂载动画，见文末勘误 E1）。
- `handleConfirmGitInit`：open-modal 分支成功后改为置 `phase='form'`（分支已在重新加载后填充）；submit-worktree 分支成功 → `props.onClose()`；initGit 失败保持当前 phase（与原「弹框不关」一致）。
- `submitWorktree` 成功 → `await props.reloadWorktrees(projectId)` → toast → `props.onClose()`。
- `props.projectId` 变 null 时重置全部内部状态（`useEffect` 清理或下一次 open 时重置均可，保证重开同一项目状态干净）。
- 路径占位符里 `projects.find(p => p.id === createWtProjectId)` 改为 `projects.find(p => p.id === projectId)`。

- [ ] **Step 2: Sidebar 侧收敛**

- 删除状态：`createWtOpen`、`createWtBranch`、`createWtPath`、`createWtBaseBranch`、`createWtBranches`、`createWtCurrentBranch`、`createWtBranchesLoading`、`gitInitConfirm`；删除 `submitWorktree`/`handleCreateWorktree`/`handleConfirmGitInit`。
- `createWtProjectId` 保留（string | null，兼作开关）。
- 项目头「+」按钮回调简化为（展开逻辑保留在 Sidebar）：
  ```tsx
  onClick={async (e) => {
    e.stopPropagation()
    if (!isExpanded) {
      setExpandedProjects(prev => { const next = new Set(prev); next.add(proj.id); return next })
      await Promise.all([loadWorktrees(proj.id), loadSessions(proj.id)])
    }
    setCreateWtProjectId(proj.id)
  }}
  ```
- 挂载点：
  ```tsx
  <CreateWorktreeModal
    projectId={createWtProjectId}
    onClose={() => setCreateWtProjectId(null)}
    reloadWorktrees={loadWorktrees}
  />
  ```

- [ ] **Step 3: 门禁验证（含既有两条 git-init 用例）**

```bash
cd frontend && pnpm exec tsc -b && pnpm exec vitest run src/components/Sidebar && pnpm lint
```
Expected: 全绿。`Sidebar.test.tsx` 的 "非 git 仓库...initGit" 与 ".gitignore 警告" 两条用例是本 Task 的回归证据（点击「+」→ body 出现 'Initialize Git Repository?'）。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Sidebar/CreateWorktreeModal.tsx frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "refactor: 拆出 CreateWorktreeModal（含 git init 确认流状态机）"
```

---

### Task 6: CreateProjectModal（目录浏览 + 自动补全 + 409 冲突）

**Files:**
- Create: `frontend/src/components/Sidebar/CreateProjectModal.tsx`
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

**Interfaces:**
- Consumes: `useDirBrowser`（Task 1）；`sidebarModalStyles`；`getParentPath`；`api.createProject`；`useAppStore`（cover-conflict 切换用 `setActiveProject`/`setActiveWorkspace`）；homeDir 经 prop 传入（Sidebar 的 `api.systemInfo()` effect 仍持有）
- Produces:
  ```tsx
  export function CreateProjectModal(props: {
    open: boolean
    homeDir: string
    onClose: () => void
    reloadProjects: () => Promise<void>
  }): JSX
  ```

- [ ] **Step 1: 建 `CreateProjectModal.tsx`**

逐字搬移：Create Project `<Modal>` JSX（`{/* ── Create Project Modal ── */}` 块）、Cover-Conflict `<Modal>`（`{/* ── Cover-Conflict Modal ... */}` 块）、`handleCreateProject`（约 `:725-755`）、`handleNameKeyDown`/`handlePathKeyDown`/`completAutocomplete`（约 `:1038-1088`）、browse 三 handler `handleEnterDir`/`handleGoUp`/`handleRefresh`（约 `:616-629`）、`closeCreateProj`（约 `:573-582`）。改造点：
- 自持状态：`projName`、`projPath`、`autocompleteActiveIndex`、`autocompleteTimerRef`、`coverConflict`、`submitting`；浏览状态改用 `const { entries, loading, error, notFound, loadDirs } = useDirBrowser()`（`browseEntries→entries` 等标识符随之替换，`fetchDirs` 调用改 `loadDirs`）。
- 原「打开时重置 browse」effect（约 `:563-570`）逐字搬入，条件改 `if (open && homeDir)`。
- 原防抖自动补全 effect（约 `:431-454`）逐字搬入，依赖不变。
- `handleCreateProject` 成功路径 `loadProjects()` → `await props.reloadProjects()`；409 already_covered 分支逐字保留（`setCoverConflict`）。
- Cover-conflict 的 "Switch to existing" 按钮内 `setActiveProject`/`setActiveWorkspace` 经 `useAppStore` 选择器；`setCreateProjOpen(false)` 等关闭动作改为组件内 `props.onClose()` + 本地清空。
- `closeCreateProj` 中 `setProjPath(homeDir + '/')` 保留（homeDir 来自 prop）。

- [ ] **Step 2: Sidebar 侧收敛**

- 删除状态：`projName`、`projPath`、`browsePath`、`browseEntries`、`browseLoading`、`browseError`、`browseNotFound`、`autocompleteActiveIndex`、`autocompleteTimerRef`、`coverConflict`；删除 `fetchDirs`、自动补全 effect、browse 三 handler、`closeCreateProj`、`handleCreateProject`、`handleNameKeyDown`、`handlePathKeyDown`、`completAutocomplete`。
- `homeDir` 状态与 `api.systemInfo()` effect 保留在 Sidebar，但该 effect 删除 `setProjPath(info.home_dir)` 一行（projPath 已归 modal 管；`setHomeDir` 与 `setMultiplexer` 保留）。
- 挂载点：
  ```tsx
  <CreateProjectModal
    open={createProjOpen}
    homeDir={homeDir}
    onClose={() => setCreateProjOpen(false)}
    reloadProjects={loadProjects}
  />
  ```
  （`createProjOpen` 保留在 Sidebar，项目区标题栏「+」按钮写入。）

- [ ] **Step 3: 门禁验证**

```bash
cd frontend && pnpm exec tsc -b && pnpm exec vitest run src/components/Sidebar && pnpm lint
```
Expected: 全绿。

- [ ] **Step 4: 手动冒烟（目录浏览是交互密集区）**

`./dev.sh start` 后在浏览器验证：创建项目弹窗打开时路径预填 `homeDir/`、输入路径 200ms 后出补全、Tab/方向键/Enter 导航、进入/上级/空目录/404「将自动创建」四态、重名路径触发 409 冲突弹窗且「切换到已有项目」可用。完成后 `./dev.sh stop`。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Sidebar/CreateProjectModal.tsx frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "refactor: 拆出 CreateProjectModal（目录浏览改用 useDirBrowser，含 409 冲突子弹窗）"
```

---

### Task 7: RepairPathDialog

**Files:**
- Create: `frontend/src/components/Sidebar/RepairPathDialog.tsx`
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

**Interfaces:**
- Consumes: `useDirBrowser`；`sidebarModalStyles`；`getParentPath`；`api.updateProject`；`useAppStore`（修复成功后 `setActiveProject`/`setActiveWorkspace`/`setActiveSession`）
- Produces:
  ```tsx
  export interface RepairTarget { project: Project; workspace: Workspace; oldPath: string }
  export function RepairPathDialog(props: {
    target: RepairTarget | null          // null = 关闭；合并原 repairDialogOpen + repairProject
    onClose: () => void
    onRepaired: (projectId: string) => Promise<void>  // Sidebar: Promise.all([loadProjects, loadWorktrees, loadSessions])
  }): JSX
  ```

- [ ] **Step 1: 建 `RepairPathDialog.tsx`**

逐字搬移 Repair `<Modal>` JSX（`{/* ── Repair Project Path Modal ... */}` 块）与 `handleRepairEnterDir`/`handleRepairGoUp`/`handleRepairPathApply`/`handleRepairRefresh`/`handleRepairUpdate`/`openRepairDialog`/`closeRepairDialog`（约 `:631-694`）。改造点：
- 自持状态：`repairPath`、`repairBrowsePath`、`repairSubmitting`；浏览状态改用 `useDirBrowser()`（原 `fetchRepairDirs` 删除；`repairBrowseEntries/Loading/Error` → hook 返回值；404 时 hook 置 `notFound=true` 且 entries 为空，本弹窗渲染不读 `notFound`，与现状空目录态一致）。
- 原 `repairBrowsePath` 变更自动拉取 effect（约 `:424-427`）逐字搬入。
- 打开初始化（原 `openRepairDialog` 逻辑）移入组件内 `useEffect(() => { if (target) {...} }, [target])`：`setRepairPath('')`、`setRepairBrowsePath(target.oldPath ? getParentPath(target.oldPath) : '')`。
- `handleRepairUpdate`：`api.updateProject` → toast → `await props.onRepaired(target.project.id)` → store 激活三件套（`setActiveProject`/`setActiveSession(null)`/`setActiveWorkspace`，经 `useAppStore`）→ `props.onClose()`。

- [ ] **Step 2: Sidebar 侧收敛**

- 删除状态：`repairDialogOpen`、`repairProject`、`repairPath`、`repairBrowsePath`、`repairBrowseEntries`、`repairBrowseLoading`、`repairBrowseError`、`repairSubmitting`；删除 `fetchRepairDirs`、自动拉取 effect、全部 repair handler。
- 新增 `const [repairTarget, setRepairTarget] = useState<RepairTarget | null>(null)`；`handleWorkspaceClick` 中 `openRepairDialog(proj, wt, proj.path)` 改为 `setRepairTarget({ project: proj, workspace: wt, oldPath: proj.path })`。
- 挂载点：
  ```tsx
  <RepairPathDialog
    target={repairTarget}
    onClose={() => setRepairTarget(null)}
    onRepaired={(pid) => Promise.all([loadProjects(), loadWorktrees(pid), loadSessions(pid)]).then(() => {})}
  />
  ```

- [ ] **Step 3: 门禁验证**

```bash
cd frontend && pnpm exec tsc -b && pnpm exec vitest run src/components/Sidebar && pnpm lint
```
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Sidebar/RepairPathDialog.tsx frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "refactor: 拆出 RepairPathDialog（目录浏览改用 useDirBrowser）"
```

---

### Task 8: ExternalSessionsSection

**Files:**
- Create: `frontend/src/components/Sidebar/ExternalSessionsSection.tsx`
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

**Interfaces:**
- Consumes: `api.listExternalSessions` / `api.adoptSession`；`useAppStore`（`projects`/`activeProjectId`/`activeExternalSession`/`setActiveSession`/`setActiveExternalSession`）；`READER_FONT`
- Produces:
  ```tsx
  export function ExternalSessionsSection(props: {
    reloadSessions: (projectId?: string) => Promise<void>
  }): JSX   // 内部：无外部会话时返回 null（原 JSX 即条件渲染）
  ```

- [ ] **Step 1: 建 `ExternalSessionsSection.tsx`**

逐字搬移 External Sessions 整段 JSX（`{/* External Sessions — ... */}` 块，约 `:1629-1794`）与 10s 轮询 effect（约 `:276-286`）。改造点：
- 自持状态：`externalSessions`、`externalExpanded`、`adoptTarget`、`adoptProjectId`。
- store 数据（projects / activeProjectId / activeExternalSession / setActiveSession / setActiveExternalSession）经 `useAppStore` 选择器读取。
- adopt 成功回调中 `loadSessions(adoptProjectId)` 改为 `props.reloadSessions(adoptProjectId)`；`setExternalSessions` 过滤、toast 逻辑逐字保留。

- [ ] **Step 2: Sidebar 侧收敛**

- 删除四个状态与轮询 effect；在原 JSX 位置替换为 `<ExternalSessionsSection reloadSessions={loadSessions} />`（组件自带 `externalSessions.length > 0` 判断，无需外层条件）。
- 清理 Sidebar 中随之不再使用的 `ExternalSession` 类型 import。

- [ ] **Step 3: 门禁验证**

```bash
cd frontend && pnpm exec tsc -b && pnpm exec vitest run src/components/Sidebar && pnpm lint
```
Expected: 全绿。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Sidebar/ExternalSessionsSection.tsx frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "refactor: 拆出 ExternalSessionsSection（外部会话轮询与 adopt 交互）"
```

---

### Task 9: ProjectCard（项目树渲染外移）

**Files:**
- Create: `frontend/src/components/Sidebar/ProjectCard.tsx`
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

**Interfaces:**
- Consumes: `RowActionButtons`（Task 1）；`aggregateStatus` / `AcpActivity`；`useAttention`（context hook，子组件可直接调用；测试中被全局 mock，无碍）；`useAppStore`（`activateSession`/`pixelAnimationsEnabled`）；`useChatStore`（释放前置检查）；`CountBadge`/`GitBranchSprite`/`FolderSprite` 等像素组件
- Produces:
  ```tsx
  export function ProjectCard(props: {
    project: Project
    isExpanded: boolean
    worktrees: Workspace[] | undefined    // undefined = 尚未加载（显示 loading 占位）
    sessions: Session[]                   // 该项目全部会话
    activeWorkspaceId: string | null
    activeSessionId: string | null
    acpActivityFor: (sessionId: string) => AcpActivity | undefined
    onToggle: () => void
    onOpenCreateWorktree: () => void
    onRename: (target: RenameTarget) => void
    onDeleteProject: () => void
    onWorkspaceClick: (wt: Workspace) => void
    onOpenCreateSession: (wt: Workspace) => void
    onDeleteWorktree: (target: DeleteWorktreeTarget) => void
    onDeleteSession: (target: DeleteTarget) => void
    onReleaseRequest: (session: Session) => void
  }): JSX
  ```

- [ ] **Step 1: 建 `ProjectCard.tsx`**

逐字搬移 `projects.map((proj) => {...})` 内的整棵项目卡片 JSX（约 `:1298-1625`，`sidebar-project-card` 起止）与 `sessionsForWorktree`（约 `:1111-1134`，作为本文件模块级纯函数）。改造点：
- 标识符映射：`proj→props.project`、`wtList→props.worktrees || []`、`wtLoaded→props.worktrees !== undefined`、`isExpanded→props.isExpanded`、`sessionsForWorktree(proj.id, wt.path)→sessionsForWorktree(props.sessions, props.worktrees || [], wt.path)`（函数签名相应改为数据入参）。
- `attention` 在组件内 `useAttention()`；`pixelAnimationsEnabled`、`activateSession` 经 `useAppStore` 选择器；会话点击回调内联 `activateSession(s.id); attention.setActive(sessionKey)`（与现状逐字一致）。
- 各按钮回调改为 prop 调用：项目头点击 `onToggle()`；项目头「+」`onOpenCreateWorktree()`（展开兜底逻辑留在 Sidebar 的回调实现里）；`EditButton→onRename({ type:'project', ... })`；`DeleteButton→onDeleteProject()`；worktree 行点击 `onWorkspaceClick(wt)`；会话「+」`onOpenCreateSession(wt)`；worktree 删除 `onDeleteWorktree({ projectId, path, label })`；会话编辑/删除 `onRename`/`onDeleteSession`；Release 按钮 `onReleaseRequest(s)`。
- `acpActivityFor` 用 prop（Sidebar 的 useShallow 单一订阅，避免每个卡片重复派生）。

- [ ] **Step 2: Sidebar 侧收敛**

- `projects.map` 体替换为：
  ```tsx
  projects.map((proj) => (
    <ProjectCard
      key={proj.id}
      project={proj}
      isExpanded={expandedProjects.has(proj.id)}
      worktrees={worktrees[proj.id]}
      sessions={sessions[proj.id] || []}
      activeWorkspaceId={activeWorkspaceId}
      activeSessionId={activeSessionId}
      acpActivityFor={acpActivityFor}
      onToggle={() => toggleProject(proj.id)}
      onOpenCreateWorktree={async () => {
        if (!expandedProjects.has(proj.id)) {
          setExpandedProjects(prev => { const next = new Set(prev); next.add(proj.id); return next })
          await Promise.all([loadWorktrees(proj.id), loadSessions(proj.id)])
        }
        setCreateWtProjectId(proj.id)
      }}
      onRename={setRenameTarget}
      onDeleteProject={() => setConfirmDelete({ type: 'project', id: proj.id, name: proj.name })}
      onWorkspaceClick={(wt) => handleWorkspaceClick(proj, wt)}
      onOpenCreateSession={(wt) => {
        setActiveProject(proj.id)
        setActiveWorkspace(wt.id)
        setCreateSessWorkspaceId(wt.id)
      }}
      onDeleteWorktree={setConfirmDeleteWt}
      onDeleteSession={setConfirmDelete}
      onReleaseRequest={(s) => {
        const chatState = useChatStore.getState().states[s.id]
        if (chatState?.sending) setConfirmRelease({ id: s.id, name: s.name ?? null })
        else releaseSessionNow(s.id)
      }}
    />
  ))
  ```
- 清理 Sidebar 不再使用的 import（`aggregateStatus`、`CountBadge`、`GitBranchSprite`、`FolderSprite`、`EditButton`/`DeleteButton`/`ReleaseButton` 等，以 `tsc -b` 与 lint 为准）。

- [ ] **Step 3: 门禁验证（全量）**

```bash
cd frontend && pnpm exec tsc -b && pnpm exec vitest run && pnpm lint
```
Expected: 全绿（此处跑全量测试——ProjectCard 承载全部列表渲染，影响面最大）。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Sidebar/ProjectCard.tsx frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "refactor: 拆出 ProjectCard（项目/worktree/会话三层渲染外移）"
```

---

### Task 10: 验收、文档闭环与计划状态推进

**Files:**
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`（仅清理：确认无残留未用 import/状态）
- Modify: `docs/architecture/frontend.md:32`
- Modify: `docs/architecture/frontend-patterns.md`
- Modify: `CHANGELOG.md`（`[Unreleased]` 或最新版本段 `Refactored` 分类）
- Modify: `docs/dev/plans/2026-08-03-large-file-optimization.md`（状态推进 + 验收勾选）

**Interfaces:**
- Consumes: Task 1-9 全部产出
- Produces: 验收结论与文档更新

- [ ] **Step 1: 行数验收**

```bash
wc -l frontend/src/components/Sidebar/Sidebar.tsx
```
Expected: ≤800 行。若超出：优先检查是否有搬移残留（未删的注释块/空行堆积）；确属结构性超标再评估是否外移 agent_state 轮询（方向计划 D1 翻盘条件），并在本计划追加勘误块。

- [ ] **Step 2: 全量门禁**

```bash
cd frontend && pnpm exec tsc -b && pnpm exec vitest run && pnpm lint
```
Expected: 全绿，零新增违规。

- [ ] **Step 3: 手动回归（对照 `docs/reference/user-testing.md`）**

`./dev.sh start` 后逐项验证（方向计划验收标准第二条）：
1. 创建项目：重名 409 → 冲突弹窗；不存在路径 → 「将自动创建」提示并可创建
2. 创建会话：tmux 与 ACP agent 两种选择；创建后终端面板自动切换
3. 创建 worktree：正常分支；非 git 仓库 → git init 确认（含无 .gitignore 附加警告）→ 初始化后表单出现
4. 重命名项目/会话；删除项目/会话/worktree（勾选知悉才可删）
5. 修复路径：点击不存在路径的 workspace → 修复弹窗 → 更新后自动激活
6. 外部会话：出现/adopt 到项目；释放 ACP 会话（发送中 → 确认框，空闲 → 直接释放）
7. 重复项目 banner → 合并对话框；侧栏折叠/展开；连接状态徽标
完成后 `./dev.sh stop`。

- [ ] **Step 4: 更新 `docs/architecture/frontend.md:32`**

将 Source Tree 中 Sidebar 行更新为拆分后清单（一行式，与现有风格一致）：

```
├── Sidebar/ — Sidebar.tsx（列表渲染+状态提升，≤800 行）、ProjectCard.tsx（项目树渲染）、Create{Project,Session,Worktree}Modal.tsx、Rename/Delete{Confirm,Worktree}/ReleaseConfirm/RepairPath 对话框、ExternalSessionsSection.tsx（外部会话轮询+adopt）、DuplicateProjectsDialog.tsx、UpdateBadge.tsx、RowActionButtons.tsx、sidebarModalStyles.ts
```

- [ ] **Step 5: `frontend-patterns.md` 补 Sidebar modal 拆分约定**

在「Section 拆分原则」节后追加一小节（沿用现有行文）：**Sidebar modal 子组件契约**——每个 modal 独立文件、自持表单/提交状态、`target: T | null` 或 `open` prop 作开关、数据刷新经回调 prop（`reloadXxx`）回流主组件、store 直读仅限既有全局切片；并列出已有案例（本次 13 文件）。

- [ ] **Step 6: CHANGELOG 条目**

在相应版本段 `Refactored` 分类追加（时间戳填实施当时）：

```markdown
- Refactored: `Sidebar.tsx`（2,618 行）拆分为 13 个自带状态的子组件/模块，主文件降至 ≤800 行；目录浏览重复逻辑收敛为 `useDirBrowser` hook，行为零变化 (YYYY-MM-DD HH:MM)
```

- [ ] **Step 7: 推进方向计划状态**

`docs/dev/plans/2026-08-03-large-file-optimization.md`：状态改为 `进行中`，§5 验收标准前两条勾选，§4 Phase 1 行标注已实施日期。

- [ ] **Step 8: Commit**

```bash
git add docs/architecture/frontend.md docs/architecture/frontend-patterns.md CHANGELOG.md \
  docs/dev/plans/2026-08-03-large-file-optimization.md frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "docs: Sidebar 拆分验收与文档闭环（frontend/frontend-patterns/CHANGELOG）"
```

---

## 勘误

- **E1（Task 5，2026-08-03）**：初稿的渲染规格 `Modal open={phase === 'form'}` 在 submit-worktree 触发 git init 确认时会把表单 Modal 一并收起，与原实现「表单保留、确认框叠加其上」不一致（Esc 语义、取消后重挂载动画/autoFocus 均受影响），违背「行为零变化」约束。已修正为按 `mode === 'submit-worktree'` 叠加渲染（commit 82ac737），并同步更新 Task 5 Step 1 的渲染规格。
- **E2（Task 6，2026-08-03）**：`useDirBrowser` 追加 `reset(): void`（清空 entries/error/notFound）。原实现中「路径输入被清空 / 弹窗打开 / 弹窗关闭」三处会显式清掉这三态，而 hook 封装了 setter，不提供 reset 就无法逐字保留——表现为输入清空后残留旧补全建议、重开弹窗时短暂闪现上次的错误/「将自动创建」态。CreateProjectModal 在三处对应调用 `reset()`，行为与拆分前一致；Task 1 的接口清单已同步更新。
- **E3（Task 9，2026-08-03）**：Task 9 Step 2 挂载片段初稿写作 `void Promise.all([loadWorktrees, loadSessions])`，与原实现不一致——原「+」（创建 worktree）回调为 `async onClick`，先 `await` 展开兜底加载完成才 `setCreateWtProjectId` 打开弹窗。`void` 会让弹窗提前一个加载时延打开，违背「行为零变化」约束（与 E1 同类）。已恢复 `async/await` 时序（commit 7ddefda），并同步更新上方挂载片段。

## 风险与勘误约定

| 风险 | 缓解 |
|------|------|
| 搬移中 JSX 字符级偏差（style 对象、hover 内联逻辑） | 逐字搬移 + 每 Task `tsc`/lint/测试三重门禁；Task 6/10 手动冒烟兜底 |
| 共享 `submitting` 拆分后并发提交语义变化 | 原逻辑同一时刻仅一个弹窗可见可提交，各自持有后语义不变 |
| CreateWorktreeModal 状态机改动引入时序差异 | loading-branches 阶段不渲染任何弹层，与现状「预检完成才开弹窗」逐帧对齐；两条既有用例守门 |
| 行数验收不达标 | Step 1 预案已给出升级路径（外移轮询 + 勘误块） |

实施中发现计划与代码现状不符时，就地在本文件追加「勘误」块（参照 quality-gates 计划惯例），不默默改动计划。
