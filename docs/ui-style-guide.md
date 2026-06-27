# OmniTerm UI 风格规范 (UI Style Guide)

> 本文档是 OmniTerm 前端视觉风格的**唯一事实来源 (Single Source of Truth)**。
> 任何新增的 UI 组件或样式修改，都应与本文档描述的语言保持一致。
> 最后更新：2026-06-24

## 1. 设计语言总览

OmniTerm 采用 **深色科技感 (Dark Tech)** 视觉语言：

- **基底**：深黑 (`#0a0a0f`) 铺满所有面板与容器背景，无纯白/纯灰表面
- **主强调色**：violet (`#a78bfa`)，仅用于高亮、激活、选中、进度、链接
- **文本层级**：通过 slate 色阶 (`#e2e8f0 → #cbd5e1 → #94a3b8 → #64748b → #475569`) 表达信息层级
- **边框与分隔**：slate 深色调 (`#1e293b` / `#334155`)，1px 实线，不突兀
- **交互动效**：统一的 `0.15s ease` 过渡 + violet 辉光 (`box-shadow`) 表达 hover/active

**核心原则**：
1. 任何面板都不能出现纯白 (`#ffffff`) 或接近纯白的背景
2. violet 是稀缺资源 —— 仅用于"这里可以交互"或"这是当前选中"
3. 文本颜色越亮，信息越重要；越暗，越辅助/占位
4. 三条 drag bar（sidebar ↔ terminal ↔ filemanager 垂直 × 2 + filemanager 内部水平 × 1）共享同一套视觉语言
5. 滚动条、输入框、按钮等原生控件都必须重写为深色主题

---

## 2. 色板 (Palette)

### 2.1 背景色阶

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `bg-base` | `#0a0a0f` | `#f8fafc` | 所有面板背景、空状态、drag bar 底色 |
| `bg-elevated` | `#111827` | `#f1f5f9` | 浮动层：hover 背景、context menu、modal、按钮 hover |
| `bg-surface` | `#1e293b` | `#ffffff` | 输入框背景、卡片表面 |

**规则**：
- 任何面板、卡片、toolbar、空状态的底色都用 `bg-base`
- hover 时背景提亮到 `bg-elevated`，不要用更亮或带色相的背景
- 亮色主题下 `bg-base` 为浅灰，`bg-surface` 为纯白
- OmniTerm 支持亮/暗双主题，通过 CSS 变量（`:root` / `.dark`）切换

### 2.2 边框色

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `border-subtle` | `#1e293b` | `#e2e8f0` | 主要分隔线：sidebar 右边、toolbar 下边、input 默认边、drag bar 上下边 |
| `border-strong` | `#334155` | `#cbd5e1` | 浮动层边线：context menu、modal、toggle-view dropdown、滚动条 thumb |

**规则**：
- 面板之间（如 sidebar ↔ terminal）用 `border-subtle`
- 弹出层（modal、menu、dropdown）用 `border-strong`，配合 `box-shadow` 增强浮动感
- 输入框聚焦时 `border-color` 切换到 violet (`#a78bfa`)

### 2.3 文本色阶（从高到低）

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `text-primary` | `#e2e8f0` | `#0f172a` | 主要内容：文件名、工作区名、modal 标题、正文 |
| `text-secondary` | `#cbd5e1` | `#334155` | 次要内容：folder 名、breadcrumb、context menu 项 |
| `text-muted` | `#94a3b8` | `#64748b` | 辅助：列头 (名称/修改时间/大小)、toolbar icon、空状态主文案、`文件信息` |
| `text-faint` | `#64748b` | `#94a3b8` | 占位/禁用：drag bar 静息指示条、空状态次文案、禁用按钮 |
| `text-dim` | `#475569` | `#cbd5e1` | 最弱：空状态底部提示 ("使用左侧边栏开始")、禁用且半透明 |

### 2.4 强调色 (Accent)

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `accent-violet` | `#a78bfa` | `#7c3aed` | **主强调**：hover 文本、选中背景叠加、drag bar hover 指示条、按钮 primary 背景、链接、进度条、focus ring |
| `accent-violet-bright` | `#c4b5fd` | `#6d28d9` | 次级 violet：按钮 primary hover、更亮的 hover 文本 |
| `accent-violet-10` | `rgba(167, 139, 250, 0.10)` | 极淡 violet：toolbar button hover 背景 |
| `accent-violet-12` | `rgba(167, 139, 250, 0.12)` | 极淡 violet：dropdown 项 hover 背景 |
| `accent-violet-14` | `rgba(167, 139, 250, 0.14)` | 极淡 violet：选中项背景、context menu 项 hover |
| `accent-violet-18` | `rgba(167, 139, 250, 0.18)` | 移动中文件的高亮 |
| `accent-violet-glow-sm` | `0 0 6px rgba(167, 139, 250, 0.5)` | 小辉光：sidebar 红色状态点 hover、drag bar hover |
| `accent-violet-glow-md` | `0 0 10px rgba(167, 139, 250, 0.7)` | 中辉光：drag bar drag 态、按钮 primary hover |
| `accent-violet-glow-lg` | `0 0 12px rgba(167, 139, 250, 0.3)` | 大辉光：sidebar active workspace |

### 2.5 功能色 (Semantic)

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `danger` | `#ef4444` | `#dc2626` | 删除、危险操作按钮 |
| `danger-12` | `rgba(239, 68, 68, 0.12)` | `rgba(220, 38, 38, 0.12)` | 危险按钮 hover 背景 |
| `danger-glow` | `0 0 6px rgba(239, 68, 68, 0.3)` | `0 0 6px rgba(220, 38, 38, 0.3)` | 危险状态辉光 |
| `success` | `#4ade80` | `#16a34a` | 成功状态、运行中的 agent |
| `success-glow` | `0 0 6px #4ade80` | `0 0 6px #16a34a` | 成功状态辉光 |
| `warning` | `#f59e0b` | 警告状态、超出 workspace 边界 |
| `warning-12` | `rgba(245, 158, 11, 0.12)` | 警告背景 |
| `warning-glow` | `0 0 6px rgba(245, 158, 11, 0.3)` | 警告状态辉光 |

### 2.6 滚动条

| Token | Dark | Light |
|---|---|---|
| `scrollbar-track` | `#0a0a0f` | `#f1f5f9` |
| `scrollbar-thumb` | `#334155` | `#cbd5e1` |
| `scrollbar-thumb-hover` | `#a78bfa` | `#7c3aed` |

```css
width: 8px
```

---

## 3. 字体 (Typography)

### 3.1 字体栈

```ts
const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"
```

**规则**：
- 全局统一使用等宽字体，不用 sans-serif
- `JetBrains Mono` 是首选；用户系统若无则回退到 `Fira Code` → `Cascadia Code` → 系统等宽
- 所有组件（Sidebar、Terminal、FileManager、Modal、Toast）都用同一个 `FONT` 常量

### 3.2 字号阶梯

| Token | Size | 用途 |
|---|---|---|
| `fs-xs` | `11px` | 文件名、修改时间、大小、列头、letter-spacing: 0.5px |
| `fs-sm` | `12px` | 按钮、输入框、folder 名、toolbar icon、context menu、空状态文案 |
| `fs-base` | `13px` | 文件名 (list view)、主文本、file-explorer 默认字号 |
| `fs-md` | `14px` | modal 标题、sidebar 头部标题 |

### 3.3 文本修饰

- 列头（名称 / 修改时间 / 大小）：`text-transform: uppercase; letter-spacing: 0.5px`
- 按钮 primary：`font-weight: 600`
- 链接 / breadcrumb 中的可点击片段：默认 `accent-violet`，hover `accent-violet-bright`

---

## 4. 间距与圆角 (Spacing & Radius)

### 4.1 圆角阶梯

| Token | Size | 用途 |
|---|---|---|
| `r-xs` | `1px` / `2px` | 小指示器：drag bar `::after` pill、scrollbar thumb |
| `r-sm` | `4px` | 文件项选中态、list item |
| `r-md` | `5px` | 输入框、toolbar button |
| `r-lg` | `6px` | 按钮、dropdown、context menu、drop zone |
| `r-xl` | `10px` | modal、confirm dialog |

### 4.2 间距

- 面板 padding：`6px 10px`（toolbar）/ `p-1`（terminal）/ `px-4 py-2`（button）
- 图标与文字间距：`gap-2.5`（≈ 10px）
- 边框宽度：统一 `1px`

---

## 5. 组件规范

### 5.0 图标规范（Emoji 禁止令）

**禁止在 UI 中直接使用 emoji 字符（Unicode emoji）。** Emoji 在不同平台/浏览器下渲染不一致，破坏深色科技感视觉语言。

- **可以**参考 emoji 的设计语言作为灵感（如 git 分支图标参考 git logo）
- **必须**使用 SVG、CSS 绘制、或 monospace 等宽字符（`▸`、`●`、`✕` 等）实现
- SVG 图标放在 `frontend/src/components/Icons/` 目录，遵循 `stroke` + `currentColor` 模式
- 尺寸统一 16×16，`viewBox="0 0 16 16"` 或 `viewBox="0 0 24 24"`
- 参考实现：`frontend/src/components/FileManager/icons.tsx`（10 个 stroke-based SVG）

### 5.1 Drag Bar（统一语言）

OmniTerm 的三条 drag bar（sidebar ↔ terminal ↔ filemanager 垂直 × 2 + filemanager 内部水平 × 1）共享：

| 属性 | 垂直 drag bar (col-resize) | 水平 drag bar (row-resize) |
|---|---|---|
| 布局槽 | `4px` 宽 | `8px` 高 |
| 背景 | `#0a0a0f` | `#0a0a0f` |
| 指示器（默认） | `4px × 48px` 居中 pill, `#64748b` | `48px × 4px` 居中 pill, `#64748b` |
| 指示器（hover） | `#a78bfa` + `0 0 6px rgba(167,139,250,0.5)` | `#a78bfa` + `0 0 10px rgba(167,139,250,0.7)` + 高度涨到 `5px` |
| 背景（hover） | `#111827` | `#111827` |
| 过渡 | `0.15s ease` | `0.15s ease` |

**原则**：
- 静息态 = 可见但克制（slate），告诉用户"这里可以拖"但不抢戏
- Hover 态 = violet 辉光，明确"现在可以拖"
- 圆角：`2px`，与 scrollbar thumb 一致

**CSS 类名**：
- 垂直：`.omniterm-drag-bar` + `.omniterm-drag-bar-v`
- 水平：`.sidebar-resize`（cubone 类名，被 OmniTerm 重写）

### 5.2 按钮

```css
/* Primary — violet 实底 */
background: #a78bfa;
color:      #0a0a0f;
font-weight: 600;
/* hover */ background: #c4b5fd; box-shadow: 0 0 10px rgba(167,139,250,0.4);

/* Secondary — 透明 + slate 边 */
background: transparent;
border:     1px solid #334155;
color:      #cbd5e1;
/* hover */ border-color: #a78bfa; color: #a78bfa; background: rgba(167,139,250,0.08);

/* Danger — 透明 + 红色边 */
background: transparent;
border:     1px solid rgba(239,68,68,0.4);
color:      #ef4444;
/* hover */ background: rgba(239,68,68,0.12); box-shadow: 0 0 8px rgba(239,68,68,0.25);

/* Disabled */ opacity: 0.5;
```

### 5.3 输入框

```css
background: #1e293b;
border:     1px solid #334155;
color:      #e2e8f0;
border-radius: 5px;
font-size:  12px;
/* focus */ border-color: #a78bfa; box-shadow: 0 0 0 2px rgba(167,139,250,0.2);
```

### 5.4 选中项 / Hover 项

```css
/* Hover */    background: rgba(167,139,250, 0.06 ~ 0.08);
/* Selected */ background: rgba(167,139,250, 0.14); border-radius: 4px;
/* Moving */   background: rgba(167,139,250, 0.18);
```

### 5.5 Modal / 浮动层

```css
background: #111827;
border:     1px solid #334155;
border-radius: 10px;
box-shadow: 0 20px 50px rgba(0,0,0,0.7);
```

### 5.6 空状态 (Empty State)

```
bg:     #0a0a0f
icon:   accent-violet  + drop-shadow(0 0 10px rgba(167,139,250,0.4))
title:  #94a3b8  (text-muted)
subtitle:#475569 (text-dim)
```

### 5.7 状态指示点（Sidebar session 状态）

```css
running: #4ade80 (success) + 0 0 6px #4ade80
error:   #ef4444 (danger)  + hover 0 0 6px rgba(239,68,68,0.3)
idle:    #64748b (text-faint), 无辉光
```

---

## 6. 动效 (Motion)

### 6.1 通用过渡

```css
transition: all 0.15s ease;
```

适用于：按钮、输入框、drag bar 指示器、toolbar 项、file item

### 6.2 Modal 入场

```css
@keyframes fade-in   { from { opacity: 0 }                   to { opacity: 1 } }
@keyframes scale-in  { from { opacity: 0; scale: 0.95 }      to { opacity: 1; scale: 1 } }
```

时长 `0.15s ease-out`

### 6.3 Toast 入场

```css
@keyframes slide-in { from { opacity: 0; translate: 100% } to { opacity: 1; translate: 0 } }
```

时长 `0.25s ease-out`，从屏幕右侧滑入

### 6.4 模式激活态呼吸动画（参考实现）

适用于需要明确告诉用户「当前处于某模式」的可点击元素（如下载选择态、批量操作态、编辑模式等）。比 hover 状态更醒目，用于**持续指示**而非瞬时反馈。

**设计原则**：

1. **使用 `accent-bright` (#c4b5fd) 而非 `accent` (#a78bfa)** —— 亮部更突出，避免与普通 hover 状态混淆
2. **双层 `box-shadow`**：外发光 8–22px + `inset 0 0 0 1px` 形成 1px 边框环（"装在发光的容器里"）
3. **背景透明度 ≥ 0.30** —— 低于 0.2 在深色背景上几乎不可见
4. **周期 0.9–1.0s** —— 太慢用户注意不到，太快像故障
5. **`easing: ease-in-out`** —— 自然呼吸感
6. **文字色始终为 `accent-bright`，不参与 pulse 动画** —— 避免眼睛疲劳

**参考实现**（FileManager 下载模式按钮 `fm-download-pulse`）：

```css
@keyframes fm-download-pulse {
  0%, 100% {
    background: rgba(196, 181, 253, 0.30);
    box-shadow:
      0 0 8px rgba(196, 181, 253, 0.55),
      inset 0 0 0 1px rgba(196, 181, 253, 0.55);
  }
  50% {
    background: rgba(196, 181, 253, 0.58);
    box-shadow:
      0 0 22px rgba(196, 181, 253, 0.95),
      inset 0 0 0 1px rgba(221, 214, 254, 0.85);
  }
}
.fm-btn-mode-active {
  animation: fm-mode-pulse 1.0s ease-in-out infinite;
  color: #c4b5fd;  /* accent-bright */
}
.fm-btn-mode-active:hover {
  background: rgba(196, 181, 253, 0.55);
  color: #ddd6fe;
  box-shadow: 0 0 22px rgba(196, 181, 253, 0.9);
}
```

**类名规范**：`.fm-btn-{mode}-active`，例如：

- `.fm-btn-download-active` — 下载选择态
- `.fm-btn-batch-active` — 批量操作态
- `.fm-btn-edit-mode-active` — 编辑模式态

**反模式（避免）**：

- ❌ 仅靠 background 透明度变化（< 0.2 看不见）
- ❌ 闪烁（明暗硬切换 0%/50% 同色）—— 容易看成"故障"
- ❌ 旋转 / 位移 transform —— 会分散注意力
- ❌ 周期 < 0.6s —— 视觉上像抖动
- ❌ 周期 > 1.5s —— 用户感知不到动画

---

## 7. 布局 (Layout)

### 7.1 三栏结构

```
┌─────────┬──┬──────────────┬──┬──────────┐
│ Sidebar │V │  Terminal    │V │ FileManager │
│         │  │              │  │            │
└─────────┴──┴──────────────┴──┴──────────┘
   ↑                ↑          ↑
 200px 默认     自适应       300px 默认
 (可调, 持久化 localStorage)
```

- `V` = 垂直 drag bar (`.omniterm-drag-bar-v`)，4px 宽
- 所有面板背景 `#0a0a0f`，之间用 `1px solid #1e293b` 分隔

### 7.2 文件管理器内部布局（dufs 风格单页）

```
┌──────────────────────────────┐
│  Toolbar  (breadcrumb + actions) │
├──────────────────────────────┤
│  File table                   │
│  (sortable columns:           │
│   Name / Modified / Size)     │
│  (sticky header, scroll body) │
└──────────────────────────────┘
```

- 单页表格布局，无分栏。面包屑导航 + 可排序列 + 行内操作按钮
- 拖拽文件到区域上传，支持拖拽高亮提示

### 7.3 移动端布局

- 屏幕宽度 < 768px 切换为底部 tab 导航（终端 / 文件 / 会话 / 设置）
- 三栏互斥显示，不再并排
- 终端面板对 IME 组合键（中日韩输入法）做特殊处理，避免 composition 期间误发快捷键

---

## 8. 覆盖第三方组件

### 8.1 FileManager（自定义 dufs 风格）

FileManager 已从 `@cubone/react-file-manager` 替换为自定义组件，采用 dufs 风格的单页文件表格。

所有样式 scoped 在 `.omnifm-root` 下，CSS 类名使用 `fm-` 前缀。
色板严格遵循本规范 §2 色板定义。

### 8.2 `@xterm/xterm`

- 容器背景 `#0a0a0f`
- 字体：与全局 `FONT` 保持一致（通过 Terminal 组件 `theme` 注入）
- 空状态（未选中 session）：深黑底 + 居中 violet SVG 图标 + 中文提示文案

---

## 9. 新增组件的自检清单

添加任何新 UI 元素前，按此清单核对：

- [ ] 背景色是否用了 `#0a0a0f` 或 `#111827`（而非白/浅灰）？
- [ ] 文本色是否在 `#e2e8f0 → #475569` 色阶内，且层级合理？
- [ ] 边框是否用了 `#1e293b`（分隔）或 `#334155`（浮动）？
- [ ] 强调色 violet (`#a78bfa`) 是否用得克制 —— 仅用于 hover / active / focus / progress？
- [ ] 输入框 focus ring 是否用 `rgba(167,139,250,0.2)`？
- [ ] hover 背景是否用了 `rgba(167,139,250, 0.06~0.12)` 范围内的淡 violet？
- [ ] 过渡动效是否用了 `0.15s ease`？
- [ ] 圆角是否匹配同类组件（按钮 `6px`，输入框 `5px`，modal `10px`，选中项 `4px`）？
- [ ] 字体是否用了全局 `FONT` 常量？
- [ ] 字号是否在 `11px ~ 14px` 阶梯内？
- [ ] 是否覆盖了原生控件（滚动条、checkbox）的默认样式？
- [ ] 新增的 CSS 规则是否 scoped 在合适的类名下（如 `.omnifm-root`、`.omniterm-*`）？
- [ ] 是否同时在亮/暗两种主题下测试了视觉效果？
- [ ] 图标是否使用 SVG 或等宽字符？**禁止直接使用 emoji 字符**（见 §5.0）
- [ ] 模式激活态（如下载选择、批量操作）是否使用 §6.4 的呼吸动画而非普通 hover？

---

## 10. 示例片段

### 10.1 React 组件内联样式模板

```tsx
import { FONT } from '../../theme/tokens' // 建议抽到共享模块

<div style={{
  background: '#0a0a0f',
  color: '#e2e8f0',
  fontFamily: FONT,
  border: '1px solid #1e293b',
  borderRadius: 6,
  padding: '8px 12px',
  transition: 'all 0.15s ease',
}}>
  {/* 主文案 */}
  <div style={{ color: '#e2e8f0', fontSize: 13 }}>Title</div>
  {/* 次文案 */}
  <div style={{ color: '#94a3b8', fontSize: 12, marginTop: 4 }}>Subtitle</div>
</div>
```

### 10.2 Tailwind + 内联混用模板（用于 Tailwind 不便表达的颜色）

```tsx
<div
  className="flex items-center gap-2.5 rounded-md cursor-pointer transition-all"
  style={{ color: '#cbd5e1', background: 'rgba(167,139,250,0.08)' }}
>
  <span style={{ color: '#a78bfa' }}>●</span>
  <span>Workspace name</span>
</div>
```

---

## 11. 版本记录

| 日期 | 变更 |
|---|---|
| 2026-06-27 | 新增 §6.4「模式激活态呼吸动画」参考实现（来源：FileManager 下载模式按钮） |
| 2026-06-22 | 初始版本。基于 Phase 1-8b 实现的视觉语言提炼 |
