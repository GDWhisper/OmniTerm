# 新建项目窗口：嵌入式目录浏览

**日期:** 2026-06-27
**状态:** 设计中
**作者:** pi brainstorming session

## 概述

当前「新建项目」模态框只有「名称」+「路径」两个文本输入框（路径默认填 home）。用户必须手输完整路径，缺少视觉浏览能力。优化后增加嵌入式目录列表，让点选和手输都能定位路径，两种方式实时同步。

## 决策摘要

| 决策点 | 选择 | 理由 |
|---|---|---|
| 目录列表形式 | 嵌入式目录树 | 保留手输灵活 + 加视觉浏览能力 |
| 布局 | 垂直叠加（path 在上、列表在下） | 简单、modal 高度可控、不挤窄屏 |
| 点击行为 | 点击即进入（当前路径实时同步到输入框） | 与 macOS Finder / VS Code 打开文件夹一致 |
| 起始位置 | home 目录（来自 `/api/v1/system/info`） | 与现有行为一致，零惊喜 |

## 后端改动

### 新增端点 `GET /api/v1/system/dirs?path=<absolute>`

**文件:** `src/api/system.rs`（已有 system 模块）

**目的:** 给前端一个「无 session/workspace 上下文」的目录列表端点，复用 `fs::list_dir` 但不要求 base 路径必须在某个 workspace 内。

**请求:**

```
GET /api/v1/system/dirs?path=/home/user/projects
```

**响应（成功 200）:**

```json
{
  "files": [
    { "path_type": "Dir", "name": "myproject", "mtime": 1700000000, "size": 12 },
    { "path_type": "Dir", "name": "notes", "mtime": 1700000000, "size": 5 }
  ]
}
```

**响应（路径无效 404）:**

```json
{ "error": "path not found" }
```

**响应（其他错误 500）:**

```json
{ "error": "<error message>" }
```

**实现要点:**

- 直接调用 `fs::list_dir(Path::new(&path), "", SortKey::Name, false)`
- 不做路径白名单/黑名单（OmniTerm 是单用户本地应用）
- `is_outside_workspace` 不需要——这个端点不绑定 workspace 概念
- 不需要新增 `RequireAuth` 之外的鉴权（沿用现有 Axum middleware 即可）

**为什么单独一个端点而不复用 `/files`:**

- `/files` 的三种模式（session/workspace_id/workspace project）都要求上下文
- 新项目窗口发生在「还没有 project」的时刻，无法用 `/files?workspace=<project_id>`
- 用 `/system/dirs` 与已有的 `/system/info` 形成「系统级只读操作」的统一命名空间

## 前端改动

### 1. API Client (`frontend/src/api/client.ts`)

新增方法：

```ts
listDirs: (path: string) =>
  request<{ files: FileEntry[] }>(`/system/dirs?path=${encodeURIComponent(path)}`)
```

复用现有的 `FileEntry` 类型（从 FileManager 共享或重新定义同构类型）。

### 2. 改造 createProjOpen 模态框 (`frontend/src/components/Sidebar/Sidebar.tsx`)

**新增 state:**

```ts
const [browsePath, setBrowsePath] = useState('')      // 当前浏览到的目录
const [browseEntries, setBrowseEntries] = useState<FileEntry[]>([])
const [browseLoading, setBrowseLoading] = useState(false)
const [browseError, setBrowseError] = useState<string | null>(null)
```

**生命周期:**

- 打开模态框时（`setCreateProjOpen(true)` 副作用）：
  - 调 `api.systemInfo()` 拿 home_dir（已有逻辑，扩展一下）
  - `setBrowsePath(home_dir)`
  - `fetchDirs(home_dir)` 拉取初始列表
- `browsePath` 变化时（点击目录、点 ..、输入框应用）：重新 `fetchDirs(browsePath)`
- 关闭模态框时：state 重置（依赖 React 自然卸载，或者显式 reset）

**核心函数 `fetchDirs(path)`:**

```ts
const fetchDirs = useCallback(async (path: string) => {
  setBrowseLoading(true)
  setBrowseError(null)
  try {
    const data = await api.listDirs(path)
    setBrowseEntries(data.files.filter(f => f.path_type === 'Dir' || f.path_type === 'SymlinkDir'))
  } catch (e: any) {
    setBrowseError(e.message || '无法访问该目录')
  } finally {
    setBrowseLoading(false)
  }
}, [])
```

**点击目录项处理:**

```ts
const handleEnterDir = (entry: FileEntry) => {
  const newPath = browsePath.endsWith('/') ? `${browsePath}${entry.name}` : `${browsePath}/${entry.name}`
  setProjPath(newPath)        // 同步到 path 输入框
  setBrowsePath(newPath)       // 触发 fetchDirs
}
```

**点 `..` 处理:**

```ts
const handleGoUp = () => {
  const parent = getParentPath(browsePath)  // 复用 FileManager 的 getParentPath
  if (!parent || parent === browsePath) return  // 根目录，禁用
  setProjPath(parent)
  setBrowsePath(parent)
}
```

**输入框应用路径（回车或失焦）:**

```ts
const handlePathApply = () => {
  const trimmed = projPath.trim()
  if (!trimmed || trimmed === browsePath) return
  setBrowsePath(trimmed)   // 触发 fetchDirs；失败时 browseError 提示
}
```

**`handleCreateProject` 改动:** 几乎不变，仍然用 `projPath` 调 `api.createProject`。只需把初始 `projPath` 改为 `homeDir`（已经是这样了）。

### 3. 视觉结构（垂直叠加）

```
┌────────────────────────────────────┐
│ 名称                                │
│ [_____________________________]    │
│                                    │
│ 路径                                │
│ [/home/pax/projects/          ]    │
│ 回车或失焦以应用                    │
│                                    │
│ 浏览            [↻ 刷新]            │
│ ┌──────────────────────────────┐   │
│ │ ..  (根目录禁用)               │   │
│ │ 📁 dotfiles                   │   │  ← hover bg 0.08
│ │ 📁 notes                      │   │
│ │ 📁 projects            12    │   │  ← selected bg 0.14
│ │ 📁 scratch                    │   │
│ │ 📁 work                       │   │
│ └──────────────────────────────┘   │
│                                    │
│           [取消]    [创建]          │
└────────────────────────────────────┘
```

- 模态框 max-width: 520px
- 目录列表 height: 200px，内部 scroll-y
- 目录项 padding: 5px 10px，border-radius: 4px
- 目录项右侧显示 `size`（即子项数，与 FileManager 风格一致）

### 4. UI 规范对照（§1-§9）

| 条目 | 实现 |
|---|---|
| §5.0 禁止 emoji | 用 `IconFolder` / `IconArrowUp` / `IconRefresh`（来自 `frontend/src/components/FileManager/icons.tsx`） |
| §5.2 按钮 | primary `bg #a78bfa` + `color #0a0a0f` + `font-weight 600`；secondary 透明 + 边 |
| §5.3 输入框 | `bg #1e293b` + `border #334155` + `r-md 5px`；focus `border #a78bfa` + `box-shadow 0 0 0 2px rgba(167,139,250,0.2)` |
| §5.4 列表项 | hover `bg rgba(167,139,250,0.08)`；selected `bg rgba(167,139,250,0.14)` + `r-sm 4px` |
| §5.5 Modal | `bg #111827` + `border #334155` + `r-xl 10px` + `box-shadow 0 20px 50px rgba(0,0,0,0.7)` |
| §5.6 空状态 | 加载中：spinner + text-muted；空目录：icon + title/subtitle；错误：warning icon + 错误信息 + 重试 |
| §6.1 过渡 | 所有交互元素 `transition: all 0.15s ease` |
| §6.2 Modal 入场 | 复用现有 fade-in + scale-in 0.15s ease-out |
| §9 自检 | 字体 FONT、字号 11-14px、scoped 类名 `.create-proj-modal`、双主题（用 CSS 变量） |

### 5. 状态机

```
[closed]
  │ open modal
  ▼
[opening] → fetch systemInfo → fetchDirs(home)
  │
  ▼
[ready]  ←──┐
  │ click dir │ type+enter │ click ".."
  ├──────────┴────────────┴──► [loading] → [ready]
  │                              │
  │                              └─► [error] ──retry──► [ready]
  │
  │ click "Create"
  ▼
[submitting] → success → close + toast
            → 409 (already_covered) → coverConflict dialog（现有逻辑）
            → other error → toast（现有逻辑）
```

## 错误处理

| 场景 | 行为 |
|---|---|
| `browsePath` 不存在或无权限 | `browseError` 显示在列表区域；输入框保留旧值；列表显示「无法访问 / 重试」 |
| 加载中 | 列表区域显示 spinner + 「加载中...」 |
| 目录为空 | 列表显示空状态 icon + 「空目录」 |
| 路径是文件不是目录 | 列表区域显示错误「不是一个目录」 |
| `..` 在根目录 | 按钮禁用（`opacity: 0.5` + `cursor: not-allowed`） |
| 创建时 409 | 沿用现有 coverConflict 弹窗，行为不变 |
| 创建时其他错误 | 沿用现有 toast，行为不变 |

## 测试计划

**手动测试用例:**

| 编号 | 场景 | 预期 |
|---|---|---|
| 1 | 打开新建项目窗口 | 路径默认 home，列表显示 home 的子目录（仅目录） |
| 2 | 点击列表中的一个目录 | 路径输入框更新为该目录，列表显示其子目录 |
| 3 | 点 `..` | 回到父目录；到根目录后 `..` 禁用 |
| 4 | 在路径输入框打一个新路径并回车 | 列表尝试加载新路径的子目录；成功则更新；失败则提示「路径无效」+ 保留旧列表 |
| 5 | 点击「刷新」 | 强制重新拉取当前路径的子目录 |
| 6 | 创建项目：路径不存在 | 后端自动创建（沿用现状），成功 toast |
| 7 | 创建项目：路径已被另一 project 覆盖 | 弹出 coverConflict 弹窗（沿用现状） |
| 8 | 目录为空 | 显示「空目录」空状态 |
| 9 | 目录无读取权限 | 显示「无法访问」+ 重试按钮 |
| 10 | 暗色 ↔ 亮色主题切换 | 全部颜色正确，文字可读 |

**自动测试:**

- 不新增 unit test（项目目前没有 frontend 测试框架，沿用现状）
- 手动测试用例 1-10 是最低验收标准

## 不在范围内（YAGNI）

- ❌ 路径收藏 / 历史记录 / 最近使用
- ❌ 树形展开/折叠（保持单层列表）
- ❌ 多选 / 批量创建
- ❌ target 选择（现有 modal 也不暴露，保留）
- ❌ 文件预览/操作（这是「项目创建」窗口，不是文件管理器）
- ❌ 拖拽路径到输入框
- ❌ 路径补全下拉（与点选重复）
- ❌ 修改后端 `create_project` 自动建目录行为（避免 breaking change）

## 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/api/system.rs` | 新增 `list_dirs` 端点处理函数 + 注册路由 `/system/dirs` |
| `src/api/mod.rs` | 把新路由挂上 |
| `frontend/src/api/client.ts` | 新增 `api.listDirs(path)` 方法 |
| `frontend/src/components/Sidebar/Sidebar.tsx` | 改造 createProjOpen 模态框：加 browsePath/Entries/Loading/Error state，加 fetchDirs/handleEnterDir/handleGoUp/handlePathApply，渲染目录列表区域 |

## 验收标准

1. 打开新建项目窗口后，能看到 home 目录的子目录列表（仅目录）
2. 点击目录项能进入，路径输入框实时同步
3. 点 `..` 能返回上级，根目录时禁用
4. 在输入框打路径回车/失焦能跳到该路径
5. 「刷新」按钮能强制刷新当前列表
6. 路径无效时显示「无法访问」+ 不破坏现有 modal 状态
7. 创建项目流程与现状完全一致（409 覆盖检测、自动建目录）
8. 视觉完全符合 `docs/ui-style-guide.md` §1-§9
9. 亮/暗双主题下视觉一致
10. 不引入 emoji 字符
