# 文件查看/编辑器设计文档

**日期**: 2026-06-23
**状态**: 已确认
**范围**: FileManager 文件查看/编辑功能 + SSE 实时文件监听

---

## 1. 概述

为 OmniTerm FileManager 添加文件查看和编辑能力。用户单击文件名后，从文件管理器底部抽屉式拉出编辑器窗口。同时将 FileManager 的轮询机制升级为 SSE（Server-Sent Events）实时文件监听。

**核心决策**:
- 编辑器：CodeMirror 6（语法高亮、行号、多语言支持）
- 抽屉交互：固定初始高度 + drag bar 拖拽展开/收起
- 文件监听：SSE + inotify 替代 3 秒轮询
- 触发方式：单击文件名打开抽屉（默认预览模式）
- 架构：FileManager 内嵌抽屉（状态在组件内部管理）

---

## 2. 组件结构

```
frontend/src/components/FileManager/
├── FileManager.tsx          # 修改：集成抽屉，单击文件名触发打开，移除轮询改用 SSE
├── FileDrawer.tsx           # 新增：抽屉容器（顶部栏 + drag bar + 内容区）
├── FileEditor.tsx           # 新增：CodeMirror 编辑器包装
├── FilePreview.tsx          # 新增：图片预览组件
└── icons.tsx                # 修改：新增 IconEye、IconEdit、IconX 图标
```

### 职责划分

- **FileDrawer**: 抽屉外壳 — 管理展开/收起/拖拽高度，顶部栏（文件名 + 编辑/关闭按钮），根据文件类型渲染 FileEditor 或 FilePreview
- **FileEditor**: CodeMirror 6 实例 — 接收文件内容、是否可编辑、保存回调。预览模式 readonly，编辑模式可写
- **FilePreview**: 图片预览 — `<img>` 标签，自适应容器大小

---

## 3. SSE 文件监听

### 后端

- 新增依赖：`notify` crate
- 新端点：`GET /api/v1/files/watch?session=<id>` 或 `?workspace=<id>`
- 返回 `text/event-stream`，监听指定目录的文件系统事件
- 事件格式：

```
event: change
data: {"kind":"modify","path":"src/main.rs"}

event: change
data: {"kind":"create","path":"src/new_file.rs"}

event: change
data: {"kind":"delete","path":"old.txt"}

event: change
data: {"kind":"rename","path":"old.txt","newPath":"new.txt"}
```

### 前端

- 新增 `useFileWatcher(sessionId, cwd)` hook — 管理 SSE 连接，返回变化事件
- FileManager 的 3 秒轮询移除，改用 SSE 事件驱动刷新
- FileDrawer 也订阅同一个 SSE 事件，检测当前打开文件的变化
- SSE 连接断开时自动重连（3 秒间隔），顶部栏显示连接状态提示

### 性能优势

| | 轮询 | SSE + inotify |
|---|---|---|
| 文件无变化时 | 每 3 秒一次 HTTP 请求，全部浪费 | 零开销，内核级事件驱动 |
| 文件有变化时 | 最多 3 秒延迟 | 毫秒级推送 |
| 连接开销 | 每次完整 HTTP 请求/响应 | 一个持久连接，消息极小 |
| 多文件场景 | N 个文件 = N 次请求/3秒 | 一个 SSE 连接监听目录 |

---

## 4. CodeMirror 编辑器配置

### 依赖

```bash
pnpm add @codemirror/view @codemirror/state @codemirror/language \
         @codemirror/lang-javascript @codemirror/lang-python @codemirror/lang-rust \
         @codemirror/lang-json @codemirror/lang-html @codemirror/lang-css \
         @codemirror/lang-markdown @codemirror/lang-yaml @codemirror/lang-toml \
         @codemirror/lang-sql @codemirror/lang-go @codemirror/lang-java \
         @codemirror/lang-cpp @codemirror/lang-php @codemirror/lang-shell \
         @codemirror/theme-one-dark
```

### 主题映射（对接 UI 规范）

| CodeMirror token | OmniTerm 颜色 |
|---|---|
| 背景 | `#0a0a0f` |
| 行号/边距 | `#475569` |
| 当前行高亮 | `#111827` |
| 选区 | `rgba(167,139,250,0.2)` |
| 关键字 | `#a78bfa`（violet） |
| 字符串 | `#4ade80`（green） |
| 注释 | `#64748b`（dim） |
| 函数名 | `#c4b5fd`（bright violet） |
| 数字/布尔 | `#f59e0b`（amber） |

### 行为

- 预览模式：`EditorView.editable.of(false)` — 可选择复制，不可编辑
- 编辑模式：`Ctrl+S` / `Cmd+S` 绑定保存，`Escape` 触发关闭或弹窗

---

## 5. 文件类型判断与大小限制

### 类型判断（基于扩展名）

**图片文件（预览）**: `.png .jpg .jpeg .gif .svg .webp .bmp .ico`

**文本文件（编辑器）**:
- 代码: `.js .ts .tsx .jsx .py .rs .go .java .c .cpp .h .hpp .php .sh`
- 标记: `.html .css .scss .json .xml .yaml .yml .toml .md .sql`
- 配置: `.env .conf .cfg .ini .gitignore .dockerignore`
- 其他: `.txt .log .csv .tsv` 以及无扩展名

**不支持**: 以上都不是 → 提示"不支持预览此文件类型"

### 大小限制

| 文件类型 | 限制 | 超出处理 |
|---|---|---|
| 文本文件 | ≤ 4MB | 提示"文件过大，不支持编辑"，提供下载按钮 |
| 图片文件 | ≤ 20MB | 提示"文件过大，不支持预览"，提供下载按钮 |

---

## 6. 前端 API 变更

### `frontend/src/api/client.ts` 新增

```typescript
readFileBySession: (sessionId: string, path: string) =>
  request<{ content: string }>(`/files/read?session=${sessionId}&path=${encodeURIComponent(path)}`)

writeFileBySession: (sessionId: string, path: string, content: string) =>
  request(`/files/write?session=${sessionId}&path=${encodeURIComponent(path)}`, {
    method: 'POST',
    body: JSON.stringify({ content })
  })
```

SSE 连接不走 client.ts 的 request 封装，直接用 `EventSource`。

---

## 7. 抽屉布局

```
┌─────────────────────────────────────────────────┐
│ ▓▓▓ drag bar（6px 高，hover 变 #a78bfa）         │
├─────────────────────────────────────────────────┤
│ 📄 main.rs               [👁 预览] [✏️ 编辑] [✕] │  ← 顶部栏 36px
├─────────────────────────────────────────────────┤
│                                                 │
│  1 │ use std::fs;                               │
│  2 │ use std::io::Read;                         │  ← CodeMirror 编辑区
│  3 │                                            │     或图片预览区
│  4 │ fn main() {                                │
│  5 │     println!("Hello");                     │
│  6 │ }                                          │
│                                                 │
├─────────────────────────────────────────────────┤
│ UTF-8 · 6 lines · 128 bytes      [已修改 ●]     │  ← 状态栏 28px
└─────────────────────────────────────────────────┘
```

### 视觉样式

- 背景色：`#111827`
- 边框：顶部 `1px solid #334155` + drag bar
- 字体：JetBrains Mono，13px
- 拖拽：最小 120px，最大 = 视窗高度 - 工具栏高度（留一行文件列表可见）
- 高度记忆：`sessionStorage`，所有 session 共享

### 顶部栏

- 左侧：文件图标 + 文件名（`#e2e8f0`，截断溢出）
- 右侧：预览/编辑模式切换按钮 + 关闭按钮
- 预览模式时编辑按钮可用，编辑模式时编辑按钮高亮（violet）

### 状态栏

- 左侧：编码、行数、文件大小
- 右侧：已修改标记（● violet）或"已保存"提示（2 秒后消失）

---

## 8. 状态管理

### FileManager 内部状态

```typescript
const [drawerFile, setDrawerFile] = useState<string | null>(null)
const [drawerMode, setDrawerMode] = useState<'view' | 'edit'>('view')
const [drawerContent, setDrawerContent] = useState<string>('')
const [drawerModified, setDrawerModified] = useState(false)
const [drawerHeight, setDrawerHeight] = useState(256)
const [drawerLoading, setDrawerLoading] = useState(false)
```

### Session 记忆

存入 `fmSessionStates` 的每个 session 记录：

| 状态 | 是否记忆 | 说明 |
|---|---|---|
| 打开的文件路径 | ✅ | 存入 appStore |
| 预览/编辑模式 | ✅ | 存入 appStore |
| 文件内容 | ❌ | 切换回来时重新 fetch |
| 已修改状态 | ❌ | 切换前弹窗确认 |
| 抽屉高度 | ✅ | sessionStorage 全局共享 |

---

## 9. 错误处理

| 场景 | 处理方式 |
|---|---|
| 文件读取失败 | 抽屉内显示错误信息 + 重试按钮 |
| 保存失败 | 顶部栏红色错误提示，保留用户输入 |
| 保存冲突（外部修改） | 弹窗：覆盖保存 / 重新加载 / 取消 |
| SSE 连接断开 | 自动重连（3 秒间隔），顶部栏显示"连接中断，重连中..." |
| 切换 session | 关闭抽屉（保存未修改内容），关闭旧 SSE 连接 |
| 抽屉打开时删除该文件 | SSE 检测到 → 显示"文件已被删除" |
| 图片加载失败 | 占位图标 + 文件名 + 下载按钮 |
| 二进制文件误判 | 回退显示"此文件为二进制格式，无法编辑" |

---

## 10. 交互流程

### 打开文件

```
单击文件名 → 判断类型 → 抽屉滑出（256px 或记忆高度）
→ 加载 spinner → fetch 内容 → CodeMirror 渲染（readonly）
→ appStore 记忆 session 状态
```

### 切换编辑模式

```
点击编辑按钮 → CodeMirror 可编辑 → 按钮高亮 → 获得焦点
```

### 保存

```
Ctrl+S → POST /files/write → 状态栏"✓ 已保存"（2s 消失）
```

### 关闭

```
点击关闭 / 切换 session → if (已修改) 弹窗确认 → 关闭
```

### SSE 驱动刷新

```
agent 修改文件 → SSE 推送事件
→ view 模式：静默重新 fetch 内容
→ edit 模式：顶部栏显示 ⚠️ 外部修改提示
→ 文件列表：重新 fetch 列表
```

---

## 11. 工作量估算

| 部分 | 工作量 | 说明 |
|---|---|---|
| 后端 SSE 端点 + notify | 中等 | 新端点 + 新依赖 |
| 前端 useFileWatcher hook | 小 | EventSource 管理 |
| FileDrawer 组件 | 中等 | 拖拽 + 状态 + 布局 |
| FileEditor (CodeMirror) | 中等 | 主题 + 语言 + 快捷键 |
| FilePreview | 小 | 图片预览 |
| API client 补全 | 小 | 两个新方法 |
| FileManager 集成 | 中等 | 单击事件 + 移除轮询 + SSE 集成 |
| 图标 + 样式 | 小 | 新增图标 + CSS |

**总计**: 后端改动小（一个新端点），主要工作在前端。
