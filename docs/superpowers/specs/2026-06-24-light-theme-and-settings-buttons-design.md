# Light Theme + Settings Button Redesign

> **Date:** 2026-06-24
> **Status:** Approved
> **Scope:** Frontend theme system + Settings component UI

---

## 1. Problem

### 1.1 Theme toggle is non-functional

The Settings panel offers three theme options (Light / Dark / System), and `themeStore.ts` correctly toggles the `.dark` class on `<html>`. However, **all component colors are hardcoded as inline styles** (e.g., `background: '#0a0a0f'`), so the `.dark` class has no visual effect. Switching to "Light" does nothing.

### 1.2 Settings buttons are inconsistent

The theme/language selection buttons use **emoji icons** (☀️ 🌙 💻) and **violet solid-fill** for the active state. This conflicts with the project's established button language: **neon border** (transparent bg + colored border) + **SVG stroke icons** (as seen in Sidebar's + and ⚙ buttons).

---

## 2. Goals

| # | Goal | Success criteria |
|---|------|-----------------|
| G1 | Light theme fully functional | Switching to Light changes all panels to light gray background + dark text |
| G2 | Visual consistency | Light theme preserves the "dark tech" aesthetic — violet accent, same spacing/radius/typography |
| G3 | Settings buttons match style guide | Theme/language buttons use neon border + SVG stroke icons, consistent with Sidebar |
| G4 | No regressions | Dark theme looks identical to current state |
| G5 | xterm adapts | Terminal background/text colors match the active theme |

---

## 3. Design

### 3.1 CSS Custom Properties

Add two sets of CSS variables in `index.css`: `:root` (light) and `.dark` (dark).

```css
:root {
  /* Light theme */
  --bg-base: #f8fafc;
  --bg-elevated: #f1f5f9;
  --bg-surface: #ffffff;
  --border-subtle: #e2e8f0;
  --border-strong: #cbd5e1;
  --text-primary: #0f172a;
  --text-secondary: #334155;
  --text-muted: #64748b;
  --text-faint: #94a3b8;
  --text-dim: #cbd5e1;
  --accent: #7c3aed;
  --accent-bright: #6d28d9;
  --accent-10: rgba(124,58,237,0.10);
  --accent-14: rgba(124,58,237,0.14);
  --accent-glow-sm: 0 0 6px rgba(124,58,237,0.4);
  --accent-glow-md: 0 0 10px rgba(124,58,237,0.5);
  --danger: #dc2626;
  --danger-12: rgba(220,38,38,0.12);
  --danger-glow: 0 0 6px rgba(220,38,38,0.3);
  --success: #16a34a;
  --success-glow: 0 0 6px #16a34a;
  --scrollbar-thumb: #cbd5e1;
  --scrollbar-track: #f1f5f9;
  color-scheme: light;
}

.dark {
  --bg-base: #0a0a0f;
  --bg-elevated: #111827;
  --bg-surface: #1e293b;
  --border-subtle: #1e293b;
  --border-strong: #334155;
  --text-primary: #e2e8f0;
  --text-secondary: #cbd5e1;
  --text-muted: #94a3b8;
  --text-faint: #64748b;
  --text-dim: #475569;
  --accent: #a78bfa;
  --accent-bright: #c4b5fd;
  --accent-10: rgba(167,139,250,0.10);
  --accent-14: rgba(167,139,250,0.14);
  --accent-glow-sm: 0 0 6px rgba(167,139,250,0.5);
  --accent-glow-md: 0 0 10px rgba(167,139,250,0.7);
  --danger: #ef4444;
  --danger-12: rgba(239,68,68,0.12);
  --danger-glow: 0 0 6px rgba(239,68,68,0.3);
  --success: #4ade80;
  --success-glow: 0 0 6px #4ade80;
  --scrollbar-thumb: #334155;
  --scrollbar-track: #0a0a0f;
  color-scheme: dark;
}
```

**Color choices rationale:**
- Light `--accent: #7c3aed` is slightly darker than dark's `#a78bfa` for WCAG AA contrast on `#f8fafc` background
- Light `--success: #16a34a` is darker than dark's `#4ade80` for the same reason
- `color-scheme` property lets native browser UI (scrollbars, form controls) adapt automatically

### 3.2 Component Refactoring

Replace all hardcoded color values in inline styles with `var(--token)` references.

**Files to modify:**

| File | Changes |
|------|---------|
| `Sidebar.tsx` | Background, text, border, hover, glow colors → CSS vars |
| `Terminal.tsx` | Background, empty-state text colors → CSS vars |
| `Settings.tsx` | Full rewrite of button styles (see §3.3) |
| `SettingsPopup.tsx` | Background, border, shadow → CSS vars |
| `Modal.tsx` | Background, border, text, overlay → CSS vars |
| `ConfirmDialog.tsx` | Background, border, text, button colors → CSS vars |
| `Toast.tsx` | Background, text, border → CSS vars |
| `MobileNav.tsx` | Background, text, active indicator → CSS vars |
| `Layout.tsx` | Drag bar colors, panel backgrounds → CSS vars |
| `index.css` | Drag bar colors, FileManager colors, scrollbar, sidebar glow → CSS vars |

**Not changed:**
- xterm.js terminal theme (set via JS API, see §3.4)
- SVG icon paths (use `currentColor`, inherit from parent text color)
- `themeStore.ts` (already correct — toggles `.dark` class)

### 3.3 Settings Buttons Redesign

#### Theme buttons (3 buttons)

Replace emoji + solid-fill with SVG stroke icons + neon border:

| State | Style |
|-------|-------|
| Default | `background: transparent`, `border: 1px solid var(--border-strong)`, icon `color: var(--text-muted)` |
| Hover | `border-color: var(--accent)`, icon `color: var(--accent)`, `background: var(--accent-10)` |
| Active/Selected | `border-color: var(--accent)`, icon `color: var(--accent)`, `background: var(--accent-10)`, `box-shadow: var(--accent-glow-sm)` |

**Icons** (SVG, 16×16, stroke-width: 1.5, viewBox 0 0 24 24):
- Light: half-circle (left half filled) — sun/moon hybrid
- Dark: filled circle with rays — moon/sun
- System: monitor outline — desktop

#### Language buttons (2 buttons)

Same neon border style, no icons, text only (`中` / `En`):
- Font size: 12px
- Same state transitions as theme buttons

#### Font size +/- buttons

Already neon border style. Only change: replace hardcoded colors with CSS vars.

### 3.4 xterm.js Terminal Theme

In `useTerminal.ts`, read `useThemeStore().resolved` and pass a matching terminal theme:

**Light terminal theme:**
```js
{
  background: '#f8fafc',
  foreground: '#0f172a',
  cursor: '#7c3aed',
  cursorAccent: '#f8fafc',
  selectionBackground: 'rgba(124,58,237,0.2)',
  // ANSI 16 colors — slightly darker versions for light bg
  black: '#0f172a', red: '#dc2626', green: '#16a34a', yellow: '#ca8a04',
  blue: '#2563eb', magenta: '#7c3aed', cyan: '#0891b2', white: '#334155',
  brightBlack: '#64748b', brightRed: '#ef4444', brightGreen: '#22c55e', brightYellow: '#eab308',
  brightBlue: '#3b82f6', brightMagenta: '#8b5cf6', brightCyan: '#06b6d4', brightWhite: '#0f172a',
}
```

**Dark terminal theme** (existing, no change):
```js
{
  background: '#0a0a0f',
  foreground: '#e2e8f0',
  cursor: '#a78bfa',
  cursorAccent: '#0a0a0f',
  selectionBackground: 'rgba(167,139,250,0.3)',
  // existing ANSI colors
}
```

**Theme switching:** xterm.js does not support runtime background color changes. On theme switch, destroy and re-create the terminal instance. This is acceptable because theme switches are rare user actions.

### 3.5 Style Guide Update

Update `docs/ui-style-guide.md`:

1. **§1 总览**: Remove "没有 '浅色模式'" statement. Add: "OmniTerm 支持亮/暗双主题，通过 CSS 变量切换。"
2. **§2 色板**: Each token gets a `Light` and `Dark` column
3. **§5.2 按钮**: Add light-state descriptions
4. **§9 自检清单**: Add item: "是否同时在亮/暗两种主题下测试了视觉效果？"

---

## 4. Implementation Order

1. **CSS variables** — Add `:root` and `.dark` variable blocks to `index.css`
2. **index.css refactor** — Replace all hardcoded colors in drag bar, FileManager, scrollbar, animations with `var()`
3. **Component refactor** — Update inline styles in all components (Sidebar → Terminal → Modal → Toast → MobileNav → Layout)
4. **Settings buttons** — Rewrite Settings.tsx with neon border style + SVG icons
5. **xterm theme** — Add light theme to useTerminal.ts, handle theme switch with terminal re-creation
6. **Style guide** — Update docs/ui-style-guide.md
7. **Test** — Verify both themes work, no visual regressions in dark mode

---

## 5. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Hardcoded colors missed in refactor | Some elements don't change in light mode | Grep for remaining hex colors after refactor |
| xterm re-creation on theme switch | Brief flash | Acceptable — theme switch is infrequent |
| Light theme violet contrast too low | Text unreadable | Use `#7c3aed` (darker) instead of `#a78bfa` on light bg |
| CSS variable performance | Negligible | CSS vars are resolved at paint time, no runtime cost |
