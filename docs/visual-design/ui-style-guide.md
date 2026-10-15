# OmniTerm UI Style Guide

> Single source of truth for OmniTerm's Phase 3 pixel game UI system.
> Last updated: 2026-07-21

> **相关文档**：[`docs/architecture/frontend-patterns.md`](../architecture/frontend-patterns.md) 记录了
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

Three CSS classes. `.font-pixel`（及所有 `var(--pixel-font)` 用点）受**像素字体 BETA 开关**控制（设置 → 外观）：

| Class | Font stack | When to use |
|---|---|---|
| `.font-logo` | `'Press Start 2P', 'VT323', monospace` | Logo wordmark only |
| `.font-pixel` | 开关开：`'Silkscreen', 'VT323', 'Press Start 2P', monospace`；开关关：回退 `--reader-font` | Titles, buttons, status labels, short display text |
| `.font-reader` | `'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace` | Code, body text, inputs, terminal — always use this for readable content |

开关机制：`App.tsx` 依据 `appStore.pixelFontEnabled`（localStorage `omniterm_pixel_font`，**默认关**）切换 `body.pixel-font-on`，该类把 `--pixel-font` 从 `var(--reader-font)` 覆盖为 `var(--pixel-font-static)`。

**顶栏豁免**：顶栏一行永远保持像素 — `.logo-wordmark`（`--logo-font`）、`.logo-version`、`.panel-title-bar`、`.panel-title-bar .title-bar-tab` 直接使用 `var(--pixel-font-static)`，不受开关影响。

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

### CSS Variables (single source of truth)

| CSS Variable | Font stack | 说明 |
|---|---|---|
| `--logo-font` | `'Press Start 2P', 'VT323', monospace` | logo 字标，永远像素 |
| `--pixel-font-static` | `'Silkscreen', 'VT323', 'Press Start 2P', monospace` | 顶栏豁免专用，永远像素 |
| `--pixel-font` | 默认 `var(--reader-font)`；`body.pixel-font-on` 下 = `var(--pixel-font-static)` | 全部可切换像素文字走这个 |
| `--reader-font` | `'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace` | JS 镜像常量 `READER_FONT`（fonts.ts，供 xterm 等需要解析后字符串的消费者） |

### 像素字距 token（letter-spacing）

像素/logo 字体的字距统一走三档 token，**禁止硬编码 px 值**（阅读字体的 0.04em 级微调不在此列）：

| Token | 值 | 用途 |
|---|---|---|
| `--pixel-tracking-sm` | 0.5px | 徽标、小标签、logo 字标/版本号 |
| `--pixel-tracking-md` | 1.5px | 按钮、tab、列头、todo 计数 |
| `--pixel-tracking-lg` | 2px | 面板标题条（`.panel-title-bar`）、TodoBoard 标题 |

### 禁止硬编码 font-family

**组件/样式中禁止直接写 `font-family` 字面量。** 必须使用以下机制之一：
- **CSS 类**：`.font-logo` / `.font-pixel` / `.font-reader`（优先）
- **CSS 变量**：`var(--logo-font)` / `var(--pixel-font)` / `var(--reader-font)`（需要其他属性组合时；inline style 同样用 `fontFamily: 'var(--pixel-font)'`，否则不响应像素字体开关）
- **JS 常量**：`READER_FONT`（`utils/fonts.ts`，仅限 xterm 等无法消费 CSS 变量的场景）

**唯一例外**：`index.css` 中的 `@font-face` 声明（注册字体本身）和 `.font-*` 类定义处。

**检测**：`grep -rn "font-family:" frontend/src --include="*.css" --include="*.tsx" | grep -v "var(--" | grep -v "inherit" | grep -v "@font-face"` 应无命中。

---

## 3. Pixel UI Primitives

### 3.1 OmniTermLogo (`OmniTermLogo` component)

16x16 pixel sprite rendered at integer multiples (48px sidebar, 16px favicon). Composition: dark-brown CRT frame (`#3A2E1F` — **fixed color, NOT theme-aware**, see "Fixed-color branding elements" below), `#12141A` screen, green `>` prompt, blue `_` cursor. Render with `image-rendering: pixelated`.

Location: pixel data in `frontend/src/components/PixelUI/omnitermSprite.ts`; rendered by `frontend/src/components/PixelUI/OmniTermLogo.tsx`.

**Single source of truth**: the sprite is defined once in `omnitermSprite.ts` and consumed by both the React component (in-app inline SVG) and `scripts/gen-logo-icons.mjs`, which generates `frontend/public/favicon.svg` and the PWA icons `icon-192.png` / `icon-512.png`. **Edit only `omnitermSprite.ts`, then regenerate with `node scripts/gen-logo-icons.mjs`** — CI runs the same script with `--check` and fails if the committed assets drift from the source.

**Fixed-color branding elements**: The sidebar's `.logo-title-bar` is the brand anchor — it always renders with the wood palette (`--wood-dark` bg + `--wood-shadow` border) regardless of the app's resolved theme. The OmniTermLogo sprite's outer frame is hardcoded `#3A2E1F` (matching `--wood-shadow`) so the CRT looks "embedded" in the bottom border line in BOTH themes. The cream wordmark, gold version text, and CWD button icon are also fixed. Only the surrounding panel-title-bar instances (Projects / Settings section labels) follow the theme.

### 3.2 PixelButton (4 variants)

All share base class `.btn-pixel`.

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

Label: `.progress-segmented-label` — 11px `.font-pixel`, letter-spacing `var(--pixel-tracking-md)`.

### 3.5 DialogueToast

Undertale-style RPG dialogue box for key notifications.

```css
.dialogue-toast {
  position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
  max-width: 520px; padding: 12px 18px;
  background: #12141A; border: 3px solid var(--wood-shadow);
  color: #FAF2DE; font-family: var(--pixel-font); font-size: 16px;
  box-shadow: 4px 4px 0 var(--pixel-shadow);
}
```

Includes corner nails (gold 8x8 squares), blinking pink caret `.dialogue-caret`, and highlight classes `.highlight-name` (gold) / `.highlight-emotion` (pink).

---

### 3.6 Modal 内容区的长文本（路径 / 分支名 / URL）

`Modal` 的 body 容器统一带 `overflow-wrap: anywhere`，**各弹窗不再自己处理**：
文件路径 / 分支名 / URL 是无空格超长 token，默认 `normal` 下不参与换行，
会突破 `max-w-*` 边框画到弹窗外（实测一个 100 多字符的 worktree 路径
溢出约 320px）。新弹窗一律基于 `Modal` / `ConfirmDialog`，不自建 portal 结构；
确需单行截断路径时按 `docs/dev/debug-patterns/layout-visual.md` 模式 5 配
`direction: rtl` + `<bdi dir="ltr">`（bidi 隔离）。

flex 行内的长文本（如复选框 label 里的分支名）额外需两件：文本 span `min-width: 0`（否则
按 min-content 撑开）+ 控件 `flex-shrink: 0`（否则复选框被压缩变形）。

---

## 4. Panel Title Bars

`.panel-title-bar` — wood-brown strip at the top of every panel (Sidebar sections, Terminal, FileManager, Settings, Modal).

```css
.panel-title-bar {
  padding: 5px 10px;
  background: var(--wood-dark);      /* #8B5A2B light / #2A2520 dark */
  color: #FAF2DE;
  font-family: var(--pixel-font-static);  /* 顶栏豁免：不受像素字体开关影响 */
  font-size: 13px;
  letter-spacing: var(--pixel-tracking-lg);
  text-transform: uppercase;
  border-bottom: 2px solid var(--wood-shadow);
}
```

**Content pattern**: `[decorator] TITLE [.title-bar-spacer] [.title-bar-badge]`

- `.title-bar-spacer` — `margin-left: auto`, pushes right-side items to the end
- `.title-bar-badge` — small status pill (e.g. `LIVE`), dark background + green text

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

**实现**：使用 4 条 **2px** inset box-shadow，**顶/左为深色凹边阴影**、**底/右为亮色凹边高光**。
1px 在普通 DPI 下会被抗锯齿吃掉，呈现「纸片」感；2px 才能稳定呈现凹入木板。
所有不可按 badge（连接状态、计数窗口、LIVE、session-attn）统一复用
`.status-badge-3d` class（见 `index.css`），禁止在组件里各写一份 inline inset。

```css
.status-badge-3d {
  box-shadow:
    inset 0 2px 0 var(--wood-inset-dark),    /* 顶 2px 深色 */
    inset 2px 0 0 var(--wood-inset-dark),    /* 左 2px 深色 */
    inset 0 -2px 0 var(--wood-inset-light),  /* 底 2px 亮色 */
    inset -2px 0 0 var(--wood-inset-light);  /* 右 2px 亮色 */
}
```

**颜色 token**（在 `:root` 中定义）：

| Token | Value | 用途 |
|-------|-------|------|
| `--wood-inset-dark` | `#140F0A` | 顶/左 凹边阴影（< `--wood-shadow`，深棕黑） |
| `--wood-inset-light` | `#6E543A` | 底/右 凹边高光（> `--wood-shadow`，亮木棕） |

颜色均调在 wood 色系内（仅拉明度，不引入新色相），不和 `#7EE787` / `#FF7B72` 状态色冲突。

**实现参考**（Sidebar 底部连接状态，`Sidebar.tsx` 1328–1348）：

```tsx
<div
  className="flex items-center gap-1.5 status-badge-3d"
  style={{
    padding: '2px 6px',
    background: 'var(--wood-shadow, #3A2E1F)',
    flexShrink: 0,
  }}
>
  <SignalBarsSprite size={14} connected={connected} />
  <span
    className="font-pixel"
    style={{
      fontSize: 13,
      letterSpacing: 2,
      color: connected ? '#7EE787' : '#FF7B72',
      whiteSpace: 'nowrap',
    }}
  >
    {connected ? t('sidebar.link') : t('sidebar.lost')}
  </span>
</div>
```

> `whiteSpace: 'nowrap'` 与 `flexShrink: 0` 必须存在——CJK 文案在被 flex 挤压时
> 会逐字竖排堆叠（2026-07-30 审查实证），缺了就是 bug。

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

### 6.1 共享工具类（禁止组件内联阴影）

所有浮层与内联样式按钮**必须复用 `index.css` 的工具类**，禁止在 TSX 里各写一份
`boxShadow`（无论软硬）：

| Class | 适用对象 | 规格 |
|---|---|---|
| `.pixel-float` | 所有浮层：modal、popup、dropdown、tooltip、自动补全 | `2px solid var(--border-strong)` 边框 + `4px 4px 0` 硬阴影 + radius 0（modal 外壳可覆盖至 2px） |
| `.pixel-press` | 不走 `.btn-pixel` 体系、自带边框/配色的内联样式按钮 | `2px 2px 0` 硬阴影 + `:active` 位移按压 + disabled 无阴影 + radius 0 |

例外：`0 0 0 2px var(--accent-14)` 形式的 **focus ring**（spread、无 blur）允许保留，
它不是阴影而是可访问性焦点指示。

### 6.2 原生控件与遮罩的像素化

未经处理的浏览器原生控件是现代圆润风格，与像素体系冲突，必须显式覆写：

| 控件 | 规则 |
|------|------|
| `input[type="range"]` | 统一走 `index.css` 的 pixel range 样式（方块 thumb + 块状 track，见 `.pixel-press` 后样式块），禁止仅设 `accentColor` 了事 |
| Modal 遮罩 | 一律 `var(--modal-backdrop)`（light 暖棕 45% / dark 深黑 60%），禁止 `backdrop-blur`（在羊皮纸上糊成灰绿） |
| `<select>` / 文本输入 | `border-radius: 0`，边框 `var(--border-strong)` |
| checkbox / radio | 允许原生 + `accentColor` 主题化（深度定制收益低，暂不强制） |

### 6.3 上下文菜单（右键 / 长按）与批量操作栏

**上下文菜单**（Sidebar 会话行，`SessionContextMenu.tsx`）：

| 元素 | 规格 |
|------|------|
| 容器 | `.pixel-float`（§6.1）+ `--bg-elevated`；`padding: 4px 0`，`min-width: 160px` |
| 条目 | `.context-menu-item`：reader 字体 13px，`padding: 9px 14px`，图标 14px（§13.1 线性图标） |
| 条目 hover / focus | 背景 `var(--accent-10)`，文字 `var(--accent)` |
| 定位 | 锚点坐标 + 视口 clamp（右/下缘各留 4px）；移动端长按取触点坐标 |
| 关闭 | 全屏遮罩点击/触摸、Esc、执行动作后（遮罩与菜单自身 `contextmenu` 也 preventDefault） |

**批量操作栏**（选择模式下替换底部状态栏，`BatchActionBar.tsx`）：

| 元素 | 规格 |
|------|------|
| 容器 | 与常规状态栏同一 `.absolute bottom-0` 定位与 padding，`border-top: 1px solid var(--border-subtle)` |
| 已选计数 | `.font-pixel` 11px + `var(--pixel-tracking-sm)`，`--text-secondary`，`nowrap` |
| 操作按钮 | 小号文本按钮走 `.pixel-press`（§6.1）；`padding: 3px 7px`、11px；默认 `--bg-elevated` + 1px `--border-strong` |
| 危险按钮（删除） | 边框/文字 `var(--danger)`，hover 背景 `var(--danger-12)` |
| 禁用 | `opacity: 0.45` + `cursor: not-allowed`（`.pixel-press:disabled` 无阴影） |
| 取消 | 24×24 图标按钮（`IconX`），样式与行内 action 按钮一致 |

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

Wood-brown frame around xterm, keeping the dark terminal background.

```css
.terminal-panel-pixel {
  background: var(--bg-elevated);
  border: 2px solid var(--wood-shadow);
  box-shadow: 3px 3px 0 var(--pixel-shadow);
}
.terminal-panel-pixel .xterm-viewport,
.terminal-panel-pixel .xterm {
  background: #12141A !important;
}
```

### 7.3 Pixel Toast (`.toast-pixel`)

Dark background + colored pixel border + pixel font.

```css
.toast-pixel {
  background: #12141A;
  border: 2px solid var(--success);
  color: #7EE787;
  font-family: var(--pixel-font);
  font-size: 14px;
  box-shadow: 3px 3px 0 var(--pixel-shadow);
}
```

Variant classes: `.toast-error` (danger border/text), `.toast-warning` (warning), `.toast-info` (accent).

**消失行为（勿回退）**：每条 toast 自己计时（`TOAST_AUTO_DISMISS_MS`），鼠标 hover 或键盘聚焦期间
**暂停**倒计时、移开后继续走剩余时间；关闭只走行内 `✕` 按钮，整条 toast **不得**挂 `onClick` 关闭
——报错信息常常要选中复制，点一下就没了等于无法复制。正文 `select-text` + `overflow-wrap: anywhere`
（长路径/URL 也要能换行完整显示）。同屏上限 `MAX_TOASTS`，超出丢弃最旧的。

### 7.4 活跃会话行强调（`.session-name-live` + `.activity-pulse`）

侧栏会话行恒定按 `created_at DESC` 排序，**不因活跃状态置顶**——置顶会让行在状态跳变时
整行跳动，破坏位置稳定性（折叠「展开更多」本就是为了密度）。代价是很老但正在跑的会话
落在可见区底部，位置本身不携带信息，于是「活着」改由行内强调表达：

| `sessionStatus()` 结果 | 强调 |
|---|---|
| `working` / `blocked` | 会话名提亮到 `--text-primary`（加 `.session-name-live`）+ 状态点 `.activity-pulse` 呼吸 |
| `done` / `none` | 默认 `--text-secondary`，状态点静止 |

- **live 判定只有 `sessionStatus()` 一个真源**（`frontend/src/utils/agentAggregate.ts`），
  与 worktree 行的聚合徽标共用；禁止在组件里再写一份 `running || waiting` 式的散装判断。
- 文字提亮与 `.active`（选中行）同色但语义不同（「在跑/待读」vs「选中」），二者可叠加。
  **不给活跃行加背景色**——会和选中态抢「当前在哪」。
- 呼吸动画复用既有的 `.activity-pulse`（§11），与 worktree 行 `GitBranchSprite` 同源。
  状态指示类动效不受「像素动画」开关控制（该开关只管 Mario 式位移/挤压动画，§8）。
- 折叠豁免（不被收进「展开更多」的会话 = `sessionStatus() !== 'none'`）解决的是
  「看不看得到」，本节的强调解决的是「看得出不看得出来它在跑」——两者互补，都要保留。
  **豁免与强调必须同一真源**：只给 `working`/`blocked` 加强调而不把它们移出折叠区，等于把强调
  应用在看不见的行上（running 会话曾因此整行隐藏）。
  **激活（选中）态不豁免**：可见位只由「有事在做或要给用户看」决定。点击一行来查看历史
  不得把它提升进可见区——否则用户在一个个查看旧会话时，每点一行就把最新那条挤出可见区，
  可见集随点击不断重排，浏览顺序被打乱（2026-10-07 用户需求）。代价是收起态下当前行可能
  暂不可见，由主面板标题与展开列表兜底；选中行仍是纯前端概念，`sessionStatus()` 读不到，
  但这不构成抢位理由。

### 7.5 气泡元信息行（`.chat-meta-row` — 耗时 / tps / hover 动作）

assistant 气泡底部一条 `flex-wrap` 行：动作栏靠左、耗时与 tps 靠右（`margin-left:auto`）。**同一套实测宽度下，同行与换行的右缘都是气泡右缘**——气泡是内容宽度且该行是它的兄弟节点，CSS 表达不了「贴气泡右缘」，只能 `useLayoutEffect` + `ResizeObserver` 量最后一个 `[data-chat-body]` 的 `offsetWidth`（详见 `docs/dev/plans/archive/2026-08-30-acp-work-time.md` E10/E11）。

**对齐随状态切换（勿回退成恒定右侧）**：流式期动作栏恒空、实时读数**靠左**；定稿后动作栏回归左侧、结算值顶到**右侧**。左右只在定稿瞬间变一次，流式全程停在同一侧——这是为了消除「流式中读数在右侧、结束后又换一组数字」造成的左右横跳观感。

| 态 | 文案 | 色板 | 性质 |
|---|---|---|---|
| 结算（定稿后） | `已工作 2分钟42秒 · 工具 30秒 · 12.3 tok/s` | `--text-faint` | 后端工作时长 + omniterm 估算的工具耗时/tps |
| 流式实时 | `工作中 42秒 · 工具 30秒 · 12.3 tok/s` | `--text-muted`（提亮一档） | 后端 `turn_stats` 推送，前端只显示不计算 |

- 两者共用 `CHAT_META_TEXT_STYLE`（`0.769em` + reader 字体 + `tabular-nums`）。右侧对齐的 `marginLeft:auto` / `textAlign:right` 只加在结算值上。
- **流式实时读数固定单行**（2026-10-14 用户报告窄正文块下三段堆成三行）：三个读数段全 nowrap，而行宽实测自最后一个正文块——它是窄工具卡 / 刚起的文本泡时三段放不下，`flex-wrap` 会拆成一行一段，且正文变宽过程中 3→2→1 行重排（观感抖动）。故流式期整行以 `min-width:max-content` 托到单行内容宽度（窄气泡下允许横向超出气泡）。**结算值不托**：仍按「动作栏 + 结算值放不下才换行」，右缘贴气泡；元信息文字窄屏折行规则只对结算值生效。
- 实时态只在 `message.streaming` 且该会话有在建 turn 时出现；动作栏此时恒空（五个动作的 `visible` 全部硬排 streaming），定稿瞬间同一槽位被结算值替换——**不给两个数字并排的机会**。
- **读数文案不带「约 / 估算」前缀，性质说明全部收在 hover**（2026-10-15 用户要求「hover 时诚实简单地说清楚」）：工具耗时与 tps 都是 omniterm 自己算的——ACP 不返回真实 token 速率、也不上报工具耗时（`usage_update` 只有上下文配额，见 `docs/reference/acp-protocol-reference.md` §6.7），tps = 观测到的正文与思考字符 ÷ 4 ÷ 模型真正在流式输出的时段（burst 白名单，E20），工具耗时 = 执行并集按封口测量（E18/E19）。两条 tooltip（`chat.msg.toolTimeTip` / `chat.msg.tpsTip`）把「ACP 不上报 → omniterm 估算」写在最前，并随读数的有无增删——**tooltip 只解释屏幕上画出来的读数**，缺省段（尚无输出 burst / 工具跟踪失效）整段撤掉时其说明也不进 tooltip。`chat.msg.workingTip` 说明的是后端实测工作时长（墙钟 − 审批等待，非估算），不进诚实口径。详细口径见工作时长计划 E13–E20/E23，文案翻盘见 E24。
- 动作栏 `flex-shrink: 0`：按钮被压缩时会自己堆成多行（比耗时换行更糟），「放不下」必须永远落在耗时这一侧。

### 7.6 气泡内 markdown 排版（`.chat-markdown`）

assistant 气泡正文是 react-markdown 渲染，**必须自带一套排版规则**（`frontend/src/index.css` 的 `.chat-markdown`）——Tailwind Preflight 全局 `* { margin:0; padding:0 }` + `ol,ul,menu { list-style:none }` 会抹掉 UA 默认排版，没有规则时段落/标题/列表零间距、无列表符号（曾导致 agent 长输出「挤成一团」，2026-10-04 修复）。与文件抽屉预览 `.file-markdown` 同源不同档：

| 元素 | 规格 |
|---|---|
| 段落 `p` | `margin: 0 0 8px` |
| 标题 `h1`–`h6` | 1.25em → 0.92em 分级，上 10–12px / 下 4–6px，`h5`/`h6` 降为 `--text-secondary`；压住 UA 2em/1.5em（气泡上限 85% 宽撑不下） |
| 列表 `ul`/`ol` | 恢复符号（`disc`/`decimal`）+ `padding-left: 1.4em`，`li` 各 2px；GFM 任务列表 checkbox 复用 `accent-color: var(--accent)` |
| 引用 `blockquote` | 左 2px `--wood-dark` 边线 + 10px 缩进，`--text-secondary` |
| `hr` | 1px `--border-subtle` 分隔线（Preflight 会把 hr 压成 0 高） |
| 首/尾子元素 | `> :first-child` / `> :last-child` 外边距归零——气泡 padding 已是边界留白，不叠双重 |

间距整体比 `.file-markdown` 紧一档（气泡窄、密度优先）。**流式期仍是 pre-wrap 纯文本降级**（未闭合语法下每帧全量解析的代价），排版规则只对定稿渲染生效；代码块圆角/配色走 MarkdownCore 的 props 与 Prism oneDark，不在此节。

### 7.7 拖拽排序视觉（鼠标立即起拖 / 触摸长按，卡片跟随指针）

侧栏项目卡片拖拽换序（交互契约见 frontend-patterns「列表拖拽排序」）：**无独立手柄**——起拖区即卡片头部（收起态整卡即头部、展开态是标题条）；**鼠标/笔移动超 4px 立即起拖**，**触摸长按 500ms**（与列表滚动消歧）。起拖达成时 `hapticTap()` + 下列拽起特效：

| 元素 | 规格 |
|---|---|
| 起拖 | **鼠标/笔**：移动超 4px 立即起拖（无长按）；**触摸**：长按 500ms（与列表滚动消歧，移动端通行范式）。起拖区 = 卡片头部，无独立手柄 |
| 拽起 `.sidebar-project-lifted` | 硬投影由 `3px 3px 0` 放大到 `6px 6px 0 var(--pixel-shadow)`（§6 硬投影约定，不加 blur）；`border-color` 转 `--accent`；`position: relative; z-index: 2` 抬升浮出相邻卡片；`will-change: transform` |
| 跟随指针 | 每拍 pointermove 直写行内 `transform: translate(dx, dy) scale(1.02)`——卡片跟着指针走（dx/dy 自按下点累计，抓住的点始终在指针下）；scale 1.02 是「捏在手里」的放大暗示。**class 的 transition 不含 transform**：跟随零延迟，补间会让卡片落后于指针；shadow/border 仍走 `0.1s steps(2)` 快照 |
| 拽起的 `pointer-events: none` | **命中判定前提，不是装饰**：`elementFromPoint` 必须穿透跟随中的卡片命中下方卡片才能算插入点。副作用：光标取自下方卡片，故不设 `grabbing` 光标 |
| 插入指示线 `.sidebar-project-drop-line` | 两卡之间 2px `--accent` 硬线（无 blur、无渐变）；`margin: -6px 10px 4px` 负边距落在卡片 10px gap 内——拖拽中不引起布局跳动；`pointer-events: none` 不抢命中；即时出现/消失（拖拽反馈零延迟，不跟补间） |

**「in hand」语义**：被拽起的卡保持完全不透明（不是半透明置灰）+ 跟随指针——用户清楚地看见「哪张卡被我捏在手里、此刻在哪」；插入线回答「松手会落到哪」。松手时行内 transform 清空（React 不管该属性，须手动），卡片落定新序。

### 7.8 聊天气泡像素卡片（`.chat-bubble`）

ACP 聊天流的「说话气泡」（user + assistant 正文）统一为像素卡片，圆角一律 0（§14 全局硬角）。
外壳收敛到 `index.css` 的 `.chat-bubble` 单一真源，组件侧只保留动态态：

| 属性 | 值 | 说明 |
|------|-----|------|
| `border-radius` | `0` | 全局硬角；**组件不再 inline 圆角**（历史 8/6/4 圆弧已全部归零），圆角只来自 class |
| `border` | `1px solid var(--border-strong)` | 面板外缘档，与 `.settings-card` 同级。user 气泡的特殊态（高亮 / 未送达）在组件里就地覆盖 |
| `box-shadow` | `2px 2px 0 var(--pixel-shadow)` | 硬投影取 `.settings-card` 同档（内容卡），比 `.pixel-float` 的 4px 低一档——消息流密度高，投影再重就发闷 |

**两层层级（勿给次级内容面加投影）**：说话气泡是「说的话」，用投影卡；气泡流里的
工具卡 / 计划块 / diff / system 详情是嵌在流中的面板，**只掰直圆角、不加投影**
（工具卡保留左侧 2px 状态色条作为状态语义）。全叠投影只会噪。

**投影必须经 `--chat-bubble-shadow` 变量暴露**：`.chat-msg-flash`（「上次输入」跳转聚焦）
的 ring 动画作用于 `box-shadow` 且带 `forwards`，关键帧里必须把气泡硬投影一起写回——
否则动画终态（`0 0 0 2px transparent`）会把投影**永久抹掉**，闪烁结束后气泡就没投影了。

**气泡内 markdown**：围栏代码块与行内代码的圆角同归 0。历史上聊天传 6/3、别处传 0 的
`codeRadius` / `inlineCodeRadius` 旋钮已随本次像素化删除（`Common/MarkdownCore`），
**勿重新引入非零圆角或半径 props**。

---

### 7.9 思考块（`ThoughtBlockView`）排版与折叠态

ACP 消息流里的 thought 块：一行可点标题 + 展开区。**思考内容一律不用斜体**——此前的 `fontStyle: 'italic'` 是「思考=斜体」的排版俗套，与 OmniTerm 的等宽阅读字体不搭（2026-10-13 用户要求修正）。虚化只由「小一档 + 低对比色」表达。

折叠态外观对齐 ZCode 的 `Reasoning` 组件（2026-10-14 用户要求）：**标题行单行承载全部信息**，不在标题行下方另起预览行。

| 元素 | 规格 |
|------|------|
| 标题行 | reader 字体 `0.846em` / `--text-faint` / `opacity: 0.9`；`inline-flex` + `gap: 5` + `maxWidth: 100%` + `minWidth: 0`（长思考行把视口挤在气泡宽度内，不撑破气泡）；整行即展开开关 |
| 行内成员 | `◆` 图标（`shrink-0`）→ 状态标签（`shrink-0` + `nowrap`）→ `·` → 实时思考行（`flex: 1` + `minWidth: 0`）→ 箭头（`shrink-0`） |
| 状态标签 | 流式且收起 = 「正在思考」+ 扫光（`.thinking-shimmer`）；其余（展开中 / 已完成）= 「思考」`fontWeight: 500` + `·` + 耗时（`持续了几秒` / `持续了 N 秒`） |
| 实时思考行 | `0.923em` / `--text-muted`；`overflow: hidden` + `whiteSpace: nowrap`；单行收口靠**视口滚动到末尾**而非省略号 |
| 展开区 | `0.923em` / `lineHeight 1.5` / `--text-muted`（比正文 text 气泡的 `1em` / `--text-primary` 小一档且虚化）；左缘 2px `--border-subtle` 状态条 + 左右 10px 缩进；`maxHeight: 300` shrink-to-fit 滚动（`OverlayScroll`） |

排版规格的单一真源是 `ChatMessage.tsx` 的 `THINKING_TEXT_STYLE`（展开区与实时思考行共用）；**勿在两处各写一份字号/颜色**。

**实时思考行只显示在流式期间**（对齐 ZCode 的 `isStreaming && !isOpen`）——思考结束后折叠态只剩「思考 · 持续了 N 秒」，不再显示思考原文。内容是一行**未经任何总结**的思考原文：取思考文本最后一个非空行（流式期间正是正在生长的那一行），不做总结、不改写、不截断字符。

**溢出语义（与旧实现的关键差异）**：不用 `text-overflow: ellipsis`——那会冻结旧前缀、把最新 token 裁在右侧，与「正常流式输出」矛盾。改为每次内容增长后把单行视口的 `scrollLeft` 推到 `scrollWidth`：旧内容向左移、最新 token 始终可见。溢出时左缘叠加 16px 渐隐遮罩（`THINKING_LINE_MASK_STYLE`），提示「左侧还有被滚走的内容」；不溢出时不加（右缘是完整的最新 token）。接线用 `data-thinking-streaming-line` / `data-thinking-streaming-mask`。

**两处动画**（均在 `index.css`）：

- `.thinking-shimmer`：300% 渐变 + `background-clip: text` + 4s 线性扫光（`@keyframes thinking-gradient-flow`），渐变中段夹 `--text-faint` 形成高光扫过；
- `.thinking-line-roll`：换行时新行从下一行位置（`translateY(0.8em)`）300ms 淡入到位。由 React key（**行首偏移**，见 `thinkingCollapsed.ts`）变化触发重挂载——同一行继续生长时 key 不变，**不重挂载也就不重放动画**。

两者都在 `@media (prefers-reduced-motion: reduce)` 下关停；扫光关停后必须把文字色还回来（`background-clip: text` 配 `transparent` 会让标签整个不可见）。

**箭头**（`.thinking-chevron`）：收起态默认 `opacity: 0`，hover 标题行才显；展开态常显并 `rotate(90deg)` 指向下。单个字形 + CSS 旋转，不搞两套字形。

**耗时**（`durationSec`）：客户端测量——流式开始计时、结束定档（`Math.max(1, ceil(elapsed/1000))`，亚秒也显示 1 秒而非 0 秒），只在展开态每秒刷新（收起态没必要为了隐藏的数字每秒重渲染整块）。历史块从未见过 `streaming=true`，保持 `undefined`，回落「持续了几秒」。

**收起态两档位**（档位枚举 / 选项数组 / 存档白名单 / 取行规则的单一是 `frontend/src/utils/thinkingCollapsed.ts`；「展开思考」关闭时才有语义——开时块恒展开，设置面板此时**不渲染**该行，不给空转开关）：

| 档位 | 收起态显示 | 默认 |
|------|-----------|------|
| 完全隐藏 | 只有标题行，无任何思考内容（即加此设置前的行为） | ✅ |
| 显示简要 | 流式期间标题行内嵌一行思考原文；思考结束后只剩状态标签 | |

档位是独立设置（localStorage `omniterm_thinking_collapsed`），**不随「展开思考」开关复位**。

实时思考行刻意不打 `data-chat-body`：元信息行的气泡右缘量的是行内最后一个 `[data-chat-body]`，它一旦打标就会顶替它。

**`ThoughtBlockView` 不做任何自动折叠**（2026-10-14 撤销过一次，教训记在这里）：曾有版本把 `open` 初值改成 `expandThinking && (streaming || !autoCollapse)`，想「流式中展开、完成后自动收起」。但多块消息里思考块**永远不是最后一块**（它后面还有工具卡与结论），`streaming` 恒为 `false`，叠加默认开的开关后思考块**直接收起、正文整个消失**——只剩工具调用内容。故 `open` 只由 `expandThinking` 决定，不再叠任何条件。过程块的收纳已由消息级容器负责（见 §7.10），单个思考块不需要自己再折一次。

两项设置**彼此独立、互不复位**：`expandThinking`（是否展开观看）、`thinkingCollapsedMode`（收起时显示什么）。单一真源同见 `frontend/src/utils/thinkingCollapsed.ts`。

### 7.10 消息级「过程容器」（`ProcessBlocks`）

上一节管的是**单个思考块**自己的折叠；本节管的是**整轮过程的收纳**：把一条 assistant 消息里除最终结论外的一切收进同一个折叠器——过程块（`thought` / `tool_call` / `plan`）与夹在过程块之间的中间 `text` 输出。折叠态只留**一行摘要**，最终 `text` 结论（流式中正在生长的那段）留在容器外始终可见。目标是「流式输出完成后把整个过程收纳起来，只显示最终结论」（2026-10-14 用户要求）。

**收纳行标题主体是工作时长**（用户 2026-10-14 明确要求「标题是已工作 x 分 x 秒」），而非状态词——秒数在跳即表达「进行中」、定格即表达「已完成」，不需要另设一套状态文案。复用 `chat.msg.workTime`（与气泡底部元信息行同一读数、同一措词），不新造键；流式中走实时读数（`ProcessWorkElapsed`，同 `LiveWorkElapsed` 的「定时器直写 DOM」手法，只显示工作时长一段），定稿后用 `message.durationMs` 算出的结算值。无 `durationMs` 的历史行不硬造 0 秒标题，整段撤掉只留计数。

**交互**（对齐 ZCode 容器型工具 `ToolCallBlocks/renderers/agent.tsx` + `ToolLayout.tsx`）：

| 阶段 | 行为 |
|------|------|
| 流式中 | 容器**展开**，跟着看过程逐块产出 |
| 流式结束 | **边沿上自动折叠**成一行摘要（`running → completed` 边沿检测，同 §7.9 的 `wasStreamingRef` 手法） |
| 用户手动干预后 | 自动规则不再覆盖（`userInteractedRef`，展开与收起都算干预） |
| 历史消息 | 挂载即收起（收纳） |

**计数聚合是次要信息，不罗列**（对齐 ZCode `formatExploreSummary` 把子调用按 search/list/file 计数），接在时长后用 `·` 分隔：「已工作 1分钟35秒 · 思考 1 · 工具调用 2 · 计划 1」。比把每个块名列一遍短，也不会随块数增长而无限变长；只收非零段。流式中时长段借 §7.9 的扫光 class 家族（独立成 `.process-shimmer`），定稿后回落 `--text-muted`（同 `ToolLayout` 对 `kindLabel` 的处理理由：非运行态保持最浅文本色，避免摘要喧宾夺主）。

**与两个既有开关不同层、不冲突**——这是最容易搞混的地方：

- **容器**决定「看不看得到明细」；
- `expandThinking` / `expandToolCalls` 决定「展开后明细的粒度」。

容器展开时，内部各块照旧各自读自己的设定渲染（`ThoughtBlockView` 仍按 `expandThinking` 决定自身展不展）。故「开了展开思考」的用户在流式中看到的过程明细粒度不变，只是流式结束后多了一层收纳。

**归组规则**（2026-10-15 用户报告「每个小输出都折叠起来」后改为**按轮归组**）：

- **一轮只有一个容器**。除**最终 `text` 结论**与 **`system` 块**外，一轮里的过程块（`thought` / `tool_call` / `plan`）与**夹在过程块之间的中间 `text` 输出**全部收进同一个容器。曾按**连续过程块**切段归组：每段文字之间各攒出一个容器，一轮输出被切成「文字 + ◈已工作…」交替的许多行（用户截图里同一条消息出现 5 行收纳摘要），与 ZCode「一轮只一行」的参照正相反。
- **最终 `text` 结论 = 最后一个 `text` 块**，不是 `lastIdx`（消息可能以工具调用收尾），也不是第一个 `text` 块（ACP 的 prose chunk 被工具调用切成多个 `text` 块，靠前的那些是中间输出）。
- 容器占据**第一个被收纳块**的位置；留在容器外的块按原相对顺序排在其后，故可见内容（system / 最终结论）的阅读顺序不变。唯一的例外是「结论之后还有过程块」的罕见消息（agent 结尾又调了工具），那时的过程块会提前到结论之前。
- **没有「单块段例外」**（曾有过：一个思考块 / 工具卡本就有自己的折叠头，套容器会得到两行重复信息）。容器是**轮级**的，一轮只出一次摘要；块自己的头仍在容器展开后出现，与多块时同构。
- `system` 块**必须**留容器外：权限审批要可见可点，不能跟着容器一起被折掉。
- **纯文字回复**（无过程块、无中间输出）不出现收纳行，行为与加容器前完全一致。此时计数段可能全零（一轮只有中间文字），摘要只剩时长段与箭头——正是 ZCode 参照的「已工作 19 分 35 秒 ›」形态，故不写兜底文案。

**排版**：收纳行与思考块标题行同款规格（reader 字体 / `0.846em` / `--text-faint` / `opacity 0.9`，`max-w` + `min-w-0` 让长摘要被气泡宽度收口），字形 `◈`——与思考块的 `◆` **同族不同形**，避免两块视觉混淆。样式在 `index.css` 的 `.process-header-btn` / `.process-summary-text` / `.process-chevron` / `.process-shimmer`；箭头**刻意不复用** `.thinking-chevron`——后者的 hover 联动写死了 `.thinking-header-btn:hover`，套过来会连带思考块的规则。收纳行带 `data-chat-body`，参与 §7.9 那条气泡右缘测量。

**容器必须是 flex column，与消息行 `.chat-msg-row` 同一格式化上下文**（2026-10-15 用户报告「工具调用信息位置错乱，复制按钮也是乱的」，实测修复）：容器刚加上时是普通块级 `div`，而它装的明细块分两种显示类型——`ToolCallBlockView` 根节点是 `display: inline-flex`、`ThoughtBlockView` / `PlanBlockView` 是普通块级 `div`。在块容器里前者**退化成行内级**：与收纳行标题挤进同一行、按基线对齐产生纵向错位，长卡再折到下一行（结构复现实测：收纳行 `y=89` 而工具卡 `y=82`、`x=356`，紧贴标题右侧）；后者铺满容器宽，把块级复制角标甩到容器远右缘。故容器立成 `display:flex; flex-direction:column; align-items:flex-start; gap`（`gap` 与消息行同用 `MSG_ROW_GAP`），三类明细块都被块化成 flex item——各自 shrink-to-fit、按行堆叠，与加容器前直接挂在消息行下完全一致。`align-items` 不能省：缺了它明细块会被拉成整宽，复制角标重新甩到远右缘。

**容器自身不带 `.chat-block`**：它没有复制角标，不需要 `position:relative`；挂上还会让 `.chat-block:hover .chat-block-copy-btn`（后代选择器）变成「hover 收纳行即亮出内部所有块的角标」，而每个明细块本该只由自己的 hover 点亮。`data-chat-body` 保留。

**宽度上限由容器统一收口，明细块不再自带**（同一轮排查的第二处）：明细块原本各自带 `maxWidth: 85%`，收进容器后与容器自己的 85% **相乘**——结构复现实测同一张工具卡 1006px → 855px，长标题比平铺在消息行下时更早出省略号。故 `renderBlock` 的宽度上限改为**调用方传入**：容器内的块（过程块 + 中间 `text` 输出）传 `undefined`，容器外的块（最终 `text` 结论、`system` 块）传 `BUBBLE_MAX_WIDTH`——它们是没有上层收口的那一档。容器自身 ≤85% 行宽，内部块自然 ≤85% 行宽，且块的 fit-content 宽度不再被二次压缩。收纳行的 85% 能正确解析，前提是消息行是 `OverlayScroll` 内容面（flex column）里**被 stretch 的 flex item**——行宽 definite，百分比才有确定的基准；若把消息行也做成 shrink-to-fit，百分比会变成「自身内容宽的 85%」（实测收纳行被压掉 15% 宽、摘要提前出省略号）。

**折叠即卸载，块内本地态随之丢失**（已知限制，非 bug）：容器收起时 `{open && entries.map(...)}` 不再渲染明细块，`ThoughtBlockView` 的「持续了 N 秒」定档值、内层滚动位置都随卸载丢失，再展开时思考块回落「持续了几秒」。这是「不渲染重内容」的有意取舍（一轮可有几十张工具卡，每张都可能带大段 `rawInput`）；用户手动干预过的消息容器不自动折叠，块保持挂载，定档值仍在。turn 级读数不受影响——它在收纳行与元信息行上，由后端结算的 `durationMs` / `turn_stats` 推送（前端只显示，见 work-time 计划 E23）提供。

---

## 8. Settings Toggles

Effect toggles in the Settings panel, each persisted to localStorage（下表只列效果类开关，非全量）：

| Toggle | localStorage key | Default | Controls |
|---|---|---|---|
| Parchment Texture | `omniterm_parchment_texture` | `true` | Background dot-matrix texture |
| Pixel Animations | `omniterm_pixel_animations` | `false` | Mario-style bump/stomp/coin/starman animations (Phase 2) |
| Sound | `omniterm_sound_enabled` | `false` | 8-bit sound effects (Phase 2) |
| CRT Scanlines | `omniterm_crt_scanlines` | `false` | CRT scanline overlay (Phase 2) |
| Waiting Animation | `omniterm_thinking_effect_enabled` / `omniterm_thinking_effect` | `true` / `scramble` | ACP 等待 agent 输出时消息流底部的状态行动画（乱码流 / 经典转圈 / 盲文点阵），关闭后不渲染；与像素动效互不联动，注册表见 `frontend/src/utils/thinkingEffects.ts` |
| Default Terminal Engine | `omniterm_default_terminal_engine` | `tmux` | 新建终端会话与「在此打开终端」的引擎（pty 仍在 beta，故 tmux 兜底） |

Pixel UI and pixel fonts are always active (no toggle).

### 默认引擎选项行（Settings → 终端）

双按钮行复用 `settingsStyles.ts` 的 `btnBase` / `btnActive`（与主题/语言选择行同款，12px / padding `5px 8px` / `flex-1`），顺序恒定：**tmux 在左、pty 在右**，pty 选项尾接共享 `BetaBadge`。不可选态（宿主探测无复用器时的 tmux 项）：`opacity: 0.5` + `cursor: not-allowed`，不绑 hover 态，并在行下方用 `sidebar.muxUnavailable` 文案说明原因——与创建会话弹窗的引擎卡同一门控、同一措词，勿各写一套。

---

## 9. Body Class Gating

Feature flags are applied as classes on `<body>`:

| Body class | Added when | What it enables |
|---|---|---|
| `body.pixel-font-on` | `pixelFontEnabled === true`（像素字体 BETA 开关，默认关） | `--pixel-font` 覆盖为 `var(--pixel-font-static)`；关闭时所有 `var(--pixel-font)` 用点回退 reader 字体（顶栏豁免见 §2） |
| `body.parchment-texture` | `parchmentTextureEnabled === true` | Background dot-matrix overlay on body (light theme only) |

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
| `.dialogue-toast` entrance | Fade + 8px Y shift | 0.3s steps(3) |
| `.chat-last-prompt-card.is-scrolling` / `.chat-jump-bottom.is-scrolling` | 用户滑动消息区时两个悬浮件（「上次输入」卡片 / 「回到底部」按钮）淡出至 `--chat-scroll-dim-opacity` 0.35（静止后恢复） | 0.15s ease-out（`--chat-scroll-dim-transition`） |
| `.sidebar-project-focus-flash` | 项目卡片聚焦回执（cover-conflict「切换到现有项目」）：Y 轴弹跳（复用 `mario-jump`）+ accent ring 淡出（`sidebar-project-focus-ring`，spread 无 blur，§6.1 focus ring 例外） | 弹跳 0.4s steps(6) / ring 1.2s ease-out forwards（`PROJECT_CARD_FLASH_MS`） |

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
| Border radius | 2px（挂 `.pixel-float`，见 §6.1） | 2px |

### Tab 菜单视觉

| 元素 | 规格 |
|------|------|
| Tab 字体 | `.font-pixel` (Silkscreen) 14px，letter-spacing `var(--pixel-tracking-md)`，**UPPERCASE** |
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

### 内容区子分类卡片（`.settings-card`）

内容区（`.settings-content`）内的每个子分类渲染为一张悬浮卡片，把原本平铺贴底的
设置行在视觉上分开。**卡片边界 = 语义分组**：`Settings.tsx` 的 `CATEGORIES[].groups`
决定哪些 section 同卡（同组 = 同一类设置，如「显示尺寸」= UI 缩放 + 终端字号 + 聊天字号），
渲染成 `.settings-card` 包裹层（`display:flex; flex-direction:column; gap:12px`）。
分组只改卡片边界，不改 section 自身结构，**不新增 i18n key**——每行仍用各自的
`SectionTitle`。兜底选择器 `.settings-content > section` 让漏包分组的裸 section
也照样成卡。

| 属性 | 值 | 说明 |
|------|-----|------|
| 背景 | `var(--bg-base)` | 亮色比弹窗 `--bg-elevated` 更亮（浮起），暗色更深。**不用 `var(--bg-surface)`**——卡内输入框与滑块轨道同为 `--bg-surface`，同色会与卡底糊成一片 |
| 边框 | `1px solid var(--border-strong)` | 比弹窗 `.pixel-float` 的 2px 低一档，形成层级 |
| 阴影 | `2px 2px 0 var(--pixel-shadow)` | 低于 `.pixel-float` 的 `4px 4px 0` 一档；多卡叠加不发闷 |
| Border radius | `0` | 全局硬角 |
| Padding | `8px 10px` | — |
| 同卡内 section 间距 | `gap: 12px` | section 自身的 `space-y-*` 只管卡内排版 |
| 卡内小节标题 | 11px / `fontWeight: 700` / UPPERCASE / `letter-spacing: 0.5px` / `--text-muted` | 单一真源为 `Settings/toggleRow.tsx` 的 `SectionTitle`，各 section 一律复用它，勿另写 h3 样式 |
| 内容区间距 | `gap: 10px`（原 18px） | 卡片自带 8px 上下 padding，视觉间距仍约 26px |

#### 暗色说明文字的局部提亮（勿删）

暗色下卡底 `--bg-base`（`#12141A`）比弹窗底更暗，沿用面板级 `--text-faint`
（`#484F58`）时 hint / 单位 / 关于文案只有 **2.2:1**，实测几乎看不清。因此在
`.dark .settings-content` 内局部把该 token 覆盖为 `#787F8B`（**4.56:1**，过 WCAG AA），
只影响设置内容区，不动全局 token。

提亮后设置内容区的文字层级：数值 `--text-primary` 12.5:1 > 小节标题 `--text-muted`
6.0:1 > 说明 `--text-faint` 4.56:1。改动此值后需重新实测三档对比度。

### 滚动条（OverlayScroll 原生主题化）

所有纵向滚动区域统一用 `<OverlayScroll>` 组件：保留**原生滚动条**并做主题化
（窄、pixel 直角、可拖动）。gutter 在首次渲染即预留 6px，thumb/track 平时透明、
**鼠标 hover / focus 进容器才显现**，因此显隐不会挤压或 reflow 其他内容。视觉 token：

| 元素 | 值 |
|------|-----|
| 拇指宽度 | 6px |
| 拇指圆角 | `border-radius: 0`（pixel 直角） |
| 拇指颜色 | `var(--scrollbar-thumb)` |
| 拇指 hover | `var(--scrollbar-thumb-hover)` |
| 轨道颜色 | `var(--scrollbar-track)` |
| 显隐 | 平时透明，hover/focus-within 才上色（原生能力，可拖动，零跳动） |

Popup 自身 `overflow: hidden`，滚动交给内层 `.overlay-scroll-content`。
代码约定（填满型 vs shrink-to-fit 菜单、横向滚动例外）见
[`frontend-patterns.md` 「可滚动区域统一 OverlayScroll」](../architecture/frontend-patterns.md#可滚动区域统一-overlayscroll-scrollable-area-convention)。

### i18n 视觉约定

- **Tab 文字**：英文 UPPERCASE（Silkscreen/VT323 不支持中文，pixel 风统一）
  en/zh 两个 locale **写同样的英文值**（如 `settings.category.appearance: "APPEARANCE"`）
- **选项标签 / 标题 / hint**：正常翻译

---

## 13. SVG & Rendering Rules

UI 中有两类图标，渲染规则截然不同，**不要混用**：

### 13.1 线性描边图标（功能型 UI 图标）

按钮、工具栏、操作入口等功能性图标。统一收在
`frontend/src/components/FileManager/icons.tsx` 通用图标库，供
FileManager / Sidebar / Settings / Modal 等全局复用（`IconPlus` /
`IconPencil` / `IconTrash` / `IconPower` / `IconSettings` 等）。

| 属性 | 值 |
|------|-----|
| viewBox | `0 0 16 16` |
| `fill` | `none` |
| `stroke` | `currentColor`（随父级 `color` 变色，hover 交互靠它） |
| `stroke-width` | `1.5`（强调型主 CTA 可用 `2.25`，如项目添加按钮） |
| `stroke-linecap` / `stroke-linejoin` | `round` |
| `shape-rendering` | 默认 `auto`（平滑抗锯齿）— **不加 crispEdges** |

- 尺寸自由缩放（14 / 16 / 18px 均可），无需整数倍
- 新增图标往 `icons.tsx` 追加并复用 `base` props，**禁止在组件里各写一份内联 SVG**
- 复杂图标可保留原生 viewBox（如 `IconSettings` 用 Lucide 原生 24×24 路径），
  但 `stroke-width` 需换算到 16px 显示时等效 1.5（24 网格下为 2.25）

### 13.2 像素精灵（装饰 / 品牌 / 状态型）

Logo、文件夹/文件类型、状态指示等装饰性精灵。位于
`frontend/src/components/PixelUI/`（`PixelSprites` / `OmniTermLogo`），见 §3.1 / §3.3。

| 属性 | 值 |
|------|-----|
| viewBox | 16×16（或 16×14 / 14×16 变体） |
| 构成 | 整数坐标 `<rect>` 像素块，纯色 `fill` |
| `shape-rendering` | `crispEdges` — **逐组件显式声明**，不依赖全局 CSS |
| 渲染尺寸 | 仅整数倍缩放（16 / 32 / 48px…），配合 `image-rendering: pixelated` |

### 13.3 通用规则

- UI 中禁止 emoji 字符 — 用 SVG、CSS 或等宽符号（`▸` `●` `◆` `★` `✓`）
- **禁止全局 `svg { shape-rendering: crispEdges }` / `stroke-linecap: square`** ——
  CSS 会覆盖 presentation attribute，把线性图标的曲线/斜线锯齿化、round 端帽
  压成方角；`crispEdges` 只能由各像素精灵组件自行声明（见 `index.css` 注释）

---

## 14. New Component Checklist

Before adding any new UI element, verify:

- [ ] Uses CSS variables (`var(--token)`) not hardcoded hex
- [ ] **背景色遵守 §1.2 「禁止纯白」规则** — R > G > B 且 R-B ≥ 25，明显黄调羊皮纸
- [ ] **不可按的状态指示器遵守 §4.1 Status Badge 规范** — 深棕黑底 + 亮色文字，**无 border / 无 box-shadow**（避免看起来像 button）
- [ ] Hard shadow uses `3px 3px 0` (not `4px` blur, not glow)
- [ ] `border-radius: 0` everywhere (modals: `2px` max)
- [ ] 聊天气泡复用 `.chat-bubble`（§7.8）——圆角只来自 class，不在组件里 inline；气泡内 markdown 代码块/行内代码同样 radius 0，勿引入半径 props
- [ ] Modal/弹窗标题一律 `.panel-title-bar` 木条（`Modal.tsx` 已内建），遮罩一律 `var(--modal-backdrop)`（§6.2），禁止 `backdrop-blur`
- [ ] Pixel font (`.font-pixel`) only for display text, not body/code
- [ ] 可切换像素文字必须走 `var(--pixel-font)`（inline style 亦然），保证受像素字体 BETA 开关控制；顶栏豁免才用 `var(--pixel-font-static)`（§2）
- [ ] Tested in both light and dark themes
- [ ] Transitions use `steps(3)` for pixel elements, `ease-out` for modals
- [ ] No emoji characters — SVG or monospace glyphs only
- [ ] 功能型图标复用 `icons.tsx` 线性描边风格（§13.1）；像素精灵才用 `crispEdges`（§13.2）
