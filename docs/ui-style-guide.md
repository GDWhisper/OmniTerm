# OmniTerm UI Style Guide

> Single source of truth for OmniTerm's Phase 3 pixel game UI system.
> Last updated: 2026-07-02

## 1. Theme System

Two themes controlled by `.dark` on `<html>`:

### 1.1 Parchment A2 Light (primary / default)

| Token | Value | Usage |
|---|---|---|
| `--bg-base` | `#F5ECD8` | Page & panel base |
| `--bg-elevated` | `#EBE0C4` | Cards, panels, secondary buttons |
| `--bg-surface` | `#FDF8EA` | Inputs, highlights |
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

### 1.2 Deep-space Dark (night mode, `.dark`)

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

## 12. SVG & Rendering Rules

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

## 13. New Component Checklist

Before adding any new UI element, verify:

- [ ] Uses CSS variables (`var(--token)`) not hardcoded hex
- [ ] Hard shadow uses `3px 3px 0` (not `4px` blur, not glow)
- [ ] `border-radius: 0` everywhere (modals: `2px` max)
- [ ] Pixel font (`.font-pixel`) only for display text, not body/code
- [ ] Interactive element has `body.pixel-ui-on` gate if it's a game element
- [ ] Tested in both light and dark themes
- [ ] Transitions use `steps(3)` for pixel elements, `ease-out` for modals
- [ ] No emoji characters — SVG or monospace glyphs only
- [ ] SVG has `shape-rendering: crispEdges`, even stroke-widths
