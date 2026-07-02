# Pixel Phase 3 — Full Game UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform OmniTerm from a "modern web UI with pixel filter" into a full game-style terminal tool: parchment light theme (primary), pixel terminal logo + Press Start 2P wordmark, 15 gamified UI elements (title bars, sprite icons, segmented progress bars, RPG dialogue toasts, etc.), and 7 settings toggles.

**Architecture:** Build on Phase 1/2 foundations (deep-space dark palette + hard shadows + pixel animations + 8-bit audio). Introduce a new "parchment A2" light theme as the primary palette, keep the Phase 1 dark palette as night mode, and add a `frontend/src/components/PixelUI/` directory for new game-style primitives (SegmentedProgress, DialogueToast, PixelButton, PixelSprites, OmniTermLogo). Integrate into Sidebar / Terminal / FileManager / Modal / Toast / Settings via CSS classes and minimal JSX additions.

**Tech Stack:** React + Vite + Tailwind CSS + CSS Custom Properties + Google Fonts (`Press Start 2P`, `VT323`) + xterm.js + Zustand

**Spec:** `docs/superpowers/specs/2026-07-02-pixel-phase3-design.md`

**Plan layout:** 3 sub-phases totaling **24 tasks** — 3a (visual foundation, 8 tasks) → 3b (game UI elements, 5 tasks) → 3c (notifications + motion + settings + integration + adaptation, 11 tasks).

---

## File Structure

**Create:**
- `frontend/src/components/PixelUI/OmniTermLogo.tsx` — 16×16 pixel terminal sprite (renders at 48/96)
- `frontend/src/components/PixelUI/PixelSprites.tsx` — folder / file / status / git sprite set
- `frontend/src/components/PixelUI/SegmentedProgress.tsx` — HP/XP-style bar
- `frontend/src/components/PixelUI/DialogueToast.tsx` — Undertale-style notification
- `frontend/src/components/PixelUI/PixelButton.tsx` — Primary/Secondary/Accent/Danger variants
- `frontend/src/components/PixelUI/index.ts` — barrel exports
- `frontend/public/favicon.svg` — pixel terminal icon (replaces existing PNG)

**Modify:**
- `frontend/index.html` — load `Press Start 2P` font via Google Fonts
- `frontend/src/index.css` — light theme parchment tokens + all `.font-*` / `.panel-title-bar` / `.btn-*` / `.corner-nails` / `.progress-segmented` classes + parchment texture
- `frontend/src/stores/appStore.ts` — add 4 toggles (`pixelUiEnabled`, `pixelFontEnabled`, `parchmentTextureEnabled`, `transitionsEnabled`)
- `frontend/src/stores/themeStore.ts` — ensure light theme is the default (check current logic)
- `frontend/src/components/Settings/Settings.tsx` — 4 new toggle sections + i18n keys
- `frontend/src/locales/en/translation.json` — new keys
- `frontend/src/locales/zh/translation.json` — new keys
- `frontend/src/components/Sidebar/Sidebar.tsx` — Logo title bar + workspace/sessions title bars + SegmentedProgress + selected-item cursor
- `frontend/src/components/Terminal/Terminal.tsx` — title bar + pixel border wrapper
- `frontend/src/components/FileManager/FileManager.tsx` — title bar + sprite icons
- `frontend/src/components/FileManager/FileDrawer.tsx` — title bar
- `frontend/src/components/FileManager/FilePreview.tsx` — title bar
- `frontend/src/components/Settings/SettingsPopup.tsx` — title bar
- `frontend/src/components/Modal/Modal.tsx` — `.corner-nails` + pixel frame
- `frontend/src/components/Modal/ConfirmDialog.tsx` — `.corner-nails`
- `frontend/src/components/Toast/Toast.tsx` — pixel style + `★` prefix
- `frontend/src/components/Layout/Layout.tsx` — workspace transition animation
- `docs/ui-style-guide.md` — rewrite to Phase 3 spec (final task)

---

### Task 1: Font System — Introduce Press Start 2P + `.font-logo` / `.font-pixel` / `.font-reader`

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Load Press Start 2P in `frontend/index.html`**

Open `frontend/index.html`. Inside `<head>`, after the existing `<meta name="viewport">` and any existing font `<link>`, add:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap" rel="stylesheet">
```

(VT323 may already be loaded from Phase 1 — keep a single `<link>` and add `Press+Start+2P` to the `family` query parameter if so. Do not duplicate the `<link>`.)

- [ ] **Step 2: Add the three font classes to `frontend/src/index.css`**

Locate the existing `.font-pixel` rule (added in Phase 1). Replace it and add two new rules so that the file contains exactly:

```css
/* ────────────────────────────────────────────────────────────────────
   Font layers — three distinct stacks.
   .font-logo    → logo wordmark only (Press Start 2P)
   .font-pixel   → display text: titles, buttons, status labels
   .font-reader  → code, body, inputs (JetBrains Mono)
   ──────────────────────────────────────────────────────────────────── */

.font-logo {
  font-family: 'Press Start 2P', 'VT323', monospace;
  letter-spacing: 1px;
  text-transform: uppercase;
}

.font-pixel {
  font-family: 'VT323', 'Press Start 2P', monospace;
  letter-spacing: 1px;
  text-transform: uppercase;
}

.font-reader {
  font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace;
}
```

- [ ] **Step 3: Verify the fonts load**

Run `./dev.sh start`, open the browser, and in the DevTools console check `document.fonts.check('16px "Press Start 2P"')` — should return `true`. Apply `.font-logo` to a temporary element and confirm each glyph renders as pixel blocks (no anti-aliasing on curves).

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/src/index.css
git commit -m "feat(phase3): 引入 Press Start 2P 字体 + 三层字体栈 (.font-logo/.font-pixel/.font-reader)"
```

---

### Task 2: Pixel Terminal Icon — Create OmniTermLogo sprite component

**Files:**
- Create: `frontend/src/components/PixelUI/OmniTermLogo.tsx`

- [ ] **Step 1: Create the component**

```tsx
// frontend/src/components/PixelUI/OmniTermLogo.tsx
import React from 'react'

interface OmniTermLogoProps {
  /** Rendered size in px (default 48, must be multiple of 16 for crisp pixels) */
  size?: number
  className?: string
}

/**
 * 16×16 pixel-art CRT terminal sprite.
 *   #3A2E1F thick outer frame
 *   #12141A screen
 *   #7EE787 > prompt cursor (green)
 *   #58A6FF _ input cursor (blue)
 * Renders with image-rendering: pixelated for chunky retro blocks.
 */
export const OmniTermLogo: React.FC<OmniTermLogoProps> = ({ size = 48, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    shapeRendering="crispEdges"
    className={className}
    style={{ imageRendering: 'pixelated', flexShrink: 0 }}
    aria-label="OmniTerm logo"
  >
    {/* thick outer frame */}
    <rect x="1" y="1" width="14" height="2" fill="#3A2E1F" />
    <rect x="1" y="11" width="14" height="2" fill="#3A2E1F" />
    <rect x="1" y="1" width="2" height="12" fill="#3A2E1F" />
    <rect x="13" y="1" width="2" height="12" fill="#3A2E1F" />
    {/* screen */}
    <rect x="3" y="3" width="10" height="8" fill="#12141A" />
    {/* > prompt (green) */}
    <rect x="4" y="5" width="2" height="1" fill="#7EE787" />
    <rect x="5" y="6" width="1" height="1" fill="#7EE787" />
    <rect x="4" y="7" width="2" height="1" fill="#7EE787" />
    {/* _ cursor (blue) */}
    <rect x="7" y="8" width="4" height="1" fill="#58A6FF" />
    {/* stand */}
    <rect x="7" y="13" width="2" height="1" fill="#3A2E1F" />
    {/* base */}
    <rect x="5" y="14" width="6" height="1" fill="#3A2E1F" />
  </svg>
)
```

- [ ] **Step 2: Visually verify in DevTools**

Import `OmniTermLogo` into any rendered view (e.g. add `<OmniTermLogo size={96} />` temporarily to `Layout.tsx`) and confirm:
- At 48px and 96px, all pixel blocks are crisp (no anti-aliasing blur).
- The green `>` is clearly visible against the dark screen.

Remove the temporary import after verifying.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PixelUI/OmniTermLogo.tsx
git commit -m "feat(phase3): 创建 OmniTermLogo 像素终端图标组件 (16×16 sprite)"
```

---

### Task 3: Logo Title Bar — Sidebar top with pixel icon + Press Start 2P wordmark + version

**Files:**
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Add the `.logo-title-bar` CSS class**

Append to `frontend/src/index.css`:

```css
/* ────────────────────────────────────────────────────────────────────
   Logo title bar — sidebar top, wood background, pixel icon + wordmark
   ──────────────────────────────────────────────────────────────────── */
.logo-title-bar {
  padding: 14px 10px;
  background: var(--wood-dark, #8B5A2B);
  color: #FAF2DE;
  display: flex;
  align-items: center;
  gap: 12px;
  border-bottom: 2px solid var(--wood-shadow, #3A2E1F);
}

.logo-wordmark {
  font-family: 'Press Start 2P', 'VT323', monospace;
  font-size: 17px;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: #FAF2DE;
  line-height: 1.1;
}

.logo-version {
  font-family: 'VT323', monospace;
  font-size: 11px;
  color: #FFCB6B;
  letter-spacing: 1px;
  margin-top: 5px;
  line-height: 1;
}
```

- [ ] **Step 2: Replace the existing brand header in Sidebar.tsx**

Locate the existing brand/header block in `frontend/src/components/Sidebar/Sidebar.tsx`. Look for the gradient-styled `OmniTerm` text (Phase 1 used `linear-gradient(90deg, var(--accent), var(--accent-bright))` with `WebkitBackgroundClip: 'text'`). Replace that entire header block with:

```tsx
import { OmniTermLogo } from '../PixelUI/OmniTermLogo'

// ...inside the Sidebar JSX, replace the brand header with:
<div className="logo-title-bar">
  <OmniTermLogo size={48} />
  <div style={{ flex: 1, lineHeight: 1.1 }}>
    <div className="logo-wordmark">OmniTerm</div>
    <div className="logo-version">v{APP_VERSION} · LV.07</div>
  </div>
</div>
```

If the `APP_VERSION` constant isn't already imported in Sidebar.tsx, find where it's currently defined (likely via `import.meta.env.VITE_APP_VERSION`) and use the same pattern.

- [ ] **Step 3: Start the dev server and visually verify**

Run `./dev.sh start`, open the browser, and confirm:
- Sidebar top shows the wood-brown title bar.
- Pixel terminal icon is 48×48 and crisp.
- "OMNITERM" renders in Press Start 2P at 17px.
- Version + "LV.07" sits directly below in gold VT323.
- The title bar does NOT span across all three columns (only sidebar width).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "feat(phase3): 侧边栏顶部 Logo 标题牌 (48px 像素终端图标 + Press Start 2P 17px 字)"
```

---

### Task 4: Game-Style Button System — PixelButton component + `.btn-*` CSS classes

**Files:**
- Create: `frontend/src/components/PixelUI/PixelButton.tsx`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Add button CSS classes to index.css**

Append:

```css
/* ────────────────────────────────────────────────────────────────────
   Game-style buttons — Primary / Secondary / Accent / Danger
   All have hard shadow + active displacement.
   ──────────────────────────────────────────────────────────────────── */
.btn-pixel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  font-family: 'VT323', monospace;
  font-size: 14px;
  letter-spacing: 2px;
  text-transform: uppercase;
  border-radius: 0;
  cursor: pointer;
  transition: all 0.1s steps(3);
  white-space: nowrap;
}
.btn-pixel:active:not(:disabled) {
  transform: translate(3px, 3px);
  box-shadow: none !important;
}
.btn-pixel:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-pixel-primary {
  background: var(--wood-dark, #8B5A2B);
  color: #FAF2DE;
  border: 2px solid var(--wood-shadow, #3A2E1F);
  box-shadow: 3px 3px 0 var(--pixel-shadow-light, #8B7755);
}
.btn-pixel-primary:hover:not(:disabled) { background: #A06A3B; }

.btn-pixel-secondary {
  background: var(--bg-elevated-light, #EBE0C4);
  color: var(--wood-dark, #8B5A2B);
  border: 2px solid var(--wood-dark, #8B5A2B);
  box-shadow: 2px 2px 0 var(--pixel-shadow-light, #8B7755);
}

.btn-pixel-accent {
  background: var(--accent-light, #58A6FF);
  color: var(--wood-shadow, #3A2E1F);
  border: none;
  box-shadow: 0 3px 0 var(--wood-shadow, #3A2E1F);
}
.btn-pixel-accent:hover:not(:disabled) { background: #79C0FF; }

.btn-pixel-danger {
  background: var(--bg-elevated-light, #EBE0C4);
  color: var(--danger-light, #C85A3A);
  border: 2px solid var(--danger-light, #C85A3A);
  box-shadow: 2px 2px 0 var(--pixel-shadow-light, #8B7755);
}
```

- [ ] **Step 2: Create the PixelButton component**

```tsx
// frontend/src/components/PixelUI/PixelButton.tsx
import React from 'react'

export type PixelButtonVariant = 'primary' | 'secondary' | 'accent' | 'danger'

interface PixelButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: PixelButtonVariant
}

const variantClass: Record<PixelButtonVariant, string> = {
  primary: 'btn-pixel-primary',
  secondary: 'btn-pixel-secondary',
  accent: 'btn-pixel-accent',
  danger: 'btn-pixel-danger',
}

export const PixelButton: React.FC<PixelButtonProps> = ({
  variant = 'primary',
  className = '',
  children,
  ...rest
}) => (
  <button
    className={`btn-pixel ${variantClass[variant]} ${className}`}
    {...rest}
  >
    {children}
  </button>
)
```

- [ ] **Step 3: Visual sanity check**

Add `<PixelButton variant="primary">+ NEW</PixelButton>` (and each other variant) to a temporary render in `Sidebar.tsx` to confirm:
- All 4 variants render with chunky hard shadow.
- Clicking produces the 3px displacement + shadow vanishes.
- `text-transform: uppercase` applies.

Remove the temporary render afterward.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css frontend/src/components/PixelUI/PixelButton.tsx
git commit -m "feat(phase3): PixelButton 组件 + 四种游戏风按钮 CSS (Primary/Secondary/Accent/Danger)"
```

---

### Task 5: Light Theme — Parchment A2 palette + CSS variable system

**Files:**
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/stores/themeStore.ts` (verify light is default)

- [ ] **Step 1: Add light-theme parchment tokens to `:root` in index.css**

Locate the existing `:root` block (around lines 9-41). Replace or extend it with:

```css
:root {
  /* ── Parchment A2 light theme (primary) ── */
  --bg-base: #F5ECD8;
  --bg-elevated: #EBE0C4;
  --bg-surface: #FDF8EA;
  --border-subtle: #D4C4A0;
  --border-strong: #3A2E1F;
  --text-primary: #3A2E1F;
  --text-secondary: #6B5D45;
  --text-muted: #6B5D45;
  --text-faint: #A89474;
  --text-dim: #C9B88A;
  --accent: #58A6FF;
  --accent-bright: #79C0FF;
  --accent-pink: #F778BA;
  --danger: #C85A3A;
  --danger-12: rgba(200, 90, 58, 0.12);
  --success: #5A8F3A;
  --warning: #D4A05A;
  --wood-dark: #8B5A2B;
  --wood-shadow: #3A2E1F;
  --gold-light: #FFCB6B;
  --accent-light: #58A6FF;
  --danger-light: #C85A3A;
  --pixel-shadow: #8B7755;
  --bg-elevated-light: #EBE0C4;
  --pixel-shadow-light: #8B7755;
  --scrollbar-thumb: #8B7755;
  --scrollbar-track: #EBE0C4;
  color-scheme: light;
}
```

- [ ] **Step 2: Move the existing dark palette into a `.dark` selector**

Locate the existing `.dark` block (added in Phase 1). Ensure it contains all the dark tokens from Phase 1 (the `#12141A`-based palette). **Do not delete those tokens** — they remain the night-mode palette. If the file already has a correct `.dark` block, leave it unchanged. If the dark tokens are currently in `:root`, move them to `.dark`.

Confirm that the `.dark` block ends with `color-scheme: dark;` and the `:root` block ends with `color-scheme: light;`.

- [ ] **Step 3: Verify light theme is the default**

Read `frontend/src/stores/themeStore.ts` (the theme state lives in `themeStore`, not `appStore`). Confirm the default theme is `light`. If it defaults to `dark`, flip the default to `light` (this matches the spec's "light primary, dark as night mode"). Keep the user's persisted preference in localStorage respected — only change the fallback.

Note the exported selector/hook name — you will need it in Tasks 6/10/18 (likely `useThemeStore(state => state.theme)` or similar).

- [ ] **Step 4: Start the dev server and verify**

Run `./dev.sh start`. Confirm:
- The page loads with parchment background `#F5ECD8` (warm off-white).
- Text reads `#3A2E1F` (deep brown).
- Toggling to dark theme via the settings panel switches to the Phase 1 deep-space palette.
- Toggling back returns to parchment.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/index.css frontend/src/stores/themeStore.ts
git commit -m "feat(phase3): 亮色主题 A2 羊皮纸色板作为默认，Phase 1 深空灰保留为夜间模式"
```

---

### Task 6: Parchment Texture — Subtle dot-matrix background

**Files:**
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/stores/appStore.ts` (read the `parchmentTextureEnabled` flag — added in Task 12, so use a hardcoded-on default here and wire up later)

- [ ] **Step 1: Add the texture CSS rule**

Append to `frontend/src/index.css`:

```css
/* ────────────────────────────────────────────────────────────────────
   Parchment texture — very subtle dot-matrix on base background.
   Toggled via .parchment-texture on <body>.
   ──────────────────────────────────────────────────────────────────── */
body.parchment-texture {
  background:
    radial-gradient(circle at 1px 1px, rgba(139, 90, 43, 0.04) 1px, transparent 0) 0 0 / 8px 8px,
    var(--bg-base);
}
```

- [ ] **Step 2: Apply the class on body in the App entry point**

Locate the top-level `useEffect` (or add one) in `frontend/src/App.tsx` that toggles the `dark` class on `<body>` based on the current theme. The theme value comes from `themeStore` (not appStore):

```tsx
import { useThemeStore } from './stores/themeStore'
import { useAppStore } from './stores/appStore'

// inside App:
const theme = useThemeStore((s) => s.theme)

useEffect(() => {
  document.body.classList.toggle('dark', theme === 'dark')
  document.body.classList.toggle('parchment-texture', theme === 'light')
}, [theme])
```

The flag-driven version (gating on `parchmentTextureEnabled`) lands in Task 10.

- [ ] **Step 3: Visual verify**

Run `./dev.sh start`. Confirm:
- On light theme, the parchment background has a very faint 8px-spaced dot pattern (visible only when you look for it).
- Switching to dark theme removes the texture.
- Text remains fully readable — the texture must not affect legibility.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css frontend/src/App.tsx
git commit -m "feat(phase3): 羊皮纸背景点阵纹理 (亮色主题 + 8px 间距 4% 透明度)"
```

---

### Task 7: Panel Title Bar — `.panel-title-bar` CSS class

**Files:**
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Add the title-bar CSS class**

Append to `frontend/src/index.css`:

```css
/* ────────────────────────────────────────────────────────────────────
   Panel title bar — wood background, pixel font, 3px letter-spacing.
   Used on top of every panel (sidebar sections, terminal, file manager,
   settings, modal).
   ──────────────────────────────────────────────────────────────────── */
.panel-title-bar {
  padding: 5px 10px;
  background: var(--wood-dark, #8B5A2B);
  color: #FAF2DE;
  font-family: 'VT323', monospace;
  font-size: 13px;
  letter-spacing: 3px;
  text-transform: uppercase;
  border-bottom: 2px solid var(--wood-shadow, #3A2E1F);
  display: flex;
  align-items: center;
  gap: 6px;
}
.panel-title-bar .title-bar-spacer { margin-left: auto; }
.panel-title-bar .title-bar-badge {
  font-size: 11px;
  background: var(--wood-shadow, #3A2E1F);
  color: #7EE787;
  padding: 1px 6px;
}
.panel-title-bar .title-bar-path {
  font-size: 11px;
  color: #FFCB6B;
}
```

- [ ] **Step 2: Visual verify**

Temporarily add a `<div className="panel-title-bar"><span>◆</span><span>test</span><span className="title-bar-spacer"/><span className="title-bar-badge">● LIVE</span></div>` to any panel and confirm:
- Wood brown background.
- Pixel font, uppercase, 3px letter-spacing.
- Badge on the right with dark background and green text.

Remove the temporary element.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "feat(phase3): .panel-title-bar CSS 类 (木棕背景 + 像素字 + 徽章)"
```

---

### Task 8: Roll out `.panel-title-bar` to Terminal, FileManager, FileDrawer, FilePreview, SettingsPopup

**Files:**
- Modify: `frontend/src/components/Terminal/Terminal.tsx`
- Modify: `frontend/src/components/FileManager/FileManager.tsx`
- Modify: `frontend/src/components/FileManager/FileDrawer.tsx`
- Modify: `frontend/src/components/FileManager/FilePreview.tsx`
- Modify: `frontend/src/components/Settings/SettingsPopup.tsx`

For each file, wrap the top of the panel in a `<div className="panel-title-bar">` with an appropriate icon + title + optional right-side badge.

- [ ] **Step 1: Terminal panel**

Open `frontend/src/components/Terminal/Terminal.tsx`. Locate the outermost rendered element (the panel wrapper). Inside it, as the first child, insert:

```tsx
<div className="panel-title-bar">
  <span>◆</span>
  <span>terminal</span>
  <span className="title-bar-spacer" />
  {activeSession && <span className="title-bar-badge">● LIVE</span>}
</div>
```

Replace `activeSession` with whatever variable currently indicates a connected session. If there is no such variable, omit the badge and render just the title.

- [ ] **Step 2: FileManager panel**

Open `frontend/src/components/FileManager/FileManager.tsx`. As the first child of the panel wrapper, insert:

```tsx
<div className="panel-title-bar">
  <span>◆</span>
  <span>files</span>
  <span className="title-bar-spacer" />
  <span className="title-bar-path">~/{currentWorkspace ?? ''}</span>
</div>
```

Replace `currentWorkspace` with whatever prop/state holds the current workspace name (likely from appStore).

- [ ] **Step 3: FileDrawer panel**

Open `frontend/src/components/FileManager/FileDrawer.tsx`. Insert:

```tsx
<div className="panel-title-bar">
  <span>◆</span>
  <span>drawer</span>
</div>
```

- [ ] **Step 4: FilePreview panel**

Open `frontend/src/components/FileManager/FilePreview.tsx`. Insert:

```tsx
<div className="panel-title-bar">
  <span>◆</span>
  <span>preview</span>
</div>
```

- [ ] **Step 5: SettingsPopup**

Open `frontend/src/components/Settings/SettingsPopup.tsx`. Insert a title bar at the top of the popup contents:

```tsx
<div className="panel-title-bar">
  <span>◆</span>
  <span>settings</span>
</div>
```

- [ ] **Step 6: Visual verify**

Run `./dev.sh start`. Confirm every panel top now has a consistent wood-brown title bar. Switch to dark theme — the title bar should still render (the dark-theme values come from CSS variable fallback in Task 18).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/Terminal/Terminal.tsx \
        frontend/src/components/FileManager/FileManager.tsx \
        frontend/src/components/FileManager/FileDrawer.tsx \
        frontend/src/components/FileManager/FilePreview.tsx \
        frontend/src/components/Settings/SettingsPopup.tsx
git commit -m "feat(phase3): 为 Terminal / FileManager / FileDrawer / FilePreview / SettingsPopup 添加标题牌"
```

---

### Task 9: Settings Panel Toggles — 4 new switches in appStore + UI

**Files:**
- Modify: `frontend/src/stores/appStore.ts`
- Modify: `frontend/src/components/Settings/Settings.tsx`
- Modify: `frontend/src/locales/en/translation.json`
- Modify: `frontend/src/locales/zh/translation.json`

- [ ] **Step 1: Add 4 toggle fields to appStore**

Open `frontend/src/stores/appStore.ts`. Mirror the existing Phase 2 toggle pattern:

Add to the `AppState` interface (next to `crtScanlines`):
```ts
  pixelUiEnabled: boolean
  pixelFontEnabled: boolean
  parchmentTextureEnabled: boolean
  transitionsEnabled: boolean
```

Add to the setter interface:
```ts
  setPixelUiEnabled: (v: boolean) => void
  setPixelFontEnabled: (v: boolean) => void
  setParchmentTextureEnabled: (v: boolean) => void
  setTransitionsEnabled: (v: boolean) => void
```

Add initial values (all default `true` per spec §9):
```ts
    pixelUiEnabled: localStorage.getItem('omniterm_pixel_ui') !== 'false',
    pixelFontEnabled: localStorage.getItem('omniterm_pixel_font') !== 'false',
    parchmentTextureEnabled: localStorage.getItem('omniterm_parchment_texture') !== 'false',
    transitionsEnabled: localStorage.getItem('omniterm_transitions') !== 'false',
```

Add setter implementations (next to `setCrtScanlines`):
```ts
    setPixelUiEnabled: (v) => {
      localStorage.setItem('omniterm_pixel_ui', String(v))
      set({ pixelUiEnabled: v })
    },
    setPixelFontEnabled: (v) => {
      localStorage.setItem('omniterm_pixel_font', String(v))
      set({ pixelFontEnabled: v })
    },
    setParchmentTextureEnabled: (v) => {
      localStorage.setItem('omniterm_parchment_texture', String(v))
      set({ parchmentTextureEnabled: v })
    },
    setTransitionsEnabled: (v) => {
      localStorage.setItem('omniterm_transitions', String(v))
      set({ transitionsEnabled: v })
    },
```

- [ ] **Step 2: Add 4 toggle UI sections in Settings.tsx**

Open `frontend/src/components/Settings/Settings.tsx`. Locate the existing `crtScanlines` toggle section and follow its exact markup pattern. Add 4 new sections directly after, in this order:

1. 像素化 UI — `pixelUiEnabled` / `setPixelUiEnabled`
2. 像素字体 — `pixelFontEnabled` / `setPixelFontEnabled`
3. 羊皮纸纹理 — `parchmentTextureEnabled` / `setParchmentTextureEnabled`
4. 过场动效 — `transitionsEnabled` / `setTransitionsEnabled`

Use i18n keys `settings.pixelUi`, `settings.pixelUiHint`, `settings.pixelFont`, `settings.pixelFontHint`, `settings.parchmentTexture`, `settings.parchmentTextureHint`, `settings.transitions`, `settings.transitionsHint`.

- [ ] **Step 3: Add i18n strings**

In `frontend/src/locales/en/translation.json` under the `settings` object:
```json
"pixelUi": "Pixel UI",
"pixelUiHint": "Title bars, pixel buttons, segmented progress bars, corner nails",
"pixelFont": "Pixel Font",
"pixelFontHint": "Press Start 2P for logo, VT323 for titles and buttons",
"parchmentTexture": "Parchment Texture",
"parchmentTextureHint": "Subtle dot-matrix pattern on parchment background",
"transitions": "Transitions",
"transitionsHint": "Fade animation when switching workspaces"
```

In `frontend/src/locales/zh/translation.json` under the `settings` object:
```json
"pixelUi": "像素化 UI",
"pixelUiHint": "标题牌、像素按钮、分段进度条、角钉装饰",
"pixelFont": "像素字体",
"pixelFontHint": "Press Start 2P 用于 Logo，VT323 用于标题和按钮",
"parchmentTexture": "羊皮纸纹理",
"parchmentTextureHint": "羊皮纸背景上的微弱点阵图案",
"transitions": "过场动效",
"transitionsHint": "切换 workspace 时的淡入动画"
```

- [ ] **Step 4: Visual verify**

Run `./dev.sh start`. Open settings panel. Confirm:
- All 4 new toggles appear (plus the 3 from Phase 2 = 7 total).
- Default values are all ON.
- Toggling off persists after refresh (localStorage).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/stores/appStore.ts \
        frontend/src/components/Settings/Settings.tsx \
        frontend/src/locales/en/translation.json \
        frontend/src/locales/zh/translation.json
git commit -m "feat(phase3): appStore + Settings 新增 4 个游戏化开关 (pixelUi / pixelFont / parchmentTexture / transitions)"
```

---

### Task 10: Wire settings into CSS body classes

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Read settings and apply body classes**

Extend the existing `useEffect` that toggles `.dark` on `<body>` (from Task 6) to also toggle:

| Body class | When on |
|---|---|
| `.dark` | theme === 'dark' |
| `.parchment-texture` | theme === 'light' AND parchmentTextureEnabled |
| `.pixel-font-on` | pixelFontEnabled |
| `.pixel-ui-on` | pixelUiEnabled |

```tsx
import { useThemeStore } from './stores/themeStore'
import { useAppStore } from './stores/appStore'

// inside App:
const theme = useThemeStore((s) => s.theme)
const { pixelUiEnabled, pixelFontEnabled, parchmentTextureEnabled } = useAppStore()

useEffect(() => {
  document.body.classList.toggle('dark', theme === 'dark')
  document.body.classList.toggle('parchment-texture', theme === 'light' && parchmentTextureEnabled)
  document.body.classList.toggle('pixel-font-on', pixelFontEnabled)
  document.body.classList.toggle('pixel-ui-on', pixelUiEnabled)
}, [theme, pixelUiEnabled, pixelFontEnabled, parchmentTextureEnabled])
```

- [ ] **Step 2: Gate CSS rules behind body classes**

Update `frontend/src/index.css` so the pixel-font classes only apply when `body.pixel-font-on`:

```css
body.pixel-font-on .font-logo { font-family: 'Press Start 2P', 'VT323', monospace; }
body.pixel-font-on .font-pixel { font-family: 'VT323', 'Press Start 2P', monospace; }
/* Without the class, these fall back to system monospace */
.font-logo { font-family: monospace; }
.font-pixel { font-family: monospace; }
```

And gate the title bar / button styles behind `body.pixel-ui-on`:

```css
body.pixel-ui-on .panel-title-bar { /* existing rules */ }
body.pixel-ui-on .btn-pixel { /* existing rules */ }
/* Without the class, these elements render as plain <div>/<button> */
```

Do this by wrapping the existing rules with the `body.pixel-ui-on` prefix (duplicate the selectors or nest them).

- [ ] **Step 3: Verify toggle wiring**

Run `./dev.sh start`. Toggle each of the 4 switches off and on in Settings. Confirm:
- Pixel UI off → title bars render as plain divs (no wood background, no pixel font).
- Pixel Font off → "OMNITERM" wordmark falls back to system monospace.
- Parchment Texture off → solid parchment, no dot pattern.
- Transitions off → (no visible effect yet; this is wired in Task 15).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx frontend/src/index.css
git commit -m "feat(phase3): 将 4 个游戏化开关映射到 body 类，控制像素 UI 的启停"
```

---

### Task 11: PixelSprites — folder / file / status icon set

**Files:**
- Create: `frontend/src/components/PixelUI/PixelSprites.tsx`

- [ ] **Step 1: Create the sprite collection**

```tsx
// frontend/src/components/PixelUI/PixelSprites.tsx
import React from 'react'

interface SpriteProps {
  size?: number
  className?: string
  /** Override primary fill color (used for dark/light theme adaptation) */
  primaryColor?: string
}

const baseStyle = { imageRendering: 'pixelated' as const, flexShrink: 0 }

export const FolderSprite: React.FC<SpriteProps> = ({ size = 16, className, primaryColor = '#8B5A2B' }) => (
  <svg width={size} height={size * 0.875} viewBox="0 0 16 14" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="0" y="2" width="16" height="12" fill={primaryColor} />
    <rect x="0" y="0" width="6" height="4" fill={primaryColor} />
    <rect x="0" y="4" width="16" height="2" fill="#A06A3B" />
  </svg>
)

export const FileSprite: React.FC<SpriteProps> = ({ size = 16, className, primaryColor = '#A89474' }) => (
  <svg width={size * 0.875} height={size} viewBox="0 0 14 16" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="2" y="0" width="10" height="14" fill={primaryColor} />
    <rect x="4" y="2" width="6" height="2" fill="#FAF2DE" />
    <rect x="4" y="6" width="6" height="1" fill="#FAF2DE" />
    <rect x="4" y="8" width="6" height="1" fill="#FAF2DE" />
    <rect x="4" y="10" width="4" height="1" fill="#FAF2DE" />
  </svg>
)

export const FileCodeSprite: React.FC<SpriteProps> = ({ size = 16, className }) => (
  <svg width={size * 0.875} height={size} viewBox="0 0 14 16" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="2" y="0" width="10" height="14" fill="#58A6FF" />
    <rect x="4" y="3" width="2" height="1" fill="#12141A" />
    <rect x="3" y="4" width="1" height="2" fill="#12141A" />
    <rect x="4" y="6" width="2" height="1" fill="#12141A" />
    <rect x="8" y="3" width="2" height="1" fill="#12141A" />
    <rect x="10" y="4" width="1" height="2" fill="#12141A" />
    <rect x="8" y="6" width="2" height="1" fill="#12141A" />
  </svg>
)

export const StatusRunningSprite: React.FC<SpriteProps> = ({ size = 16, className }) => (
  <svg width={size} height={size * 0.5} viewBox="0 0 16 8" shapeRendering="crispEdges" style={baseStyle} className={className}>
    {[0, 3, 6, 9, 12].map((x) => (
      <rect key={x} x={x} y="0" width="2" height="8" fill="#7EE787" />
    ))}
  </svg>
)

export const StatusStoppedSprite: React.FC<SpriteProps> = ({ size = 16, className }) => (
  <svg width={size} height={size * 0.5} viewBox="0 0 16 8" shapeRendering="crispEdges" style={baseStyle} className={className}>
    {[0, 3, 6, 9, 12].map((x) => (
      <rect key={x} x={x} y="0" width="2" height="8" fill="#A89474" />
    ))}
  </svg>
)

export const GitBranchSprite: React.FC<SpriteProps> = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="4" y="2" width="2" height="12" fill="#F778BA" />
    <rect x="10" y="2" width="2" height="6" fill="#F778BA" />
    <rect x="6" y="6" width="4" height="2" fill="#F778BA" />
    <rect x="3" y="1" width="4" height="2" fill="#F778BA" />
    <rect x="9" y="1" width="4" height="2" fill="#F778BA" />
    <rect x="3" y="13" width="4" height="2" fill="#F778BA" />
  </svg>
)
```

- [ ] **Step 2: Create the barrel export**

```ts
// frontend/src/components/PixelUI/index.ts
export { OmniTermLogo } from './OmniTermLogo'
export { PixelButton } from './PixelButton'
export type { PixelButtonVariant } from './PixelButton'
export {
  FolderSprite,
  FileSprite,
  FileCodeSprite,
  StatusRunningSprite,
  StatusStoppedSprite,
  GitBranchSprite,
} from './PixelSprites'
```

- [ ] **Step 3: Visual verify**

Render each sprite at `size={32}` in a temporary panel and confirm all pixel blocks are crisp at every integer multiple (16/32/48/64).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/PixelUI/PixelSprites.tsx frontend/src/components/PixelUI/index.ts
git commit -m "feat(phase3): PixelSprites 组件集 (folder/file/code/status/git 16×16 sprite)"
```

---

### Task 12: SegmentedProgress — HP/XP-style bar

**Files:**
- Create: `frontend/src/components/PixelUI/SegmentedProgress.tsx`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Add the CSS**

Append to `frontend/src/index.css`:

```css
/* ────────────────────────────────────────────────────────────────────
   Segmented progress — HP/XP style bar of discrete blocks.
   ──────────────────────────────────────────────────────────────────── */
.progress-segmented { margin-top: 2px; }
.progress-segmented-label {
  display: flex;
  justify-content: space-between;
  font-family: 'VT323', monospace;
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--wood-dark, #8B5A2B);
  margin-bottom: 3px;
}
.progress-segmented-bar {
  display: flex;
  gap: 2px;
  height: 8px;
}
.progress-segmented-segment {
  flex: 1;
  background: #D4C4A0;
}
.progress-segmented-segment.filled { background: #5A8F3A; }
```

- [ ] **Step 2: Create the component**

```tsx
// frontend/src/components/PixelUI/SegmentedProgress.tsx
import React from 'react'

interface SegmentedProgressProps {
  label: string
  value: number
  max: number
  filledColor?: string
  emptyColor?: string
  className?: string
}

export const SegmentedProgress: React.FC<SegmentedProgressProps> = ({
  label,
  value,
  max,
  filledColor,
  emptyColor,
  className,
}) => (
  <div className={`progress-segmented ${className ?? ''}`}>
    <div className="progress-segmented-label">
      <span>{label}</span>
      <span>{value}/{max}</span>
    </div>
    <div className="progress-segmented-bar">
      {Array.from({ length: max }).map((_, i) => (
        <div
          key={i}
          className={`progress-segmented-segment ${i < value ? 'filled' : ''}`}
          style={
            i < value
              ? filledColor ? { background: filledColor } : undefined
              : emptyColor ? { background: emptyColor } : undefined
          }
        />
      ))}
    </div>
  </div>
)
```

- [ ] **Step 3: Add the export to the barrel**

Append to `frontend/src/components/PixelUI/index.ts`:

```ts
export { SegmentedProgress } from './SegmentedProgress'
```

- [ ] **Step 4: Visual verify**

Render `<SegmentedProgress label="SESSIONS" value={3} max={5} />` and confirm:
- 5 segments, 3 filled green, 2 empty beige.
- "SESSIONS" and "3/5" rendered in VT323 11px above the bar.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/index.css frontend/src/components/PixelUI/SegmentedProgress.tsx frontend/src/components/PixelUI/index.ts
git commit -m "feat(phase3): SegmentedProgress HP/XP 风格分段进度条"
```

---

### Task 13: Selected-item blinking cursor — CSS class `.selected-cursor`

**Files:**
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Add the CSS**

Append:

```css
/* ────────────────────────────────────────────────────────────────────
   Selected-item blinking cursor — pink ▶ that blinks in discrete steps.
   Apply to the indicator element inside a selected list row.
   ──────────────────────────────────────────────────────────────────── */
.selected-cursor {
  color: #F778BA;
  font-size: 16px;
  line-height: 1;
  animation: blink-cursor 1s steps(1) infinite;
}
.selected-cursor.inactive { color: transparent; animation: none; }

@keyframes blink-cursor {
  50% { opacity: 0; }
}
```

- [ ] **Step 2: Verify with a temporary list**

Render a small list where the active row has `<span className="selected-cursor">▶</span>` and inactive rows have `<span className="selected-cursor inactive">▶</span>`. Confirm the active one blinks at 1s interval.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "feat(phase3): 选中项粉色 ▶ 闪烁光标 (.selected-cursor)"
```

---

### Task 14: Terminal pixel border — `.terminal-panel-pixel` wrapper

**Files:**
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/components/Terminal/Terminal.tsx`

- [ ] **Step 1: Add the CSS**

Append:

```css
/* ────────────────────────────────────────────────────────────────────
   Terminal pixel border — wood-brown thick frame around xterm.
   Keeps the deep #12141A screen for code readability.
   ──────────────────────────────────────────────────────────────────── */
body.pixel-ui-on .terminal-panel-pixel {
  background: var(--bg-elevated, #EBE0C4);
  border: 2px solid var(--wood-shadow, #3A2E1F);
  box-shadow: 3px 3px 0 var(--pixel-shadow, #8B7755);
  display: flex;
  flex-direction: column;
}
body.pixel-ui-on .terminal-panel-pixel .xterm-viewport,
body.pixel-ui-on .terminal-panel-pixel .xterm {
  background: #12141A !important;
}
```

- [ ] **Step 2: Wrap the xterm host in Terminal.tsx**

Open `frontend/src/components/Terminal/Terminal.tsx`. Locate the element that hosts the xterm instance (likely a `<div ref={termRef}>`). Wrap it:

```tsx
<div className="terminal-panel-pixel" style={{ flex: 1, minHeight: 0 }}>
  <div ref={termRef} /* existing props */ />
</div>
```

Preserve all existing flex/grid layout behavior — only add the outer wrapper.

- [ ] **Step 3: Visual verify**

Run `./dev.sh start`. Confirm:
- Terminal panel has wood-brown 2px border + 3px hard shadow.
- Inside the terminal, background is still `#12141A` (deep) and ANSI colors from Phase 1 render correctly.
- Toggle off "Pixel UI" in settings → border reverts.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css frontend/src/components/Terminal/Terminal.tsx
git commit -m "feat(phase3): 终端像素边框 — 木棕 2px 厚框 + 3px 硬阴影，屏幕保持 #12141A"
```

---

### Task 15: Corner nails — `.corner-nails` for Modal / ConfirmDialog / DialogueToast

**Files:**
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/components/Modal/Modal.tsx`
- Modify: `frontend/src/components/Modal/ConfirmDialog.tsx`

- [ ] **Step 1: Add the CSS**

Append:

```css
/* ────────────────────────────────────────────────────────────────────
   Corner nails — gold squares at the 4 corners of floating panels.
   Uses 4 absolutely-positioned ::before/::after + 2 <span> children
   (since CSS only gives us 2 pseudo-elements).
   ──────────────────────────────────────────────────────────────────── */
.corner-nails { position: relative; }
.corner-nails::before,
.corner-nails::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  background: var(--gold-light, #FFCB6B);
  z-index: 1;
}
.corner-nails::before { top: -3px; left: -3px; }
.corner-nails::after  { top: -3px; right: -3px; }
.corner-nails > .nail-bl,
.corner-nails > .nail-br {
  position: absolute;
  width: 8px;
  height: 8px;
  background: var(--gold-light, #FFCB6B);
  z-index: 1;
}
.corner-nails > .nail-bl { bottom: -3px; left: -3px; }
.corner-nails > .nail-br { bottom: -3px; right: -3px; }
```

- [ ] **Step 2: Apply to Modal**

Open `frontend/src/components/Modal/Modal.tsx`. Locate the outermost modal frame element. Add `className="corner-nails"` and insert the two child spans as the first children:

```tsx
<div className="corner-nails" /* existing props */>
  <span className="nail-bl" />
  <span className="nail-br" />
  {/* existing children */}
</div>
```

- [ ] **Step 3: Apply to ConfirmDialog**

Same pattern in `frontend/src/components/Modal/ConfirmDialog.tsx`.

- [ ] **Step 4: Visual verify**

Open any modal (settings, new-project, confirm-dialog). Confirm four gold squares appear at the corners, slightly protruding (-3px) outside the frame.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/index.css frontend/src/components/Modal/Modal.tsx frontend/src/components/Modal/ConfirmDialog.tsx
git commit -m "feat(phase3): 角钉装饰 (.corner-nails) — Modal / ConfirmDialog 四角金色方块"
```

---

### Task 16: DialogueToast — Undertale-style notification component

**Files:**
- Create: `frontend/src/components/PixelUI/DialogueToast.tsx`
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/stores/toastStore.ts` (if present)

- [ ] **Step 1: Add the CSS**

Append:

```css
/* ────────────────────────────────────────────────────────────────────
   DialogueToast — Undertale-style RPG dialogue box for key notifications.
   Dark background + wood-shadow outer frame + corner nails.
   ──────────────────────────────────────────────────────────────────── */
.dialogue-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  max-width: 520px;
  padding: 12px 18px;
  background: #12141A;
  border: 3px solid var(--wood-shadow, #3A2E1F);
  color: #FAF2DE;
  font-family: 'VT323', monospace;
  font-size: 16px;
  letter-spacing: 1px;
  line-height: 1.4;
  box-shadow: 4px 4px 0 var(--pixel-shadow, #8B7755);
  z-index: 10000;
  animation: dialogue-toast-in 0.3s steps(3) forwards;
}
.dialogue-toast::before,
.dialogue-toast::after {
  content: '';
  position: absolute;
  width: 8px;
  height: 8px;
  background: var(--gold-light, #FFCB6B);
}
.dialogue-toast::before { top: -3px; left: -3px; }
.dialogue-toast::after  { top: -3px; right: -3px; }
.dialogue-toast > .nail-bl { position: absolute; width: 8px; height: 8px; background: var(--gold-light, #FFCB6B); bottom: -3px; left: -3px; }
.dialogue-toast > .nail-br { position: absolute; width: 8px; height: 8px; background: var(--gold-light, #FFCB6B); bottom: -3px; right: -3px; }
.dialogue-toast .dialogue-caret {
  text-align: right;
  color: #F778BA;
  font-size: 14px;
  animation: blink-cursor 1s steps(1) infinite;
  margin-top: 4px;
}
.dialogue-toast .highlight-name { color: #FFCB6B; }
.dialogue-toast .highlight-emotion { color: #F778BA; }

@keyframes dialogue-toast-in {
  from { opacity: 0; transform: translate(-50%, 8px); }
  to   { opacity: 1; transform: translate(-50%, 0); }
}
@keyframes dialogue-toast-out {
  from { opacity: 1; transform: translate(-50%, 0); }
  to   { opacity: 0; transform: translate(-50%, 8px); }
}
```

- [ ] **Step 2: Create the component**

```tsx
// frontend/src/components/PixelUI/DialogueToast.tsx
import React, { useEffect, useState } from 'react'

export interface DialogueToastProps {
  /** Raw text. Use placeholders like {name} and {emotion} which are highlighted. */
  message: string
  /** Optional name to highlight in gold (replaces {name}) */
  name?: string
  /** Optional emotion word to highlight in pink (replaces {emotion}) */
  emotion?: string
  /** Auto-dismiss duration in ms (default 4000) */
  duration?: number
  onDone?: () => void
}

export const DialogueToast: React.FC<DialogueToastProps> = ({
  message,
  name,
  emotion,
  duration = 4000,
  onDone,
}) => {
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const leaveTimer = setTimeout(() => setLeaving(true), duration - 300)
    const doneTimer = setTimeout(() => onDone?.(), duration)
    return () => {
      clearTimeout(leaveTimer)
      clearTimeout(doneTimer)
    }
  }, [duration, onDone])

  const parts = message.split(/(\{name\}|\{emotion\})/)

  return (
    <div
      className="dialogue-toast"
      style={leaving ? { animation: 'dialogue-toast-out 0.3s steps(3) forwards' } : undefined}
      role="status"
      aria-live="polite"
    >
      <span className="nail-bl" />
      <span className="nail-br" />
      <div>
        {parts.map((part, i) => {
          if (part === '{name}') return <span key={i} className="highlight-name">{name ?? ''}</span>
          if (part === '{emotion}') return <span key={i} className="highlight-emotion">{emotion ?? ''}</span>
          return <span key={i}>{part}</span>
        })}
      </div>
      <div className="dialogue-caret">▼</div>
    </div>
  )
}
```

- [ ] **Step 3: Export from barrel**

Append to `frontend/src/components/PixelUI/index.ts`:

```ts
export { DialogueToast } from './DialogueToast'
export type { DialogueToastProps } from './DialogueToast'
```

- [ ] **Step 4: Verify standalone**

Temporarily render `<DialogueToast message="* {name} loaded. * The terminal fills you with {emotion}." name="OmniTerm" emotion="DETERMINATION" />` in a view. Confirm:
- Dark box with wood border and 4 gold corner nails.
- "OmniTerm" is gold, "DETERMINATION" is pink.
- The caret `▼` blinks in pink.
- Auto-dismisses after 4s with a 0.3s step fade-out.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/index.css frontend/src/components/PixelUI/DialogueToast.tsx frontend/src/components/PixelUI/index.ts
git commit -m "feat(phase3): DialogueToast — Undertale 风 RPG 对话框通知组件"
```

---

### Task 17: Pixel-style regular Toast — restyle existing Toast component

**Files:**
- Modify: `frontend/src/components/Toast/Toast.tsx`
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Add the pixel toast CSS**

Append:

```css
/* ────────────────────────────────────────────────────────────────────
   Pixel-style toast — replaces the existing toast styling when
   body.pixel-ui-on is active. Adds a ★ prefix and pixel border.
   ──────────────────────────────────────────────────────────────────── */
body.pixel-ui-on .toast-pixel {
  background: #12141A;
  border: 2px solid var(--success, #5A8F3A);
  color: #7EE787;
  font-family: 'VT323', monospace;
  font-size: 14px;
  letter-spacing: 1px;
  box-shadow: 3px 3px 0 var(--pixel-shadow, #8B7755);
  border-radius: 0;
  padding: 8px 14px;
}
body.pixel-ui-on .toast-pixel.toast-error { border-color: var(--danger, #C85A3A); color: #FF7B72; }
body.pixel-ui-on .toast-pixel.toast-warning { border-color: var(--warning, #D4A05A); color: #FFCB6B; }
body.pixel-ui-on .toast-pixel.toast-info { border-color: var(--accent, #58A6FF); color: #79C0FF; }
```

- [ ] **Step 2: Update Toast.tsx to use pixel classes**

Open `frontend/src/components/Toast/Toast.tsx`. Replace the outer container's class/style to conditionally apply `.toast-pixel` and `.toast-{severity}` when `body.pixel-ui-on` is active. Prepend a `★` (or `✕` for error) to the message:

```tsx
const prefix = severity === 'error' ? '✕' : '★'
return (
  <div className={`toast-pixel toast-${severity}`}>
    {prefix} {message}
  </div>
)
```

Preserve the existing Toast API (props) and the store-driven dispatch — only change the rendered markup.

- [ ] **Step 3: Visual verify**

Trigger a toast (e.g. save action, or use a test harness). Confirm:
- Toast renders with dark background, green border, `★ FILE SAVED` style text.
- Error toasts render red.
- Toggle "Pixel UI" off → falls back to pre-Phase-3 style.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/index.css frontend/src/components/Toast/Toast.tsx
git commit -m "feat(phase3): 像素风 Toast — 深色背景 + 彩色边框 + ★/✕ 前缀"
```

---

### Task 18: Workspace transition animation

**Files:**
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/components/Layout/Layout.tsx`

- [ ] **Step 1: Add the CSS**

Append:

```css
/* ────────────────────────────────────────────────────────────────────
   Workspace transition — fade + slight Y shift, stepped for pixel feel.
   ──────────────────────────────────────────────────────────────────── */
body.transitions-on .workspace-transition {
  animation: workspace-fade 0.3s steps(3) forwards;
}
@keyframes workspace-fade {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 2: Toggle body class in App.tsx**

In `frontend/src/App.tsx`, extend the body-class `useEffect` (from Task 10) to also toggle `.transitions-on`:

```tsx
const { pixelUiEnabled, pixelFontEnabled, parchmentTextureEnabled, transitionsEnabled } = useAppStore()

useEffect(() => {
  document.body.classList.toggle('dark', theme === 'dark')
  document.body.classList.toggle('parchment-texture', theme === 'light' && parchmentTextureEnabled)
  document.body.classList.toggle('pixel-font-on', pixelFontEnabled)
  document.body.classList.toggle('pixel-ui-on', pixelUiEnabled)
  document.body.classList.toggle('transitions-on', transitionsEnabled)
}, [theme, pixelUiEnabled, pixelFontEnabled, parchmentTextureEnabled, transitionsEnabled])
```

- [ ] **Step 3: Apply the animation on workspace switch**

Open `frontend/src/components/Layout/Layout.tsx`. Locate the element that re-renders when the current workspace changes (likely a wrapper around the terminal / file manager). Add a `key={currentWorkspaceId}` to force remount and apply the class:

```tsx
<div key={currentWorkspaceId} className="workspace-transition">
  {/* existing children */}
</div>
```

- [ ] **Step 4: Visual verify**

Switch workspaces. Confirm:
- The content area fades in + slides up slightly with a 3-step animation.
- Toggle "Transitions" off in settings → instant switch, no animation.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/index.css frontend/src/App.tsx frontend/src/components/Layout/Layout.tsx
git commit -m "feat(phase3): 切换 workspace 时的淡入 + 上移动效 (.workspace-transition)"
```

---

### Task 19: Sidebar integration — title bars + sprites + cursor + SegmentedProgress

**Files:**
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

- [ ] **Step 1: Wrap "workspaces" and "sessions" sections in title bars**

Locate the existing section headers (e.g. "Workspaces" / "Sessions" labels). Wrap each:

```tsx
<div className="panel-title-bar">
  <span>◆</span>
  <span>{t('sidebar.workspaces')}</span>
</div>
```

And similarly for the sessions section.

- [ ] **Step 2: Add blinking cursor to selected workspace**

In the workspace list rendering, replace the existing selection indicator with:

```tsx
<span className={`selected-cursor ${isSelected ? '' : 'inactive'}`}>▶</span>
```

- [ ] **Step 3: Replace folder icons with FolderSprite**

Where workspace items currently render a folder icon (emoji or SVG), replace with `<FolderSprite size={14} />`.

- [ ] **Step 4: Add SegmentedProgress to the sessions section**

At the bottom of the sessions section, render:

```tsx
<SegmentedProgress
  label={t('sidebar.sessions')}
  value={activeSessionCount}
  max={maxSessionSlots}
/>
```

Replace `activeSessionCount` and `maxSessionSlots` with values from the existing session state (e.g. `sessions.filter(s => s.running).length` and `5`).

- [ ] **Step 5: Swap "New" / "Save" buttons for PixelButton**

Replace existing buttons:

```tsx
<PixelButton variant="accent" onClick={handleNew}>+ {t('common.new')}</PixelButton>
<PixelButton variant="secondary" onClick={handleSave}>{t('common.save')}</PixelButton>
```

- [ ] **Step 6: Visual verify**

Confirm the sidebar now shows:
- Logo title bar at top (from Task 3).
- Wood-brown "workspaces" and "sessions" title bars.
- Selected workspace with blinking `▶` cursor.
- Pixel folder sprites.
- HP/XP-style sessions bar at bottom.
- Accent "+ NEW" button + secondary "SAVE" button.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "feat(phase3): Sidebar 集成 — 标题牌 + 像素 folder sprite + 闪烁光标 + SegmentedProgress + PixelButton"
```

---

### Task 20: FileManager sprite icons

**Files:**
- Modify: `frontend/src/components/FileManager/FileManager.tsx`
- Modify: `frontend/src/components/FileManager/icons.tsx`

- [ ] **Step 1: Replace folder / file icons**

In `FileManager.tsx`, locate the row-render function that displays icons per file type. Replace:
- Folder rows → `<FolderSprite size={14} />`
- Code files (.ts/.tsx/.rs/.js/.py/.go/.c/.h) → `<FileCodeSprite size={14} />`
- Other files → `<FileSprite size={14} />`

- [ ] **Step 2: Preserve non-icon functionality**

Do not change click handlers, selection logic, or column sorting — only the icon rendering.

- [ ] **Step 3: Visual verify**

Open FileManager on a directory with mixed file types. Confirm:
- Folders show wood-brown pixel folder.
- Code files show blue pixel file with `</>` brackets.
- Other files show beige pixel file with line indicators.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/FileManager/FileManager.tsx frontend/src/components/FileManager/icons.tsx
git commit -m "feat(phase3): FileManager 文件图标替换为像素 sprite (folder/file/code)"
```

---

### Task 21: Dark-theme game UI adaptation

**Files:**
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Add dark-theme overrides for game UI**

Append to `frontend/src/index.css`:

```css
/* ────────────────────────────────────────────────────────────────────
   Dark theme (night mode) adaptation of game UI elements.
   The parchment wood tones become dark graphite + muted gold.
   ──────────────────────────────────────────────────────────────────── */
body.dark {
  --wood-dark: #2A2520;
  --wood-shadow: #090A0D;
  --gold-light: #8B7755;
  --bg-elevated: #1B1E26;
  --pixel-shadow: #090A0D;
  color-scheme: dark;
}
body.dark .logo-title-bar { background: #2A2520; border-bottom-color: #090A0D; }
body.dark .panel-title-bar { background: #2A2520; border-bottom-color: #090A0D; }
body.dark .btn-pixel-primary { background: #2A2520; color: #E6DFD0; border-color: #090A0D; box-shadow: 3px 3px 0 #090A0D; }
body.dark .btn-pixel-secondary { background: #1B1E26; color: #D1D5DB; border-color: #484F58; box-shadow: 2px 2px 0 #090A0D; }
body.dark .progress-segmented-segment { background: #30363D; }
body.dark .progress-segmented-segment.filled { background: #7EE787; }
body.dark .progress-segmented-label { color: #8B949E; }
body.dark .corner-nails::before,
body.dark .corner-nails::after,
body.dark .corner-nails > .nail-bl,
body.dark .corner-nails > .nail-br,
body.dark .dialogue-toast::before,
body.dark .dialogue-toast::after,
body.dark .dialogue-toast > .nail-bl,
body.dark .dialogue-toast > .nail-br { background: #8B7755; }
body.dark .logo-version { color: #8B7755; }
```

- [ ] **Step 2: Visual verify in night mode**

Switch to dark theme. Confirm:
- Title bars render with dark graphite `#2A2520` background and `#E6DFD0` text (readable).
- Corner nails become muted gold `#8B7755`.
- Segmented progress bar: filled `#7EE787`, empty `#30363D`.
- Buttons still have hard shadow, no glow.
- Logo sprite still reads correctly (the sprite uses hardcoded colors that work on both backgrounds).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "feat(phase3): 暗色主题游戏 UI 适配 (木棕 → 石墨 + 金色 → 暗金)"
```

---

### Task 22: Replace favicon with pixel terminal sprite

**Files:**
- Create: `frontend/public/favicon.svg`
- Modify: `frontend/index.html`

- [ ] **Step 1: Create the favicon.svg**

Write to `frontend/public/favicon.svg` (standalone SVG, not JSX):

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">
  <rect x="1" y="1" width="14" height="2" fill="#3A2E1F"/>
  <rect x="1" y="11" width="14" height="2" fill="#3A2E1F"/>
  <rect x="1" y="1" width="2" height="12" fill="#3A2E1F"/>
  <rect x="13" y="1" width="2" height="12" fill="#3A2E1F"/>
  <rect x="3" y="3" width="10" height="8" fill="#12141A"/>
  <rect x="4" y="5" width="2" height="1" fill="#7EE787"/>
  <rect x="5" y="6" width="1" height="1" fill="#7EE787"/>
  <rect x="4" y="7" width="2" height="1" fill="#7EE787"/>
  <rect x="7" y="8" width="4" height="1" fill="#58A6FF"/>
  <rect x="7" y="13" width="2" height="1" fill="#3A2E1F"/>
  <rect x="5" y="14" width="6" height="1" fill="#3A2E1F"/>
</svg>
```

- [ ] **Step 2: Update index.html to reference the new favicon**

Replace the existing favicon `<link>` (likely pointing to a PNG) with:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
```

If the existing tag is `<link rel="icon" href="/favicon.png">` or similar, replace it entirely.

- [ ] **Step 3: Verify in browser tab**

Run `./dev.sh start`, open the browser. Confirm the browser tab shows the pixel terminal icon (brown frame, dark screen, green prompt, blue cursor).

- [ ] **Step 4: Commit**

```bash
git add frontend/public/favicon.svg frontend/index.html
git commit -m "feat(phase3): favicon 替换为像素终端图标 SVG"
```

---

### Task 23: Visual regression pass + fix any remaining issues

- [ ] **Step 1: Run full manual checklist**

Run `./dev.sh start`. Walk through spec §13 self-check list verbatim:

- [ ] Light theme → three-column layout feels "like a game UI", not "modern web with filter"
- [ ] Dark theme (night mode) → all game UI elements adapt (graphite wood + muted gold)
- [ ] Terminal area remains deep `#12141A`, no clash with parchment
- [ ] Logo sprite crisp at 48×48, pixelated edges visible
- [ ] "OMNITERM" wordmark is Press Start 2P 17px, version is VT323 11px below
- [ ] All title bars consistent (wood + pixel font + 3px letter-spacing)
- [ ] All buttons have hard shadow + active displacement
- [ ] Segmented progress bar shows `3/5 sessions` correctly
- [ ] Selected item has blinking pink `▶` cursor
- [ ] Modal corners have gold nails
- [ ] Triggering a DialogueToast shows the RPG dialogue box
- [ ] Regular toasts use pixel style with `★` prefix
- [ ] All 7 settings toggles work and persist across refresh
- [ ] "Pixel UI" off → falls back to Phase 1 style
- [ ] Mobile (MobileLayout) — verify Logo title bar + terminal border + toasts render
- [ ] favicon crisp in browser tab

- [ ] **Step 2: Fix every unchecked item**

For each unchecked item, open the relevant file and apply the minimal fix. Do not expand scope — one fix per issue.

- [ ] **Step 3: Re-run the checklist until 100%**

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix(phase3): 像素风阶段 3 视觉回归修复"
```

---

### Task 24: Rewrite `docs/ui-style-guide.md` to Phase 3 spec

**Files:**
- Rewrite: `docs/ui-style-guide.md`

- [ ] **Step 1: Read the current guide**

```bash
cat docs/ui-style-guide.md | head -100
```

Note the section structure (§1 总览, §2 色板, §3 像素化, §4 字体, §5 间距, §6 组件, §7 动效, §8 布局, §9 第三方, §10 自检, §11 示例, §12 版本).

- [ ] **Step 2: Rewrite following the Phase 3 spec**

Replace the entire file with content that mirrors `docs/superpowers/specs/2026-07-02-pixel-phase3-design.md`, with these key changes from the Phase 1 guide:

**§1 设计语言总览** — change from "Cyber-Pixel 深空灰打底" to "Stardew × Celeste × Undertale 混搭。亮色羊皮纸为主，深空灰为夜间模式"。

**§2 色板** — replace the Dark/Light columns so that the **Light column is now the primary parchment palette** (§2.1 of Phase 3 spec: `#F5ECD8` / `#EBE0C4` / `#FDF8EA`, wood `#8B5A2B`, text `#3A2E1F`). Keep the Dark column as night mode with Phase 1 deep-space palette + Phase 3 graphite-wood adaptation (Task 21).

**§3 像素化规则** — keep the existing SVG `crispEdges` + hard-shadow rules. Add a new §3.5 "游戏 UI 元素" section covering:
- `.panel-title-bar` (wood + pixel font + 3px letter-spacing)
- `.btn-pixel` (4 variants)
- `.progress-segmented` (HP/XP bar)
- `.corner-nails` (4 gold squares)
- `.selected-cursor` (blinking pink ▶)
- `.dialogue-toast` (Undertale-style RPG box)
- `.toast-pixel` (regular toast with ★ prefix)

**§4 字体** — replace with the three-layer system: `.font-logo` (Press Start 2P 17px), `.font-pixel` (VT323 13-15px), `.font-reader` (JetBrains Mono). Remove the old Zpix reference.

**§5 间距与圆角** — unchanged from Phase 1.

**§6 组件规范** — replace §6.2 buttons with the 4-variant PixelButton system. Add new subsections: §6.8 Logo Title Bar, §6.9 Segmented Progress, §6.10 Corner Nails, §6.11 Dialogue Toast, §6.12 Pixel Toast.

**§7 动效** — add §7.4 "Workspace transition" (the `workspace-fade` keyframes). Keep Phase 2 `mario-jump`, `coin-pop`, `stomp-vanish`, `starman-flash`.

**§8 布局** — unchanged.

**§9 第三方组件** — add note that terminal panel uses `.terminal-panel-pixel` wrapper (wood border + deep screen).

**§10 自检清单** — add Phase 3 items:
- [ ] Logo sprite renders crisp at 48×48?
- [ ] Wordmark uses Press Start 2P 17px?
- [ ] All panels have title bars?
- [ ] All buttons use `.btn-pixel` variants?
- [ ] Corner nails on Modal?
- [ ] Segmented progress used for "X/Y" values?
- [ ] Selected item has blinking cursor?
- [ ] Both light and dark themes render game UI correctly?

**§11 示例片段** — replace React templates with Phase 3 game-UI templates (Logo title bar, PixelButton, SegmentedProgress, DialogueToast).

**§12 版本记录** — append a new row:
```
| 2026-07-02 | Phase 3 全游戏 UI 改造：亮色羊皮纸 A2 作为主主题 + 深空灰保留为夜间模式。新增 Logo 像素终端图标 + Press Start 2P 字标。新增标题牌、4 种游戏风按钮、分段进度条、角钉装饰、闪烁光标、Undertale 对话框 toast、像素风 toast、过场动效。新增 4 个设置开关（pixelUi / pixelFont / parchmentTexture / transitions），加上 Phase 2 的 3 个共 7 个 toggle |
```

- [ ] **Step 3: Commit**

```bash
git add docs/ui-style-guide.md
git commit -m "docs: 重写 UI 风格规范为 Phase 3 全游戏 UI 规范 (Stardew × Celeste × Undertale 混搭)"
```
