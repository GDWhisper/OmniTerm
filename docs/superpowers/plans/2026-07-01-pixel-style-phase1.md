# 像素风格改造 — 阶段 1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 OmniTerm 暗色主题从 Dark Tech 改造为护眼科幻像素风（Cyber-Pixel），包含色板重构、SVG 像素化、硬阴影、像素字体、CRT 扫描线。

**Architecture:** 以 CSS 变量替换为核心，修改 `index.css` 中的 `.dark` 主题 token 值和全局样式规则；同时清理组件文件中的硬编码颜色，替换终端色板，添加 CRT overlay div。不涉及 DOM 结构变更。

**Tech Stack:** React + Vite + Tailwind CSS + CSS Custom Properties + xterm.js

**Spec:** `docs/superpowers/specs/2026-07-01-pixel-style-redesign-design.md`

---

### Task 1: 替换暗色主题 CSS 变量 + 新增像素风 Token

**Files:**
- Modify: `frontend/src/index.css:43-75`

- [ ] **Step 1: 替换 `.dark` 块中的所有变量值**

将 `frontend/src/index.css` 第 43-75 行的 `.dark` 块替换为：

```css
.dark {
  /* backgrounds — deep space gray with subtle blue-purple tint */
  --bg-base: #12141A;
  --bg-elevated: #1B1E26;
  --bg-surface: #242832;
  /* borders */
  --border-subtle: #30363D;
  --border-strong: #484F58;
  /* text — soft gray, no pure white */
  --text-primary: #D1D5DB;
  --text-secondary: #8B949E;
  --text-muted: #8B949E;
  --text-faint: #484F58;
  --text-dim: #30363D;
  /* accent — pastel neon cyan */
  --accent: #58A6FF;
  --accent-bright: #79C0FF;
  --accent-pink: #F778BA;
  /* danger — soft coral red */
  --danger: #FF7B72;
  --danger-12: rgba(255, 123, 114, 0.12);
  /* success — soft neon green */
  --success: #7EE787;
  /* warning — soft amber orange */
  --warning: #FFA657;
  /* pixel hard shadow */
  --pixel-shadow: #090A0D;
  /* scrollbar */
  --scrollbar-thumb: #484F58;
  --scrollbar-track: #12141A;
  color-scheme: dark;
}
```

注意以下变更：
- 移除了 `--accent-10`, `--accent-14`, `--accent-glow-sm`, `--accent-glow-md`, `--danger-glow`, `--success-glow`
- 新增了 `--accent-pink`, `--pixel-shadow`, `--warning`

- [ ] **Step 2: 移除 `:root` 块中的 glow 变量**

在 `:root` 块（第 9-41 行）中，删除以下行：

```css
--accent-glow-sm: 0 0 6px rgba(124, 58, 237, 0.4);
--accent-glow-md: 0 0 10px rgba(124, 58, 237, 0.5);
--danger-glow: 0 0 6px rgba(220, 38, 38, 0.3);
--success-glow: 0 0 6px #16a34a;
```

同时在 `:root` 块末尾（`--success` 之后）添加 `--warning` 和 `--pixel-shadow`：

```css
  --warning: #ca8a04;
  --pixel-shadow: #c4bdb0;
```

保留 `--accent-10` 和 `--accent-14`（亮色主题仍在使用）。

- [ ] **Step 3: 启动前端开发服务器并验证**

Run: `cd /home/pax/coding/OmniTerm-dev && ./dev.sh start`

在浏览器中确认：
- 暗色主题下背景色变为深空灰（比之前略亮）
- 强调色从 violet 变为 cyan
- 无 console 报错（如果有 `var(--accent-glow-sm)` 引用报错，记录下来在 Task 2 修复）

- [ ] **Step 4: 提交**

```bash
cd /home/pax/coding/OmniTerm-dev
git add frontend/src/index.css
git commit -m "feat: 替换暗色主题 CSS 变量为像素风色板"
```

---

### Task 2: 添加全局像素化 CSS 规则 + 字体引入 + 修复所有 index.css 硬编码值

**Files:**
- Modify: `frontend/src/index.css`（多处）
- Modify: `frontend/index.html`

- [ ] **Step 1: 在 `index.html` 中引入像素字体**

在 `frontend/index.html` 的 `<head>` 中，`<meta name="viewport">` 之后添加：

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=VT323&display=swap" rel="stylesheet">
```

注：VT323 通过 Google Fonts 引入（覆盖英文像素字体需求）。Zpix（中文字体）暂不引入（需要自托管，且当前 UI 以英文为主）。

- [ ] **Step 2: 在 `index.css` 中新增全局像素化规则**

在 `index.css` 的 `@import "@xterm/xterm/css/xterm.css";` 行（第 77 行）之后，`:root` 布局变量块之前，添加：

```css
/* ────────────────────────────────────────────────────────────────────
   Pixel style — global SVG pixelation and font classes.
   ──────────────────────────────────────────────────────────────────── */

/* SVG pixelation — disable anti-aliasing for crisp pixel edges */
svg, svg * {
  shape-rendering: crispEdges;
}

svg path, svg rect, svg circle, svg line {
  stroke-linecap: square;
  stroke-linejoin: miter;
}

/* Pixel display font — titles, buttons, status labels only */
.font-pixel {
  font-family: 'VT323', 'Press Start 2P', monospace;
  letter-spacing: 1px;
  text-transform: uppercase;
}

/* CRT scanline overlay — 2% opacity, controlled by settings */
.crt-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
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

- [ ] **Step 3: 修复 Drag Bar 硬编码值和 glow 引用**

替换 drag bar 相关 CSS（第 101-175 行）：

**第 112-113 行** `.omniterm-drag-bar::after` — 移除 `border-radius: 1px`：

```css
.omniterm-drag-bar::after {
  content: '';
  position: absolute;
  background: var(--text-faint);
  border-radius: 0;
  transition: background 0.1s steps(3), box-shadow 0.1s steps(3);
}
```

**第 120-123 行** `.omniterm-drag-bar:hover::after` — 替换 glow 为描边：

```css
.omniterm-drag-bar:hover::after {
  background: var(--accent);
  box-shadow: none;
  border: 1px solid var(--accent);
}
```

**第 174 行** `.omniterm-drag-bar-v::after` — 移除圆角：

```css
  border-radius: 0;
```

- [ ] **Step 4: 修复 Pulse 动画的 glow 引用**

**第 129-160 行** — 替换两个 pulse 动画，移除 `box-shadow` 中的 glow 引用：

```css
.session-activity-pulse {
  animation: session-activity-pulse 1.2s ease-in-out infinite;
}

@keyframes session-activity-pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1.15);
  }
  50% {
    opacity: 0.5;
    transform: scale(1);
  }
}

.activity-pulse {
  animation: activity-pulse 1.2s ease-in-out infinite;
}

@keyframes activity-pulse {
  0%, 100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
```

- [ ] **Step 5: 修复 FileManager 组件 CSS 中的所有硬编码值**

逐一替换以下位置：

**第 272-273 行** `.fm-bc-root:hover`：
```css
.fm-bc-root:hover {
  background: rgba(88, 166, 255, 0.14);
  box-shadow: 4px 4px 0px 0px var(--pixel-shadow);
  color: var(--accent-bright);
  text-decoration: none !important;
}
```

**第 310 行** `.fm-btn` — `border-radius: 5px` → `border-radius: 0`

**第 335 行** `.fm-search-wrap .fm-search` — 替换 box-shadow：
```css
  box-shadow: 4px 4px 0px 0px var(--pixel-shadow);
```

**第 349 行** `.fm-search` — `border-radius: 5px` → `border-radius: 0`; `border: 1px` → `border: 2px`

**第 360 行** `.fm-search:focus`：
```css
.fm-search:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px var(--accent);
}
```

**第 368-411 行** — 替换 download-pulse 和 terminal-pulse 动画，使用新的 cyan 色值：

```css
/* ── Download mode (active button pulse) ── */
@keyframes fm-download-pulse {
  0%, 100% {
    background: rgba(88, 166, 255, 0.30);
    box-shadow: 4px 4px 0px 0px var(--pixel-shadow), inset 0 0 0 1px rgba(88, 166, 255, 0.55);
  }
  50% {
    background: rgba(88, 166, 255, 0.58);
    box-shadow: 4px 4px 0px 0px var(--pixel-shadow), inset 0 0 0 1px rgba(121, 192, 255, 0.85);
  }
}
.fm-btn-download-active {
  animation: fm-download-pulse 1.0s ease-in-out infinite;
  color: var(--accent);
}
.fm-btn-download-active:hover {
  background: rgba(88, 166, 255, 0.55);
  color: var(--accent-bright);
  box-shadow: 4px 4px 0px 0px var(--pixel-shadow);
}

/* ── Terminal button pulse (back-to-terminal outside CWD) ── */
@keyframes fm-terminal-pulse {
  0%, 100% {
    background: rgba(88, 166, 255, 0.30);
    box-shadow: 4px 4px 0px 0px var(--pixel-shadow), inset 0 0 0 1px rgba(88, 166, 255, 0.55);
  }
  50% {
    background: rgba(88, 166, 255, 0.58);
    box-shadow: 4px 4px 0px 0px var(--pixel-shadow), inset 0 0 0 1px rgba(121, 192, 255, 0.85);
  }
}
.fm-btn-terminal-active {
  animation: fm-terminal-pulse 1.0s ease-in-out infinite;
  color: var(--accent);
}
.fm-btn-terminal-active:hover {
  background: rgba(88, 166, 255, 0.55);
  color: var(--accent-bright);
  box-shadow: 4px 4px 0px 0px var(--pixel-shadow);
}
```

**第 431 行** `.fm-checkbox:hover` — 替换 drop-shadow：
```css
.fm-checkbox:hover {
  filter: drop-shadow(0 0 0 var(--accent));
}
```

**第 438 行** `.fm-drag-over`：
```css
  background: rgba(88, 166, 255, 0.04);
```

**第 449-451 行** `.fm-drag-overlay`：
```css
  background: rgba(88, 166, 255, 0.06);
  border: 2px dashed var(--accent);
  border-radius: 0;
```

**第 477 行** `.fm-table-wrap::-webkit-scrollbar-thumb` — `border-radius: 2px` → `border-radius: 0`

**第 564 行** `.fm-th-resize` — `border-radius: 1px` → `border-radius: 0`

**第 571 行** `.fm-th-resize:hover` — 移除 glow：
```css
.fm-th-resize:hover,
.fm-th-resize.fm-resizing {
  background: var(--accent);
  box-shadow: none;
}
```

**第 656 行** `.fm-act-icon` — `border-radius: 4px` → `border-radius: 0`

**第 679 行** `.fm-edit-input` — `border-radius: 4px` → `border-radius: 0`; `border: 1px` → `border: 2px`

**第 685 行** `.fm-edit-input`：
```css
  box-shadow: 0 0 0 1px var(--accent);
```

- [ ] **Step 6: 修复 Sidebar glow 类（第 753-767 行）**

替换为硬阴影或移除 glow：

```css
.sidebar-glow-violet {
  box-shadow: 4px 4px 0px 0px var(--pixel-shadow);
}

.sidebar-glow-violet-hover:hover {
  box-shadow: 4px 4px 0px 0px var(--pixel-shadow);
}

.sidebar-glow-green {
  box-shadow: none;
}

.sidebar-glow-red-hover:hover {
  box-shadow: none;
}
```

- [ ] **Step 7: 验证并修复编译错误**

Run: 在浏览器 DevTools 中检查是否有 CSS 变量引用错误（如 `var(--accent-glow-sm)` 仍被引用）

使用 Grep 搜索 `index.css` 中剩余的 `--accent-glow` 和 `--success-glow` 和 `--danger-glow` 引用：

```bash
grep -n 'glow' frontend/src/index.css
```

Expected: 无结果（所有 glow 引用已清除）

- [ ] **Step 8: 提交**

```bash
git add frontend/src/index.css frontend/index.html
git commit -m "feat: 添加全局像素化 CSS 规则 + 修复 index.css 硬编码值"
```

---

### Task 3: 替换终端色板

**Files:**
- Modify: `frontend/src/hooks/useTerminal.ts:18-23`

- [ ] **Step 1: 替换 `DARK_TERMINAL_THEME` 常量**

将 `frontend/src/hooks/useTerminal.ts` 第 18-23 行替换为：

```ts
const DARK_TERMINAL_THEME = {
  background: '#12141A',
  foreground: '#D1D5DB',
  cursor: '#58A6FF',
  selectionBackground: 'rgba(88, 166, 255, 0.25)',
  black: '#12141A',
  red: '#FF7B72',
  green: '#7EE787',
  yellow: '#FFA657',
  blue: '#58A6FF',
  magenta: '#F778BA',
  cyan: '#79C0FF',
  white: '#D1D5DB',
  brightBlack: '#484F58',
  brightRed: '#FFA198',
  brightGreen: '#A5D6A7',
  brightYellow: '#FFCB6B',
  brightBlue: '#79C0FF',
  brightMagenta: '#FF9BCE',
  brightCyan: '#A5D8FF',
  brightWhite: '#E6EDF3',
}
```

注意：新增了完整的 ANSI 16 色定义，之前暗色主题没有 ANSI 覆盖（使用 xterm 默认值）。

- [ ] **Step 2: 在浏览器中验证终端颜色**

打开终端面板，输入 `ls --color` 确认 ANSI 颜色使用像素风色板（绿色目录、红色错误等）。

- [ ] **Step 3: 提交**

```bash
git add frontend/src/hooks/useTerminal.ts
git commit -m "feat: 替换终端色板为像素风 ANSI 16 色"
```

---

### Task 4: 清理组件文件中的内联硬编码颜色

**Files:**
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`
- Modify: `frontend/src/components/FileManager/FileManager.tsx`
- Modify: `frontend/src/components/FileManager/FileDrawer.tsx`
- Modify: `frontend/src/components/FileManager/FileEditor.tsx`

- [ ] **Step 1: 清理 Sidebar.tsx 中的硬编码颜色**

在 `frontend/src/components/Sidebar/Sidebar.tsx` 中替换以下位置：

**第 897 行** — 品牌文本渐变色：
```tsx
style={{ background: 'linear-gradient(90deg, var(--accent), var(--accent-bright))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}
```

**第 906 行** — 返回终端 CWD 按钮颜色：
```tsx
style={{ width: 24, height: 24, color: isOutsideTerminalCwd ? 'var(--accent-bright)' : 'var(--text-faint)', fontSize: 14 }}
```

**第 957 行** — 警告图标：
```tsx
<span style={{ fontSize: 14, color: 'var(--warning)' }}>⚠</span>
```

**第 1189 行** — session attention "decision" 点颜色：
```tsx
? 'var(--warning)'
```

**第 1214 行** — attention badge 背景（decision 状态）：
```tsx
? 'rgba(255, 166, 87, 0.2)'
```

**第 1218-1219 行** — attention badge 文本颜色（decision 状态）：
```tsx
? 'var(--warning)'
```

- [ ] **Step 2: 清理 FileManager.tsx 中的硬编码颜色**

在 `frontend/src/components/FileManager/FileManager.tsx`：

**第 862 行** — workspace 外警告图标：
```tsx
style={{ marginLeft: 6, color: 'var(--warning)', cursor: 'help', flexShrink: 0 }}
```

- [ ] **Step 3: 清理 FileDrawer.tsx 中的硬编码颜色**

在 `frontend/src/components/FileManager/FileDrawer.tsx`：

**第 298 行** — 外部变更警告文本：
```tsx
<span style={{ color: 'var(--warning)', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
```

**第 516 行** — 重新加载按钮边框：
```tsx
border: '2px solid var(--warning)',
```

**第 519 行** — 重新加载按钮文本：
```tsx
color: 'var(--warning)',
```

- [ ] **Step 4: 清理 FileEditor.tsx 中的语法高亮颜色**

在 `frontend/src/components/FileManager/FileEditor.tsx`：

**第 40-42 行** — number/bool/null 颜色：
```tsx
  [tags.number]: 'var(--warning)',
  [tags.bool]: 'var(--warning)',
  [tags.null]: 'var(--warning)',
```

**第 102-103 行** — 搜索匹配高亮：
```tsx
  '.cm-searchMatch': { backgroundColor: 'rgba(255, 166, 87, 0.2)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(255, 166, 87, 0.4)' },
```

- [ ] **Step 5: 验证所有组件颜色替换完成**

Run:
```bash
grep -rn '#f59e0b\|#fbbf24\|#818cf8\|#c4b5fd' frontend/src/components/
```

Expected: 无结果

- [ ] **Step 6: 提交**

```bash
git add frontend/src/components/Sidebar/Sidebar.tsx frontend/src/components/FileManager/FileManager.tsx frontend/src/components/FileManager/FileDrawer.tsx frontend/src/components/FileManager/FileEditor.tsx
git commit -m "feat: 清理组件内联硬编码颜色，替换为 CSS 变量"
```

---

### Task 5: 添加 CRT 扫描线 overlay 到 Layout

**Files:**
- Modify: `frontend/src/components/Layout/Layout.tsx`

- [ ] **Step 1: 在桌面布局中添加 CRT overlay div**

在 `frontend/src/components/Layout/Layout.tsx` 第 180 行（`{tmuxCheatsheetOpen && <TmuxCheatsheetPopup />}` 之后，`</div>` 之前），添加：

```tsx
      {/* CRT scanline overlay — controlled by settings, default off */}
      {crtScanlines && <div className="crt-overlay" />}
```

注意：`crtScanlines` 变量需要在组件顶部从 store 中获取。由于阶段 1 暂不创建设置 store，暂时硬编码为 `false`：

```tsx
      {/* CRT scanline overlay — controlled by settings, default off */}
      {false && <div className="crt-overlay" />}
```

阶段 2 会将其连接到设置面板开关。

- [ ] **Step 2: 在移动端 MobileLayout 中也添加 CRT overlay**

在 `MobileLayout` 组件的返回 JSX 中（`<SettingsPopup />` 附近），同样添加：

```tsx
      {false && <div className="crt-overlay" />}
```

- [ ] **Step 3: 验证**

启动开发服务器，确认无渲染错误。CRT overlay 当前不显示（硬编码 false）。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/components/Layout/Layout.tsx
git commit -m "feat: 添加 CRT 扫描线 overlay（默认关闭）"
```

---

### Task 6: 重写 UI 风格规范文档

**Files:**
- Rewrite: `docs/visual-design/ui-style-guide.md`

- [ ] **Step 1: 重写 `docs/visual-design/ui-style-guide.md`**

按照设计文档 §2.14 的要求，重写全文。核心变更点：

1. 设计语言总览从 "深色科技感 (Dark Tech)" 改为 "护眼科幻像素风 (Cyber-Pixel)"
2. 色板值全部替换为 Task 1 中的新值
3. 新增 §2 「SVG 像素化规则」章节（`crispEdges` + `stroke-linecap: square`）
4. 新增 §3 「硬阴影规则」章节（4px 硬阴影 + 按下位移）
5. 新增 §4 「像素字体规则」章节（VT323 用于展示区，JetBrains Mono 用于阅读区）
6. 新增 §5 「CRT 扫描线」章节（2% 透明度，可选开关）
7. 更新组件规范：按钮/输入框/选中项/drag bar/modal 为新样式
8. 移除所有 glow 相关描述
9. 更新自检清单，增加像素风检查项
10. 版本记录添加本次改造条目

完整的重写内容较长，参照设计文档 `docs/superpowers/specs/2026-07-01-pixel-style-redesign-design.md` 的阶段 1 各节定义，生成对应的 ui-style-guide.md 全文。

- [ ] **Step 2: 提交**

```bash
git add docs/visual-design/ui-style-guide.md
git commit -m "docs: 重写 UI 风格规范为像素风 (Cyber-Pixel)"
```

---

### Task 7: 最终视觉验证与修复

- [ ] **Step 1: 启动开发服务器并进行全面视觉回归**

Run: `./dev.sh start`

在浏览器中逐一检查：

1. **侧边栏**：背景色为深空灰、workspace 名称文本颜色正确、状态指示点颜色正确
2. **终端**：背景色匹配、`ls --color` ANSI 颜色正确、光标颜色为 cyan
3. **文件管理器**：toolbar 按钮无圆角、搜索框无圆角、文件行 hover/选中颜色正确、面包屑交互正常
4. **Drag Bar**：方形指示条、hover 时 cyan 描边
5. **弹窗**：Settings 弹窗有 2px 圆角和 8px 硬阴影
6. **SVG 图标**：所有图标呈现像素阶梯边缘
7. **亮色主题**：切换到亮色主题，确认基本可用（不要求像素风，仅确认不破坏）

- [ ] **Step 2: 修复发现的问题**

根据手动测试结果修复任何视觉问题。常见问题：
- 某些组件的 `border-radius` 未清零（通过 DevTools 检查）
- 残留的 glow `box-shadow` 引用（搜索 `rgba(167` 和 `rgba(196`）
- 字体 fallback 不正确

- [ ] **Step 3: 最终提交**

```bash
git add -A
git commit -m "fix: 像素风阶段 1 视觉回归修复"
```
