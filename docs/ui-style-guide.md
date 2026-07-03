# OmniTerm UI Style Guide

> Single source of truth for OmniTerm's Phase 3 pixel game UI system.
> Last updated: 2026-07-03

> **相关文档**：[`docs/frontend-patterns.md`](frontend-patterns.md) 记录了
> 状态栏面板的文件结构、hook 用法、子组件拆分、复制清单等**代码架构**约定。
> 本文档只管**视觉规格**（token、尺寸、颜色、态）。两边互不重复。

## 1. Theme System

Two themes controlled by `.dark` on `<html>`:

### 1.1 Parchment A2 Light (primary / default)

**背景三阶段**：base → elevated → surface，逐渐变饱和、略变深。
所有 `bg-*` 都是**暖色羊皮纸**，不允许纯白或接近纯白（见 §1.3 规则）。

| Token | Value | Usage |
|---|---|---|
| `--bg-base` | `#F5ECD8` | Page & panel base (最柔和的底) |
| `--bg-elevated` | `#EBE0C4` | Cards, panels, secondary buttons |
| `--bg-surface` | `#F0E1B0` | Inputs, recessed rails, highlights (饱和度最高，习惯「recessed 凹下去」） |
| `--text-primary` | `#3A2E1F` | Main text (~11:1 contrast) |
| `--text-secondary` | `#6B5D45` | Secondary text |
| `--text-faint` | `#A89474` | Placeholder, disabled |
| `--text-dim` | `#C9B88A` | Weakest text |
| `--border-subtle` | `#D4C4A0` | Panel dividers |
| `--border-strong` | `#3A2E1F` | Panel outer borders |
| `--pixel-shadow` | `#8B7755` | Hard shadow color |
| `--wood-dark` | `#8B5A2B` | Title bars, primary buttons |
| `--wood-shadow` | `#3A2E1F` | Title bar bottom border |
| `--gold-light` | `#FFCB6B` | Decorative highlights, corner nails |
| `--accent` | `#58A6FF` | Interactive elements |
| `--accent-pink` | `#F778BA` | Selected/important markers |
| `--success` | `#5A8F3A` | Success, running state |
| `--warning` | `#D4A05A` | Warnings |
| `--danger` | `#C85A3A` | Destructive actions |

### 1.2 底色规则：禁止纯白（No Pure White Backgrounds）

**适用于亮色主题**（暗色主题本就是深色，不适用本规则）。

**所有亮色背景必须是羊皮纸色或类羊皮纸色**。不允许出现：

- 纯白 `#FFFFFF` / `#FFF`
- 接近纯白：如 `#FDF8EA`（RGB 253/248/234，三个通道差距 < 21，人眼几乎看不出是“颜色”）
- 其他任何 R≈G≈B 且都 > 240 的色调

**判断口诀**：
- 暖色羊皮纸：R > G > B，且 R-B 差距 ≥ 25 （明显黄调）
- 接受范围举例：`#F5ECD8`（base）、`#EBE0C4`（elevated）、`#F0E1B0`（surface）
- 不接受举例：`#FFFFFF`、`#FAFAFA`、`#FDF8EA`（现 surface 变体）、`#F8F4E8`（黄调不够）

**为何如此**：
- 羊皮纸调能避免 “刺白”，为长时间使用的开发者 UI 提供眼眼高负荷场景下的舒适度
- 羊皮纸色能更好地与木纹标题栏（`var(--wood-dark)`）、金色装饰（`var(--gold-light)`）融合
- 暗色主题本就是 `#12-#24` 几度低饱和 灰蓝，亮色主题不能反向套用「黑」补「白」二象性，要从羊皮纸调中选

**例外**（可使用较亮色调）：
- **文字颜色**本身可以亮（如 `var(--text-faint)` `#A89474`、木底奶白 `#FAF2DE`），不適用本规则
- 黑色屏幕深色背景（`#12141A` 终端）不受限制
- SVG 插画内部色用项目预定义 token，不允许引入新的色

**检测**：`git grep -nE '#[Ff][8-F][8-F][8-F][8-F][8-F][8-F]' frontend/src` 应只命中：
- `#FAF2DE`（文字·水黄奶）
- `#FFCB6B`（金色装饰，--gold-light）
- 其他高亮加饱和的金色暖调

如未命中以上三项中的值，是 bug，需修正或加进 token。

### 1.3 Deep-space Dark (night mode, `.dark`)

| Token | Value |
|---|---|
| `--bg-base` | `#12141A` |
| `--bg-elevated` | `#1B1E26` |
| `--bg-surface` | `#242832` |
| `--text-primary` | `#D1D5DB` |
| `--text-secondary` / `--text-muted` | `#8B949E` |
| `--text-faint` | `#484F58` |
| `--border-subtle` | `#30363D` |
| `--border-strong` | `#484F58` |
| `--pixel-shadow` | `#090A0D` |
| `--accent` | `#58A6FF` |
| `--success` | `#7EE787` |
| `--danger` | `#FF7B72` |
| `--warning` | `#FFA657` |

**Terminal always stays dark**: even in light theme, xterm viewport uses `#12141A` background + Phase 1 pastel neon ANSI palette.

---

## 2. Font Layers

Three CSS classes, each gated by body class `body.pixel-font-on`:

| Class | Font stack | When to use |
|---|---|---|
| `.font-logo` | `'Press Start 2P', 'VT323', monospace` | Logo wordmark only |
| `.font-pixel` | `'VT323', 'Press Start 2P', monospace` | Titles, buttons, status labels, short display text |
| `.font-reader` | `'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace` | Code, body text, inputs, terminal — always use this for readable content |

Without `body.pixel-font-on`, `.font-logo` and `.font-pixel` fall back to plain `monospace`.

### Size reference

| Context | Class | Size | Letter-spacing |
|---|---|---|---|
| Logo wordmark | `.font-logo` | 17px | 1px |
| Splash screen title | `.font-logo` | 32px | 2px |
| Panel title bar | `.font-pixel` | 13px | 3px |
| Button text | `.font-pixel` | 13-14px | 2px |
| List items | `.font-pixel` | 15px | 2px |
| Body / input | `.font-reader` | 11-14px | 0 |

All `.font-pixel` text is `text-transform: uppercase`.

---

## 3. Pixel UI Primitives

### 3.1 OmniTermLogo (`OmniTermLogo` component)

16x16 pixel sprite rendered at integer multiples (48px sidebar, 96px splash, 16px favicon). Composition: dark-brown CRT frame, `#12141A` screen, green `>` prompt, blue `_` cursor. Render with `image-rendering: pixelated`.

Location: `frontend/src/components/Icons/OmniTermLogo.tsx`

### 3.2 PixelButton (4 variants)

All gated by `body.pixel-ui-on`. Share base class `.btn-pixel`.

| Variant | Classes | Background | Border | Shadow |
|---|---|---|---|---|
| Primary | `.btn-pixel .btn-pixel-primary` | `var(--wood-dark)` | `2px solid var(--wood-shadow)` | `3px 3px 0 var(--pixel-shadow-light)` |
| Secondary | `.btn-pixel .btn-pixel-secondary` | `var(--bg-elevated-light)` | `2px solid var(--wood-dark)` | `2px 2px 0 var(--pixel-shadow-light)` |
| Accent | `.btn-pixel .btn-pixel-accent` | `var(--accent-light)` | none | `0 3px 0 var(--wood-shadow)` |
| Danger | `.btn-pixel .btn-pixel-danger` | `var(--bg-elevated-light)` | `2px solid var(--danger-light)` | `2px 2px 0 var(--pixel-shadow-light)` |

**Active state** (all variants): `transform: translate(3px, 3px); box-shadow: none;`
**Disabled**: `opacity: 0.5; cursor: not-allowed;`

### 3.3 PixelSprites (`PixelSprites` component)

16x16 viewBox sprites, integer-scale rendering. 6 types:

| Sprite | Purpose | Primary color |
|---|---|---|
| `folder` | Folder (closed/open) | `#8B5A2B` / `#A06A3B` |
| `file` | Generic file | `#A89474` / `#FAF2DE` |
| `file-code` | Code file | `#58A6FF` |
| `file-md` | Markdown | `#79C0FF` |
| `file-config` | TOML/JSON/YAML | `#FFA657` |
| `status-running` / `status-stopped` | Session status | `#7EE787` / `#A89474` |

Location: `frontend/src/components/Icons/PixelSprites.tsx`

### 3.4 SegmentedProgress

HP/XP-style discrete block bar. Replaces continuous progress bars.

```css
.progress-segmented-bar { display: flex; gap: 2px; height: 8px; }
.progress-segmented-segment { flex: 1; background: #D4C4A0; }
.progress-segmented-segment.filled { background: #5A8F3A; }
```

Label: `.progress-segmented-label` — 11px `.font-pixel`, letter-spacing 2px.

### 3.5 DialogueToast

Undertale-style RPG dialogue box for key notifications.

```css
.dialogue-toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  max-width: 520px; padding: 12px 18px;
  background: #12141A; border: 3px solid var(--wood-shadow);
  color: #FAF2DE; font-family: 'VT323', monospace; font-size: 16px;
  box-shadow: 4px 4px 0 var(--pixel-shadow);
}
```

Includes corner nails (gold 8x8 squares), blinking pink caret `.dialogue-caret`, and highlight classes `.highlight-name` (gold) / `.highlight-emotion` (pink).

---

## 4. Panel Title Bars

`.panel-title-bar` — wood-brown strip at the top of every panel (Sidebar sections, Terminal, FileManager, Settings, Modal).

```css
body.pixel-ui-on .panel-title-bar {
  padding: 5px 10px;
  background: var(--wood-dark);      /* #8B5A2B light / #2A2520 dark */
  color: #FAF2DE;
  font-family: 'VT323', monospace;
  font-size: 13px;
  letter-spacing: 3px;
  text-transform: uppercase;
  border-bottom: 2px solid var(--wood-shadow);
}
```

**Content pattern**: `[decorator] TITLE [.title-bar-spacer] [.title-bar-badge / .title-bar-path]`

- `.title-bar-spacer` — `margin-left: auto`, pushes right-side items to the end
- `.title-bar-badge` — small status pill (e.g. `LIVE`), dark background + green text
- `.title-bar-path` — gold-colored path text (e.g. current directory)

The sidebar logo uses a separate `.logo-title-bar` with larger padding (`14px 10px`) and the `.font-logo` wordmark.

### 4.1 Status Badge — 木底黑框（不可按状态指示器）

任何**不可点击的状态指示器**（连接状态、session 状态、运行状态等）复用
以下视觉：**深色背景 + 亮色文字**，**不加 border、不加 box-shadow**。

**设计动机**：上一个版本中，底部连接状态带 border + surface 底色 + 硬阴影，
看起来像一个未被点击的 button，造成误解——状态指示器「不可点」不应该是 button 形状。

**参考实现**：`.title-bar-badge`（`● LIVE`），在 §4 定义。状态 badge
不限于 title bar 内部使用，是独立 pattern。

**视觉规范**：

| 属性 | 值 | 原因 |
|------|----|------|
| 背景 | `var(--wood-shadow, #3A2E1F)` | 主题统一的深棕黑，明亮黄背景不适用 |
| 文字色 | 固定值：`#7EE787` (绿) / `#FF7B72` (红) | 不走主题变体——「连接活着」是**一致信号**，亮黄背景下的 `#5A8F3A` 绿看不清 |
| Padding | `2px 6px`（桌面）/ `1px 6px`（徽章尺寸） | 按内容高度压缩 |
| Border | 无 | 边框=button 错觉，已是反例 |
| Box-shadow | **inset 4 边**（见下） | 严防 border / outer shadow 误读为可点 |
| Border-radius | `0` | 全局硬角 |

#### Inset 3D 立体感（必须）

单纯的纯色黑底是「纸片」，加 inset 后变成「木板中鐵入的铁环」质感。
像素游戏中这是标准 3D 表现于段。

**使用条件**：仅适用 `var(--wood-shadow)` 深色背景的不可按 badge。
亮黄背景或带 outer shadow 的面板**不要使用**（inset 会出现「外凸里凹」矛盾视觉）。

**实现**：使用 4 条 1px inset box-shadow，**顶/左为深色凹边阴影**、**底/右为亮色凹边高光**：

```css
box-shadow:
  inset 0 1px 0 var(--wood-inset-dark),    /* 顶 1px 深色 */
  inset 1px 0 0 var(--wood-inset-dark),    /* 左 1px 深色 */
  inset 0 -1px 0 var(--wood-inset-light),  /* 底 1px 亮色 */
  inset -1px 0 0 var(--wood-inset-light);  /* 右 1px 亮色 */
```

**颜色 token**（在 `:root` 中定义）：

| Token | Value | 用途 |
|-------|-------|------|
| `--wood-inset-dark` | `#1F1812` | 顶/左 凹边阴影（< `--wood-shadow`） |
| `--wood-inset-light` | `#5A4530` | 底/右 凹边高光（> `--wood-shadow`） |

颜色均调在 wood 色系内，不引入新色相，不和 `#7EE787` / `#FF7B72` 状态色冲突。

**实现参考**（Sidebar 底部连接状态，`Sidebar.tsx` 1439–1463）：

```tsx
<div
  className="flex items-center gap-1.5"
  style={{
    padding: '2px 6px',
    background: 'var(--wood-shadow, #3A2E1F)',
    boxShadow:
      'inset 0 1px 0 var(--wood-inset-dark),' +
      'inset 1px 0 0 var(--wood-inset-dark),' +
      'inset 0 -1px 0 var(--wood-inset-light),' +
      'inset -1px 0 0 var(--wood-inset-light)',
  }}
>
  <SignalBarsSprite size={14} connected={connected} />
  <span
    className="font-pixel"
    style={{
      fontSize: 13,
      letterSpacing: 2,
      color: connected ? '#7EE787' : '#FF7B72',
    }}
  >
    {connected ? t('sidebar.link') : t('sidebar.lost')}
  </span>
</div>
```

**例外**（可使用亮背景 + 主题色）：移动端顶部状态栏（`MobileStatusBar`）、
任何贴在浅背景上的状态点。**例外的情况也不要加 border / shadow**。

---

## 5. Corner Nails

`.corner-nails` — gold 8x8 squares at the 4 corners of floating panels (Modal, ConfirmDialog, DialogueToast).

```html
<div class="corner-nails">
  <!-- content -->
  <span class="nail-bl"></span>
  <span class="nail-br"></span>
</div>
```

- `::before` and `::after` handle top-left and top-right
- `.nail-bl` and `.nail-br` child spans handle bottom-left and bottom-right
- Gold color: `var(--gold-light, #FFCB6B)` in light, `#8B7755` in dark

---

## 6. Hard Shadow Pattern

```css
/* Standard — buttons, cards */
box-shadow: 3px 3px 0 var(--pixel-shadow);

/* Active/pressed — shadow disappears, element shifts */
transform: translate(3px, 3px);
box-shadow: none;

/* Floating layers (Modal) — larger shadow */
box-shadow: 4px 4px 0 var(--pixel-shadow);
```

Rules:
- **Blur is always 0** — no soft shadows anywhere
- All interactive elements (buttons, toggles, clickable cards) get hard shadows
- Non-interactive panels do not need shadows
- Shadow color: `#8B7755` (light) / `#090A0D` (dark)

---

## 7. Game UI Elements

### 7.1 Selected Cursor (`.selected-cursor`)

Pink blinking `▶` on the left of the currently selected list item.

```css
.selected-cursor {
  color: #F778BA;
  font-size: 16px;
  animation: blink-cursor 1s steps(1) infinite;
}
.selected-cursor.inactive { color: transparent; animation: none; }
```

### 7.2 Terminal Pixel Border (`.terminal-panel-pixel`)

Gated by `body.pixel-ui-on`. Wood-brown frame around xterm, keeping the dark terminal background.

```css
body.pixel-ui-on .terminal-panel-pixel {
  background: var(--bg-elevated);
  border: 2px solid var(--wood-shadow);
  box-shadow: 3px 3px 0 var(--pixel-shadow);
}
body.pixel-ui-on .terminal-panel-pixel .xterm-viewport,
body.pixel-ui-on .terminal-panel-pixel .xterm {
  background: #12141A !important;
}
```

### 7.3 Pixel Toast (`.toast-pixel`)

Gated by `body.pixel-ui-on`. Dark background + colored pixel border + VT323 font.

```css
body.pixel-ui-on .toast-pixel {
  background: #12141A;
  border: 2px solid var(--success);
  color: #7EE787;
  font-family: 'VT323', monospace;
  font-size: 14px;
  box-shadow: 3px 3px 0 var(--pixel-shadow);
}
```

Variant classes: `.toast-error` (danger border/text), `.toast-warning` (warning), `.toast-info` (accent).

---

## 8. Settings Toggles

7 toggles total, each persisted to localStorage:

| Toggle | localStorage key | Default | Controls |
|---|---|---|---|
| Pixel UI | `omniterm_pixel_ui` | `true` | Title bars, buttons, progress, corner nails, selected cursor |
| Pixel Font | `omniterm_pixel_font` | `true` | Press Start 2P + VT323 font activation |
| Parchment Texture | `omniterm_parchment_texture` | `true` | Background dot-matrix texture |
| Transitions | `omniterm_transitions` | `true` | Workspace switch fade-in |
| Pixel Animations | `pixelAnimationsEnabled` | `true` | Mario-style bump/stomp/coin/starman animations (Phase 2) |
| Sound | `soundEnabled` | `true` | 8-bit sound effects (Phase 2) |
| CRT Scanlines | `crtScanlines` | `true` | CRT scanline overlay (Phase 2) |

When "Pixel UI" is off, all panels revert to Phase 1 flat style (no title bars, no corner nails, no progress bars).

---

## 9. Body Class Gating

Feature flags are applied as classes on `<body>`:

| Body class | Added when | What it enables |
|---|---|---|
| `body.pixel-ui-on` | `pixelUiEnabled === true` | `.btn-pixel-*`, `.panel-title-bar`, `.terminal-panel-pixel`, `.toast-pixel` styles |
| `body.pixel-font-on` | `pixelFontEnabled === true` | `.font-logo` and `.font-pixel` switch from monospace to pixel fonts |
| `body.parchment-texture` | `parchmentTextureEnabled === true` | Background dot-matrix overlay on body |
| `body.transitions-on` | `transitionsEnabled === true` | `.workspace-transition` fade animation |

Without the corresponding body class, the scoped CSS rules are inert — components render with plain fallback styles. This lets users disable individual game elements without touching the DOM.

---

## 10. Dark Theme Adaptation

Game UI elements adapt when `.dark` is present:

| Element | Light | Dark |
|---|---|---|
| Title bar background | `#8B5A2B` (wood) | `#2A2520` (graphite) |
| Title bar text | `#FAF2DE` | `#E6DFD0` |
| Title bar border | `#3A2E1F` | `#090A0D` |
| Primary button bg | `#8B5A2B` | `#2A2520` |
| Primary button text | `#FAF2DE` | `#E6DFD0` |
| Secondary button bg | `#EBE0C4` | `#1B1E26` |
| Secondary button border | `#8B5A2B` | `#484F58` |
| Hard shadow | `#8B7755` | `#090A0D` |
| Corner nails / gold | `#FFCB6B` | `#8B7755` (muted gold) |
| Progress empty segment | `#D4C4A0` | `#30363D` |
| Progress filled segment | `#5A8F3A` | `#7EE787` |
| Progress label | `#8B5A2B` | `#8B949E` |
| Logo version text | `#FFCB6B` | `#8B7755` |
| Parchment texture | dot-matrix overlay | disabled (plain `--bg-base`) |

---

## 11. Motion Reference

### Phase 2 animations (preserved)

| Class | Effect | Duration |
|---|---|---|
| `.pixel-bump` | Button press squash & stretch | 0.4s steps(6) |
| `.pixel-coin-pop` | Score text flies up and fades | 0.6s steps(5) |
| `.pixel-stomp` | Element squashes flat and disappears | 0.3s steps(4) |
| `.pixel-starman` | Border color high-frequency blink | 0.4s steps(1) infinite |

### Phase 3 additions

| Class | Effect | Duration |
|---|---|---|
| `.workspace-transition` | Fade + 4px Y shift | 0.3s steps(3) |
| `.dialogue-toast` entrance | Fade + 8px Y shift | 0.3s steps(3) |

All pixel animations use `steps()` for discrete 8-bit feel. Modals and standard UI still use `ease-out`.

---

## 12. Status Bar Popup — 尺寸与视觉规格

适用于状态栏按钮弹出的**复杂面板**（参考实现：Settings 面板）。
简单单 section 弹出面板不在此范。

### 尺寸

| 元素 | 桌面端 | 移动端 |
|------|--------|--------|
| Popup 高度 | 固定 `33vh`（切 tab 高度不变） | bottom sheet，`calc(100dvh - mobileTotal)` |
| Popup 宽度 | 视口 1/4（`25vw`） | `100%` |
| `maxHeight` 安全上限 | `useAnchorPopup` 算出 logo 底→按钮顶距离 | 同桌面 |
| Tab 列宽 | 92px（固定） | 隐去 tab，全宽 |
| 内容区 padding | 12px 14px | 12px 16px |
| Border radius | 10px | 16px |

### Tab 菜单视觉

| 元素 | 规格 |
|------|------|
| Tab 字体 | `.font-pixel` (VT323) 14px，letter-spacing 1.5px，**UPPERCASE** |
| Tab padding | `9px 8px 9px 10px` |
| Tab 左边框 | 3px（transparent 预留位，active 时变色） |
| Inactive tab | `var(--text-muted)` 文字，透明背景 |
| Inactive tab :hover | `var(--bg-elevated)` 背景，`var(--text-primary)` 文字 |
| **Active tab** | `var(--wood-dark)` 背景，`#FAF2DE` 文字，`var(--accent)` 3px 左边界 |
| Tab rail 背景 | `var(--bg-surface)` |
| Tab rail 右边框 | 2px `var(--wood-shadow)`（light `#3A2E1F` / dark `#090A0D`） |
| Transition | `background 0.1s steps(2), color 0.1s steps(2)`（pixel 离散过渡） |

### 暗色主题适配

| 元素 | 亮色 | 暗色 |
|------|------|------|
| Active tab 背景 | `var(--wood-dark)` = `#8B5A2B` | `#2A2520` |
| Active tab 文字 | `#FAF2DE` | `#E6DFD0` |
| Tab rail 右边框 | `var(--wood-shadow)` = `#3A2E1F` | `#090A0D` |

### 滚动条（与全局一致）

复用全局 scrollbar 规范：8px 宽、`border-radius: 0`、主题感知
（`var(--scrollbar-thumb)` / `var(--scrollbar-track)`），hover 变 `var(--accent)`。
Popup 自身 `overflow: hidden`，滚动交给有 `overflow-y: auto` 的内容容器
（`.settings-content` / `.tmux-cheatsheet-content`）。

### i18n 视觉约定

- **Tab 文字**：英文 UPPERCASE（VT323 不支持中文，pixel 风统一）
  en/zh 两个 locale **写同样的英文值**（如 `settings.category.appearance: "APPEARANCE"`）
- **选项标签 / 标题 / hint**：正常翻译

---

## 13. SVG & Rendering Rules

```css
svg, svg * { shape-rendering: crispEdges; }
svg path, svg rect, svg circle, svg line {
  stroke-linecap: square;
  stroke-linejoin: miter;
}
```

- `crispEdges` disables anti-aliasing, curves auto-pixelate
- Keep `stroke-width` even (2px, 4px) to avoid sub-pixel blur
- Sprite icons: 16x16 viewBox, render at integer multiples only
- No emoji characters in UI — use SVG, CSS, or monospace glyphs (`▸`, `●`, `◆`, `★`)

---

## 14. New Component Checklist

Before adding any new UI element, verify:

- [ ] Uses CSS variables (`var(--token)`) not hardcoded hex
- [ ] **背景色遵守 §1.2 「禁止纯白」规则** — R > G > B 且 R-B ≥ 25，明显黄调羊皮纸
- [ ] **不可按的状态指示器遵守 §4.1 Status Badge 规范** — 深棕黑底 + 亮色文字，**无 border / 无 box-shadow**（避免看起来像 button）
- [ ] Hard shadow uses `3px 3px 0` (not `4px` blur, not glow)
- [ ] `border-radius: 0` everywhere (modals: `2px` max)
- [ ] Pixel font (`.font-pixel`) only for display text, not body/code
- [ ] Interactive element has `body.pixel-ui-on` gate if it's a game element
- [ ] Tested in both light and dark themes
- [ ] Transitions use `steps(3)` for pixel elements, `ease-out` for modals
- [ ] No emoji characters — SVG or monospace glyphs only
- [ ] SVG has `shape-rendering: crispEdges`, even stroke-widths
