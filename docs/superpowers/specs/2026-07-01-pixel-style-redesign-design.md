# OmniTerm 像素风格改造设计文档

> 日期：2026-07-01
> 状态：待实施
> 方案：分两阶段迭代（阶段 1 视觉 → 阶段 2 动效音效）

---

## 1. 概述

将 OmniTerm 当前的 **深色科技感 (Dark Tech)** 视觉语言改造为 **护眼科幻像素风 (Cyber-Pixel)**，包含：

- **阶段 1**：色板重构、SVG 像素化、硬阴影、像素字体引入、CRT 扫描线、同步更新 `docs/ui-style-guide.md`
- **阶段 2**：四种马里奥式游戏化正反馈动效、8-bit 音效合成、设置面板开关

### 1.1 设计目标

1. 护眼优先：深空灰底色 + 粉彩霓虹（Pastel Neon），对比度控制在 ~8:1，无纯黑纯白
2. 柔和像素风：按钮/输入框/选中项零圆角，modal 保留 2px；全局 SVG `crispEdges`
3. 多色语义：cyan 主交互、pink 选中标记、green 成功、orange 警告、red 危险
4. 游戏感克制：动效使用 `steps()` 离散帧，仅限正向结果确认，500ms 节流，打字静默
5. 用户可控：游戏化动效、8-bit 音效、CRT 扫描线均为可选开关，默认关闭

### 1.2 不变更项

- 三栏布局结构（Sidebar / Terminal / FileManager）不变
- 组件 DOM 结构不变
- Tailwind CSS 工具类使用方式不变
- 亮/暗双主题切换机制不变（本次仅改造暗色主题，亮色主题暂不涉及）

---

## 2. 阶段 1：视觉改造

### 2.1 色板（暗色主题 CSS Variables）

#### 背景色阶

| Token | 当前值 | 新值 | 用途 |
|---|---|---|---|
| `--bg-base` | `#0a0a0f` | `#12141A` | 最底层背景（深空灰，带微弱蓝紫倾向） |
| `--bg-elevated` | `#111827` | `#1B1E26` | 面板/卡片背景 |
| `--bg-surface` | `#1e293b` | `#242832` | 输入框、hover 背景 |

#### 文本色阶

| Token | 当前值 | 新值 | 用途 |
|---|---|---|---|
| `--text-primary` | `#e2e8f0` | `#D1D5DB` | 主内容文本（对比度 ~11:1） |
| `--text-secondary` | `#cbd5e1` | `#8B949E` | 次要内容（对比度 ~5:1） |
| `--text-muted` | `#94a3b8` | `#8B949E` | 辅助文本（与 secondary 合并） |
| `--text-faint` | `#64748b` | `#484F58` | 占位/禁用 |
| `--text-dim` | `#475569` | `#30363D` | 最弱文本 |

#### 强调色（从 violet 单色 → 多色语义）

| Token | 当前值 | 新值 | 语义 |
|---|---|---|---|
| `--accent` | `#a78bfa` (violet) | `#58A6FF` (柔和星蓝) | 主强调：链接、交互、focus |
| `--accent-bright` | `#c4b5fd` | `#79C0FF` | hover 高亮 |
| `--accent-pink` | (新增) | `#F778BA` | 选中/重要标记 |
| `--danger` | `#ef4444` | `#FF7B72` (柔和珊瑚红) | 删除/危险操作 |
| `--success` | `#4ade80` | `#7EE787` (柔和荧光绿) | 成功/运行中 |
| `--warning` | `#f59e0b` | `#FFA657` (柔和琥珀橙) | 警告状态 |

#### 边框与阴影

| Token | 当前值 | 新值 | 用途 |
|---|---|---|---|
| `--border-subtle` | `#1e293b` | `#30363D` | 面板间分隔线 |
| `--border-strong` | `#334155` | `#484F58` | 浮动层边线 |
| `--pixel-shadow` | (新增) | `#090A0D` | 像素硬阴影色 |

#### 移除的 Token

以下 glow 变量全部删除，被硬阴影替代：

- `--accent-glow-sm`、`--accent-glow-md`、`--accent-glow-lg`
- `--danger-glow`、`--success-glow`
- 所有 `rgba(167, 139, 250, ...)` 的 accent alpha 变体（`--accent-10`、`--accent-12`、`--accent-14`、`--accent-18`）

#### 滚动条

| Token | 新值 |
|---|---|
| `--scrollbar-track` | `#12141A` |
| `--scrollbar-thumb` | `#484F58` |
| `--scrollbar-thumb-hover` | `#58A6FF` |

### 2.2 字体

| 用途 | 字体栈 | CSS 类 |
|---|---|---|
| 标题 / 按钮 / 状态标签（展示区） | `'Zpix', 'VT323', 'Press Start 2P', monospace` | `.font-pixel` |
| 代码 / 正文 / 输入框（阅读区） | `'JetBrains Mono', 'Fira Code', monospace` | `.font-reader`（不变） |

规则：
- 像素字体仅用于展示型文本，**禁止**用于代码区和长文本
- `.font-pixel` 附加 `letter-spacing: 1px`，英文全大写 `text-transform: uppercase`
- 通过 Google Fonts 或本地 `@font-face` 引入 Zpix 和 VT323
- 字号阶梯（11px ~ 14px）不变

### 2.3 圆角

| 组件 | 当前 | 新值 |
|---|---|---|
| 按钮 / 输入框 / 选中项 | 4-6px | `0` |
| Dropdown / Context Menu | 6px | `0` |
| Modal / Confirm Dialog | 10px | `2px`（保留微弱圆角） |
| Scrollbar thumb | 2px | `0` |
| Drag Bar pill | 2px | `0` |

### 2.4 阴影：从辉光到硬阴影

**全局规则**：移除所有 `box-shadow` 中的 blur（模糊值），替换为像素硬阴影。

```css
/* 默认态 */
box-shadow: 4px 4px 0px 0px var(--pixel-shadow);

/* 按下态 — 阴影消失，按钮位移 */
box-shadow: none;
transform: translate(4px, 4px);
```

### 2.5 SVG 像素化

全局 CSS 规则：

```css
svg, svg * {
  shape-rendering: crispEdges;
}

svg path, svg rect, svg circle, svg line {
  stroke-linecap: square;
  stroke-linejoin: miter;
}
```

- `crispEdges` 关闭抗锯齿，曲线自动呈现像素阶梯
- `stroke-linecap: square` + `stroke-linejoin: miter` 确保描边锐利
- SVG stroke-width 保持偶数（2px, 4px），避免在像素网格上发虚

### 2.6 按钮样式

```css
/* Primary — cyan 描边 + 硬阴影 */
background: var(--bg-elevated);
border: 2px solid var(--accent);
color: var(--accent);
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

/* Secondary — 灰色描边 */
border: 2px solid var(--border-strong);
color: var(--text-primary);

/* Danger — 红色描边 */
border: 2px solid var(--danger);
color: var(--danger);
```

### 2.7 输入框样式

```css
background: var(--bg-surface);
border: 2px solid var(--border-strong);
color: var(--text-primary);
border-radius: 0;

/* Focus — cyan 描边，无 blur ring */
border-color: var(--accent);
box-shadow: 0 0 0 1px var(--accent);
```

### 2.8 选中项 / Hover 项

```css
/* Hover */    background: rgba(88, 166, 255, 0.08);
/* Selected */ background: rgba(88, 166, 255, 0.14); border: 2px solid var(--accent);
/* Moving */   background: rgba(88, 166, 255, 0.18);
```

### 2.9 Drag Bar

| 属性 | 当前 | 新值 |
|---|---|---|
| 指示器形态 | 圆角 pill (`border-radius: 2px`) | 方形象素条 (`border-radius: 0`) |
| 静息色 | `#64748b` | `#484F58` |
| Hover 色 | `#a78bfa` + violet 辉光 | `#58A6FF` + `border: 1px solid #58A6FF` |
| 过渡 | `0.15s ease` | `0.1s steps(3)` |

### 2.10 Modal / 浮动层

```css
background: var(--bg-elevated);
border: 2px solid var(--border-strong);
border-radius: 2px;
box-shadow: 8px 8px 0px 0px var(--pixel-shadow);
```

### 2.11 CRT 扫描线（可选）

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

- 默认关闭，通过设置面板开关控制
- 开关值持久化到 `localStorage`

### 2.12 终端色板

`hooks/useTerminal.ts` 中的 xterm 终端色板替换为像素风色值：

| 属性 | 新值 |
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

### 2.13 内联硬编码颜色清理

以下组件文件中的硬编码 hex 值需替换为 CSS 变量引用：

| 文件 | 硬编码值 | 替换为 |
|---|---|---|
| `components/Sidebar/Sidebar.tsx` | `#818cf8` | `var(--accent)` |
| 同上 | `#c4b5fd` | `var(--accent-bright)` |
| 同上 | `#fbbf24` | `var(--warning)` |
| 同上 | `#f59e0b` (×2) | `var(--warning)` |
| `components/FileManager/FileManager.tsx` | `#f59e0b` | `var(--warning)` |
| `components/FileManager/FileDrawer.tsx` | `#f59e0b` (×3) | `var(--warning)` |
| `components/FileManager/FileEditor.tsx` | CodeMirror 语法高亮色 | 像素风色值 |

### 2.14 UI 风格规范文档更新

阶段 1 视觉改造完成后，同步重写 `docs/ui-style-guide.md`：

- 全文色板值替换为 §2.1 定义的新值
- 新增「SVG 像素化规则」章节（§2.5 内容）
- 新增「硬阴影规则」章节（§2.4 内容）
- 新增「像素字体规则」章节（§2.2 内容）
- 新增「CRT 扫描线」章节（§2.11 内容）
- 更新组件规范（按钮/输入框/选中项/drag bar/modal）为新样式
- 更新自检清单，增加像素风相关检查项
- 移除所有 glow 相关描述，替换为硬阴影描述
- 版本号记录本次改造

### 2.15 亮色主题

本次改造**仅涉及暗色主题**。亮色主题的像素风适配作为后续迭代，暂不涉及。

---

## 3. 阶段 2：游戏化动效与音效

### 3.1 动效清单

#### 顶砖块弹跳 (Block Bump)

- **触发场景**：Primary 按钮点击、新建 workspace、展开面板
- **CSS 动画**：`mario-jump`，0.4s，`steps(6, end)`
- **关键帧**：起蹲挤压 → 腾空拉伸 → 落地挤压 → 复位
- **音效**：无

```css
@keyframes mario-jump {
  0%   { transform: translateY(0) scale(1, 1); }
  20%  { transform: translateY(2px) scale(1.1, 0.9); }
  50%  { transform: translateY(-8px) scale(0.95, 1.05); }
  80%  { transform: translateY(0) scale(1.05, 0.95); }
  100% { transform: translateY(0) scale(1, 1); }
}
```

#### 吃金币飞升 (Coin Pop)

- **触发场景**：保存成功、编译通过、AI 生成完成、上传成功
- **CSS 动画**：`coin-pop`，0.6s，`steps(5, end)`
- **内容**：`+1 ✓` 文字向上弹跳消散，使用像素字体 + neon-green 色 + 像素硬阴影
- **音效**：coin（方波 800Hz→1200Hz，各 50ms）

```css
@keyframes coin-pop {
  0%   { transform: translateX(-50%) translateY(0) scale(0.5); opacity: 1; }
  50%  { transform: translateX(-50%) translateY(-20px) scale(1.2); opacity: 1; }
  100% { transform: translateX(-50%) translateY(-30px) scale(1); opacity: 0; }
}
```

#### 踩栗子消除 (Stomp Vanish)

- **触发场景**：删除文件、关闭报错弹窗、清除终端日志、标记任务完成
- **CSS 动画**：`stomp-vanish`，0.3s，`steps(4, end)`
- **效果**：元素瞬间压扁 `scaleY(0.1)` 后下坠消失
- **音效**：stomp（方波 400Hz→100Hz，100ms）

```css
@keyframes stomp-vanish {
  0%   { transform: scaleY(1); opacity: 1; }
  30%  { transform: scaleY(0.1); opacity: 1; }
  100% { transform: scaleY(0.1) translateY(10px); opacity: 0; }
}
```

#### 无敌星闪烁 (Starman Flash)

- **触发场景**：AI 生成中、编译进行中、批量上传中
- **CSS 动画**：`starman-flash`，0.4s，`steps(1, end)`，infinite
- **效果**：边框 cyan↔pink 高频切换 + 阴影跟随变色，内部内容不变
- **音效**：无

```css
@keyframes starman-flash {
  0%, 100% { border-color: var(--accent); box-shadow: 4px 4px 0px 0px var(--pixel-shadow); }
  50%      { border-color: var(--accent-pink); box-shadow: 4px 4px 0px 0px var(--accent-pink); }
}
```

### 3.2 动效工具函数

新增 `frontend/src/utils/pixelAnimations.ts`：

- `triggerScorePop(element, text)`: 在指定元素上方生成飞升特效（动态创建 DOM → 添加 CSS 类 → 动画结束后移除）
- `triggerStomp(element)`: 对指定元素触发踩扁消除动画（添加 CSS 类 → 动画结束后执行回调）
- 内置 500ms 节流：同一元素 500ms 内只触发一次
- 打字静默检测：用户连续输入时不触发动效，仅在命令执行后触发

### 3.3 8-bit 音效

新增 `frontend/src/utils/audioFeedback.ts`：

- 使用 Web Audio API 动态合成方波音效，不加载外部音频文件
- `play8BitSound('coin')`: 方波 800Hz→1200Hz 递增，各 50ms
- `play8BitSound('stomp')`: 方波 400Hz→100Hz 下降，100ms
- 音量默认 0.1 (10%)
- 读取 `localStorage` 中 `soundEnabled` 开关，默认关闭

### 3.4 设置面板

在 `stores/settingsStore.ts` 新增三个 boolean 开关：

| 开关 | 默认值 | 持久化 |
|---|---|---|
| `pixelAnimationsEnabled` | `false` | localStorage |
| `soundEnabled` | `false` | localStorage |
| `crtScanlines` | `false` | localStorage |

设置面板 UI 添加对应 toggle 开关，风格匹配像素风（方形 toggle + cyan 激活色）。

### 3.5 防抖与节流规则

- **500ms 节流**：连续操作（如 Ctrl+S 保存）500ms 内只触发一次动效和音效
- **打字静默**：用户连续打字时不触发动效，仅在命令执行后（编译、提交、AI 交互）触发
- **双开关**：动效和音效独立控制，可单独关闭

### 3.6 业务组件埋点

在各业务组件的对应触发点调用动效/音效工具函数：

| 组件 | 触发点 | 动效 |
|---|---|---|
| FileManager | 文件删除回调 | stomp-vanish + stomp 音效 |
| FileManager | 文件上传成功 | coin-pop + coin 音效 |
| Sidebar | 新建 workspace | mario-jump |
| Terminal | 命令执行成功 | coin-pop + coin 音效 |
| 全局 | AI 生成中 | starman-flash |
| 全局 | Primary 按钮 onClick | mario-jump |

---

## 4. 文件改动清单

### 阶段 1

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `frontend/src/index.css` | 重写 | 替换 CSS 变量值、全局 SVG crispEdges、移除 glow、圆角→0、硬阴影、新增像素字体引入和 `.font-pixel` 类、CRT 扫描线样式 |
| `frontend/index.html` | 新增 | 引入 Zpix / VT323 字体 |
| `components/Sidebar/Sidebar.tsx` | 修改 | 约 5 处内联硬编码颜色 → CSS 变量 |
| `components/FileManager/FileManager.tsx` | 修改 | 1 处 `#f59e0b` → `var(--warning)` |
| `components/FileManager/FileDrawer.tsx` | 修改 | 3 处 `#f59e0b` → `var(--warning)` |
| `components/FileManager/FileEditor.tsx` | 修改 | CodeMirror 语法高亮色 → 像素风色值 |
| `hooks/useTerminal.ts` | 修改 | xterm 终端色板 → 像素风色值 |
| `components/Layout/Layout.tsx` | 修改 | 添加 CRT 扫描线 overlay div |
| `docs/ui-style-guide.md` | 重写 | 全文更新为像素风规范（§2.14） |

### 阶段 2

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `frontend/src/index.css` | 新增 | 4 组 `@keyframes` 及对应 CSS 类 |
| `frontend/src/utils/pixelAnimations.ts` | 新增 | 动效触发工具函数 + 节流逻辑 |
| `frontend/src/utils/audioFeedback.ts` | 新增 | Web Audio API 方波音效合成 |
| `frontend/src/stores/settingsStore.ts` | 新增 | 三个 boolean 开关 |
| 设置面板组件 | 修改 | 添加 toggle 开关 UI |
| 各业务组件 | 修改 | 在触发点调用动效/音效函数 |
