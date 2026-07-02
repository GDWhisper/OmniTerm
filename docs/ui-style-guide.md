# OmniTerm UI 风格规范 (UI Style Guide)

> 本文档是 OmniTerm 前端视觉风格的**唯一事实来源 (Single Source of Truth)**。
> 任何新增的 UI 组件或样式修改，都应与本文档描述的语言保持一致。
> 最后更新：2026-07-01

## 1. 设计语言总览

OmniTerm 采用 **护眼科幻像素风 (Cyber-Pixel)** 视觉语言：

- **基底**：深空灰 (`#12141A`) 铺满所有面板与容器背景，带微弱蓝紫倾向，无纯黑纯白
- **主强调色**：cyan (`#58A6FF`)，用于高亮、激活、选中、进度、链接；粉色 (`#F778BA`) 用于重要标记
- **文本层级**：通过灰蓝色阶 (`#D1D5DB → #8B949E → #8B949E → #484F58 → #30363D`) 表达信息层级
- **边框与分隔**：深灰调 (`#30363D` / `#484F58`)，实线边框，像素感分明
- **交互风格**：零圆角（modal 除外 `2px`）、像素硬阴影 (`4px 4px 0px 0px`)、`steps()` 离散过渡
- **SVG 像素化**：全局 `shape-rendering: crispEdges`，曲线自动呈现像素阶梯

**核心原则**：
1. 任何面板都不能出现纯白 (`#ffffff`) 或纯黑 (`#000000`) 的背景 —— 深空灰打底
2. cyan 是稀缺资源 —— 仅用于"这里可以交互"或"这是当前选中"
3. 文本颜色越亮，信息越重要；越暗，越辅助/占位
4. 三条 drag bar（sidebar ↔ terminal ↔ filemanager 垂直 × 2 + filemanager 内部水平 × 1）共享同一套视觉语言
5. 滚动条、输入框、按钮等原生控件都必须重写为像素风深色主题
6. 所有交互元素使用硬阴影而非辉光 (glow)，按下时阴影消失并位移

---

## 2. 色板 (Palette)

### 2.1 背景色阶

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `bg-base` | `#12141A` | `#f8fafc` | 所有面板背景、空状态、drag bar 底色（深空灰，带微弱蓝紫倾向） |
| `bg-elevated` | `#1B1E26` | `#f1f5f9` | 面板/卡片背景、modal、按钮背景 |
| `bg-surface` | `#242832` | `#ffffff` | 输入框背景、hover 背景 |

**规则**：
- 任何面板、卡片、toolbar、空状态的底色都用 `bg-base`
- hover 时背景提亮到 `bg-surface`，不要用更亮或带色相的背景
- 亮色主题下 `bg-base` 为浅灰，`bg-surface` 为纯白
- OmniTerm 支持亮/暗双主题，通过 CSS 变量（`:root` / `.dark`）切换
- 对比度控制在 ~8:1，护眼优先

### 2.2 边框色

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `border-subtle` | `#30363D` | `#e2e8f0` | 主要分隔线：sidebar 右边、toolbar 下边、input 默认边、drag bar 上下边 |
| `border-strong` | `#484F58` | `#cbd5e1` | 浮动层边线：context menu、modal、toggle-view dropdown、滚动条 thumb |

**规则**：
- 面板之间（如 sidebar ↔ terminal）用 `border-subtle`
- 弹出层（modal、menu、dropdown）用 `border-strong`，配合硬阴影 (`box-shadow`) 增强浮动感
- 输入框聚焦时 `border-color` 切换到 cyan (`#58A6FF`)
- 按钮使用 `2px solid` 边框，强调像素感

### 2.3 文本色阶（从高到低）

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `text-primary` | `#D1D5DB` | `#0f172a` | 主要内容：文件名、工作区名、modal 标题、正文（对比度 ~11:1） |
| `text-secondary` | `#8B949E` | `#334155` | 次要内容：folder 名、breadcrumb、context menu 项（对比度 ~5:1） |
| `text-muted` | `#8B949E` | `#64748b` | 辅助文本（与 secondary 合并）：列头、toolbar icon、空状态主文案 |
| `text-faint` | `#484F58` | `#94a3b8` | 占位/禁用：drag bar 静息指示条、空状态次文案、禁用按钮 |
| `text-dim` | `#30363D` | `#cbd5e1` | 最弱：空状态底部提示 ("使用左侧边栏开始")、禁用且半透明 |

### 2.4 强调色 (Accent)

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `accent` | `#58A6FF` (柔和星蓝) | `#7c3aed` | **主强调**：hover 文本、选中背景叠加、drag bar hover 指示条、按钮 primary 边框、链接、进度条、focus ring |
| `accent-bright` | `#79C0FF` | `#6d28d9` | 次级强调：按钮 primary hover、更亮的 hover 文本 |
| `accent-pink` | `#F778BA` | — | **新增**：选中/重要标记（如星标、重要文件名） |
| `accent-8` | `rgba(88, 166, 255, 0.08)` | — | toolbar button hover 背景 |
| `accent-14` | `rgba(88, 166, 255, 0.14)` | — | 选中项背景、context menu 项 hover |
| `accent-18` | `rgba(88, 166, 255, 0.18)` | — | 移动中文件的高亮 |

### 2.5 功能色 (Semantic)

| Token | Dark | Light | 用途 |
|---|---|---|---|
| `danger` | `#FF7B72` (柔和珊瑚红) | `#dc2626` | 删除、危险操作按钮 |
| `danger-12` | `rgba(255, 123, 114, 0.12)` | `rgba(220, 38, 38, 0.12)` | 危险按钮 hover 背景 |
| `success` | `#7EE787` (柔和荧光绿) | `#16a34a` | 成功状态、运行中的 agent |
| `warning` | `#FFA657` (柔和琥珀橙) | — | 警告状态、超出 workspace 边界 |
| `warning-12` | `rgba(255, 166, 87, 0.12)` | — | 警告背景 |

**注意**：所有 glow 变量（`--accent-glow-sm/md/lg`、`--danger-glow`、`--success-glow`、`--warning-glow`）已全部移除，被硬阴影替代。

### 2.6 阴影

| Token | Dark | 用途 |
|---|---|---|
| `pixel-shadow` | `#090A0D` | 像素硬阴影色（所有 `box-shadow` 统一使用） |

**规则**：
- 所有 `box-shadow` 的 blur 值（模糊值）必须为 `0`，不允许使用模糊阴影
- 默认态：`box-shadow: 4px 4px 0px 0px var(--pixel-shadow)`
- 按下态：`box-shadow: none; transform: translate(4px, 4px)` — 阴影消失，元素位移
- Modal / 浮动层使用更大的硬阴影：`8px 8px 0px 0px var(--pixel-shadow)`

### 2.7 滚动条

| Token | Dark | Light |
|---|---|---|
| `scrollbar-track` | `#12141A` | `#f1f5f9` |
| `scrollbar-thumb` | `#484F58` | `#cbd5e1` |
| `scrollbar-thumb-hover` | `#58A6FF` | `#7c3aed` |

```css
width: 8px;
border-radius: 0;
```

---

## 3. 像素化规则 (Pixel Rendering)

### 3.1 SVG 像素化

全局 CSS 规则，让所有 SVG 曲线自动呈现像素阶梯效果：

```css
svg, svg * {
  shape-rendering: crispEdges;
}

svg path, svg rect, svg circle, svg line {
  stroke-linecap: square;
  stroke-linejoin: miter;
}
```

**规则**：
- `crispEdges` 关闭抗锯齿，曲线自动呈现像素阶梯
- `stroke-linecap: square` + `stroke-linejoin: miter` 确保描边锐利
- SVG `stroke-width` 保持偶数（`2px`, `4px`），避免在像素网格上发虚
- 图标尺寸统一 16×16，`viewBox="0 0 16 16"` 或 `viewBox="0 0 24 24"`

### 3.2 硬阴影规则

像素风的核心视觉元素 —— 用硬阴影替代所有辉光 (glow) 效果：

```css
/* 默认态 — 按钮/卡片/浮动层 */
box-shadow: 4px 4px 0px 0px var(--pixel-shadow);

/* 按下态 — 阴影消失，按钮位移 */
box-shadow: none;
transform: translate(4px, 4px);

/* 浮动层（Modal/Confirm）— 更大的硬阴影 */
box-shadow: 8px 8px 0px 0px var(--pixel-shadow);
```

**规则**：
- 所有可交互元素（按钮、toggle、可点击卡片）必须有硬阴影
- `active` 状态统一使用 `translate(4px, 4px)` 位移 + 清除阴影
- 非交互元素（纯展示面板、分隔线）不需要硬阴影

### 3.3 像素字体规则

```css
.font-pixel {
  font-family: 'Zpix', 'VT323', 'Press Start 2P', monospace;
  letter-spacing: 1px;
  text-transform: uppercase;
}
```

**规则**：
- 像素字体**仅**用于展示型文本：标题、按钮文字、状态标签
- **禁止**用于代码区和长文本（代码/正文/输入框仍用 `.font-reader`，见 §4）
- `.font-pixel` 附加 `letter-spacing: 1px`，英文全大写 `text-transform: uppercase`
- 通过 Google Fonts 或本地 `@font-face` 引入 Zpix 和 VT323

### 3.4 CRT 扫描线叠加层（可选）

```css
.crt-overlay {
  position: fixed;
  top: 0; left: 0; width: 100%; height: 100%;
  pointer-events: none;
  z-index: 9999;
  background: repeating-linear-gradient(
    0deg,
    rgba(0, 0, 0, 0.02) 0px,
    rgba(0, 0, 0, 0.02) 1px,
    transparent 1px,
    transparent 2px
  );
}
```

- 2% 透明度的水平扫描线，模拟 CRT 显示器效果
- `pointer-events: none` 确保不影响交互
- 默认关闭，通过设置面板开关控制
- 开关值持久化到 `localStorage`

---

## 4. 字体 (Typography)

### 4.1 字体栈

| 用途 | 字体栈 | CSS 类 |
|---|---|---|
| 标题 / 按钮 / 状态标签（展示区） | `'Zpix', 'VT323', 'Press Start 2P', monospace` | `.font-pixel` |
| 代码 / 正文 / 输入框（阅读区） | `'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace` | `.font-reader` |

**规则**：
- 阅读区全局统一使用等宽字体，不用 sans-serif
- `JetBrains Mono` 是首选；用户系统若无则回退到 `Fira Code` → `Cascadia Code` → 系统等宽
- 展示区使用像素字体（见 §3.3），仅限短文本
- 所有组件（Sidebar、Terminal、FileManager、Modal、Toast）的代码/正文区域都用 `.font-reader`

### 4.2 字号阶梯

| Token | Size | 用途 |
|---|---|---|
| `fs-xs` | `11px` | 文件名、修改时间、大小、列头，letter-spacing: 0.5px |
| `fs-sm` | `12px` | 按钮、输入框、folder 名、toolbar icon、context menu、空状态文案 |
| `fs-base` | `13px` | 文件名 (list view)、主文本、file-explorer 默认字号 |
| `fs-md` | `14px` | modal 标题、sidebar 头部标题 |

### 4.3 文本修饰

- 列头（名称 / 修改时间 / 大小）：`text-transform: uppercase; letter-spacing: 0.5px`
- 按钮 primary：`font-family: var(--font-pixel); text-transform: uppercase; letter-spacing: 1px`
- 链接 / breadcrumb 中的可点击片段：默认 `accent`，hover `accent-bright`

---

## 5. 间距与圆角 (Spacing & Radius)

### 5.1 圆角阶梯

| Token | Size | 用途 |
|---|---|---|
| `r-none` | `0` | **绝大多数组件**：按钮、输入框、选中项、dropdown、context menu、drop zone、scrollbar thumb、drag bar pill |
| `r-modal` | `2px` | **仅** Modal / Confirm Dialog（保留微弱圆角） |

**规则**：
- 像素风的核心视觉特征之一是零圆角 —— 方方正正的边缘
- Modal 是唯一例外，保留 `2px` 微弱圆角以区分浮动层级
- 如果不确定用哪个值，用 `0`

### 5.2 间距

- 面板 padding：`6px 10px`（toolbar）/ `p-1`（terminal）/ `px-4 py-2`（button）
- 图标与文字间距：`gap-2.5`（≈ 10px）
- 边框宽度：按钮 `2px`，其他 `1px` 或 `2px` 视组件而定

---

## 6. 组件规范

### 6.0 图标规范（Emoji 禁止令）

**禁止在 UI 中直接使用 emoji 字符（Unicode emoji）。** Emoji 在不同平台/浏览器下渲染不一致，破坏像素风视觉语言。

- **可以**参考 emoji 的设计语言作为灵感（如 git 分支图标参考 git logo）
- **必须**使用 SVG、CSS 绘制、或 monospace 等宽字符（`▸`、`●`、`✕` 等）实现
- SVG 图标放在 `frontend/src/components/Icons/` 目录，遵循 `stroke` + `currentColor` 模式
- 尺寸统一 16×16，`viewBox="0 0 16 16"` 或 `viewBox="0 0 24 24"`
- 参考实现：`frontend/src/components/FileManager/icons.tsx`（10 个 stroke-based SVG）

### 6.1 Drag Bar（统一语言）

OmniTerm 的三条 drag bar（sidebar ↔ terminal ↔ filemanager 垂直 × 2 + filemanager 内部水平 × 1）共享：

| 属性 | 垂直 drag bar (col-resize) | 水平 drag bar (row-resize) |
|---|---|---|
| 布局槽 | `4px` 宽 | `8px` 高 |
| 背景 | `#12141A` | `#12141A` |
| 指示器（默认） | `4px × 48px` 居中方条, `#484F58` | `48px × 4px` 居中方条, `#484F58` |
| 指示器（hover） | `#58A6FF` + `border: 1px solid #58A6FF` | `#58A6FF` + `border: 1px solid #58A6FF` + 高度涨到 `5px` |
| 背景（hover） | `#1B1E26` | `#1B1E26` |
| 过渡 | `0.1s steps(3)` | `0.1s steps(3)` |

**原则**：
- 静息态 = 可见但克制（深灰），告诉用户"这里可以拖"但不抢戏
- Hover 态 = cyan 描边，明确"现在可以拖"，无辉光
- 圆角：`0`（方形象素条）
- 过渡使用 `steps(3)` 离散帧，呈现像素动画感

**CSS 类名**：
- 垂直：`.omniterm-drag-bar` + `.omniterm-drag-bar-v`
- 水平：`.sidebar-resize`（cubone 类名，被 OmniTerm 重写）

### 6.2 按钮

```css
/* Primary — cyan 描边 + 硬阴影 */
background: var(--bg-elevated);
border:     2px solid var(--accent);
color:      var(--accent);
border-radius: 0;
box-shadow: 4px 4px 0px 0px var(--pixel-shadow);
font-family: var(--font-pixel);
text-transform: uppercase;
letter-spacing: 1px;

/* Primary hover */
background: rgba(88, 166, 255, 0.12);
border-color: var(--accent-bright);
color: var(--accent-bright);

/* Primary active — 位移消除阴影 */
transform: translate(4px, 4px);
box-shadow: none;

/* Secondary — 灰色描边 + 硬阴影 */
background: var(--bg-elevated);
border:     2px solid var(--border-strong);
color:      var(--text-primary);
border-radius: 0;
box-shadow: 4px 4px 0px 0px var(--pixel-shadow);

/* Secondary hover */
border-color: var(--accent);
color: var(--accent);

/* Danger — 红色描边 + 硬阴影 */
background: var(--bg-elevated);
border:     2px solid var(--danger);
color:      var(--danger);
border-radius: 0;
box-shadow: 4px 4px 0px 0px var(--pixel-shadow);

/* Danger hover */
background: rgba(255, 123, 114, 0.12);

/* Disabled */
opacity: 0.5;
box-shadow: none;
```

### 6.3 输入框

```css
background: var(--bg-surface);
border:     2px solid var(--border-strong);
color:      var(--text-primary);
border-radius: 0;
font-size:  12px;

/* Focus — cyan 描边，无 blur ring */
border-color: var(--accent);
box-shadow: 0 0 0 1px var(--accent);
```

### 6.4 选中项 / Hover 项

```css
/* Hover */    background: rgba(88, 166, 255, 0.08);
/* Selected */ background: rgba(88, 166, 255, 0.14); border: 2px solid var(--accent);
/* Moving */   background: rgba(88, 166, 255, 0.18);
```

### 6.5 Modal / 浮动层

```css
background: var(--bg-elevated);
border:     2px solid var(--border-strong);
border-radius: 2px;
box-shadow: 8px 8px 0px 0px var(--pixel-shadow);
```

### 6.6 空状态 (Empty State)

```
bg:       #12141A
icon:     accent (#58A6FF)，无 drop-shadow / glow
title:    #8B949E (text-muted)
subtitle: #30363D (text-dim)
```

### 6.7 状态指示点（Sidebar session 状态）

```css
running: #7EE787 (success)，无 glow
error:   #FF7B72 (danger)，无 glow
idle:    #484F58 (text-faint)，无 glow
```

---

## 7. 动效 (Motion)

### 7.1 通用过渡

```css
transition: all 0.1s steps(3);
```

适用于：按钮、输入框、drag bar 指示器、toolbar 项、file item

**规则**：
- 像素风使用 `steps()` 离散帧过渡，而非平滑 `ease`
- `steps(3)` 产生 3 帧阶梯感，兼顾像素感与流畅度
- Modal 入场仍使用 `ease-out` 以保持自然感

### 7.2 Modal 入场

```css
@keyframes fade-in   { from { opacity: 0 }                   to { opacity: 1 } }
@keyframes scale-in  { from { opacity: 0; scale: 0.95 }      to { opacity: 1; scale: 1 } }
```

时长 `0.15s ease-out`

### 7.3 Toast 入场

```css
@keyframes slide-in { from { opacity: 0; translate: 100% } to { opacity: 1; translate: 0 } }
```

时长 `0.25s ease-out`，从屏幕右侧滑入

---

## 8. 布局 (Layout)

### 8.1 三栏结构

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
- 所有面板背景 `#12141A`，之间用 `1px solid #30363D` 分隔

### 8.2 文件管理器内部布局（dufs 风格单页）

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

### 8.3 移动端布局

- 屏幕宽度 < 768px 切换为底部 tab 导航（终端 / 文件 / 会话 / 设置）
- 三栏互斥显示，不再并排
- 终端面板对 IME 组合键（中日韩输入法）做特殊处理，避免 composition 期间误发快捷键

---

## 9. 覆盖第三方组件

### 9.1 FileManager（自定义 dufs 风格）

FileManager 已从 `@cubone/react-file-manager` 替换为自定义组件，采用 dufs 风格的单页文件表格。

所有样式 scoped 在 `.omnifm.root` 下，CSS 类名使用 `fm-` 前缀。
色板严格遵循本规范 §2 色板定义。

### 9.2 `@xterm/xterm`

- 容器背景 `#12141A`
- 字体：与全局 `.font-reader` 保持一致（通过 Terminal 组件 `theme` 注入）
- 终端色板使用像素风配色（见下表）
- 空状态（未选中 session）：深空灰底 + 居中 cyan SVG 图标 + 中文提示文案

**终端色板**：

| 属性 | 值 |
|---|---|
| `background` | `#12141A` |
| `foreground` | `#D1D5DB` |
| `cursor` | `#58A6FF` |
| `selectionBackground` | `rgba(88, 166, 255, 0.25)` |
| `black` | `#12141A` |
| `red` | `#FF7B72` |
| `green` | `#7EE787` |
| `yellow` | `#FFA657` |
| `blue` | `#58A6FF` |
| `magenta` | `#F778BA` |
| `cyan` | `#79C0FF` |
| `white` | `#D1D5DB` |
| `brightBlack` | `#484F58` |
| `brightRed` | `#FFA198` |
| `brightGreen` | `#A5D6A7` |
| `brightYellow` | `#FFCB6B` |
| `brightBlue` | `#79C0FF` |
| `brightMagenta` | `#FF9BCE` |
| `brightCyan` | `#A5D8FF` |
| `brightWhite` | `#E6EDF3` |

---

## 10. 新增组件的自检清单

添加任何新 UI 元素前，按此清单核对：

- [ ] 背景色是否用了 `#12141A` 或 `#1B1E26`（而非白/浅灰/纯黑）？
- [ ] 文本色是否在 `#D1D5DB → #30363D` 色阶内，且层级合理？
- [ ] 边框是否用了 `#30363D`（分隔）或 `#484F58`（浮动）？
- [ ] 强调色 cyan (`#58A6FF`) 是否用得克制 —— 仅用于 hover / active / focus / progress？
- [ ] 输入框 focus ring 是否用 `0 0 0 1px var(--accent)`（无 blur）？
- [ ] hover 背景是否用了 `rgba(88, 166, 255, 0.08)` 范围内的淡 cyan？
- [ ] SVG 是否添加了 `shape-rendering: crispEdges`？`stroke-width` 是否为偶数？
- [ ] 是否使用硬阴影 (`4px 4px 0px 0px`) 替代了辉光 (glow)？
- [ ] `border-radius` 是否归零（modal 例外用 `2px`）？
- [ ] 像素字体是否仅用于展示型文本（标题/按钮/标签），代码区仍用 `.font-reader`？
- [ ] 过渡动效是否用了 `steps(3)` 离散帧（drag bar / 按钮等），modal 仍可用 `ease-out`？
- [ ] 圆角是否匹配同类组件（绝大多数 `0`，modal `2px`）？
- [ ] 字号是否在 `11px ~ 14px` 阶梯内？
- [ ] 是否覆盖了原生控件（滚动条、checkbox）的默认样式？
- [ ] 新增的 CSS 规则是否 scoped 在合适的类名下（如 `.omnifm.root`、`.omniterm-*`）？
- [ ] 是否同时在亮/暗两种主题下测试了视觉效果？
- [ ] 图标是否使用 SVG 或等宽字符？**禁止直接使用 emoji 字符**（见 §6.0）
- [ ] 所有 glow / `blur` box-shadow 是否已清除，无残留？

---

## 11. 示例片段

### 11.1 React 组件内联样式模板

```tsx
<div style={{
  background: '#12141A',
  color: '#D1D5DB',
  fontFamily: FONT_READER,
  border: '2px solid #30363D',
  borderRadius: 0,
  padding: '8px 12px',
  boxShadow: '4px 4px 0px 0px #090A0D',
  transition: 'all 0.1s steps(3)',
}}>
  {/* 主文案 */}
  <div style={{ color: '#D1D5DB', fontSize: 13 }}>Title</div>
  {/* 次文案 */}
  <div style={{ color: '#8B949E', fontSize: 12, marginTop: 4 }}>Subtitle</div>
</div>
```

### 11.2 像素风按钮模板

```tsx
<button
  className="font-pixel"
  style={{
    background: '#1B1E26',
    border: '2px solid #58A6FF',
    color: '#58A6FF',
    borderRadius: 0,
    boxShadow: '4px 4px 0px 0px #090A0D',
    textTransform: 'uppercase',
    letterSpacing: '1px',
    cursor: 'pointer',
    transition: 'all 0.1s steps(3)',
  }}
>
  SAVE
</button>
```

### 11.3 Tailwind + 内联混用模板

```tsx
<div
  className="flex items-center gap-2.5 cursor-pointer"
  style={{
    color: '#8B949E',
    background: 'rgba(88,166,255,0.08)',
    borderRadius: 0,
    transition: 'all 0.1s steps(3)',
  }}
>
  <span style={{ color: '#58A6FF' }}>●</span>
  <span>Workspace name</span>
</div>
```

---

## 12. 版本记录

| 日期 | 变更 |
|---|---|
| 2026-07-01 | 视觉风格从 Dark Tech 改造为 Cyber-Pixel 像素风。色板重构（violet → cyan/pink 多色语义）、SVG 像素化、硬阴影替代辉光、零圆角、像素字体引入、CRT 扫描线、终端色板更新、移除 §6.4 呼吸动画 |
| 2026-06-27 | 新增 §6.4「模式激活态呼吸动画」参考实现（来源：FileManager 下载模式按钮） |
| 2026-06-22 | 初始版本。基于 Phase 1-8b 实现的视觉语言提炼 |
