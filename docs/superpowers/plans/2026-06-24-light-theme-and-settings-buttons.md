# Light Theme + Settings Button Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the theme toggle functional by replacing all hardcoded hex colors with CSS custom properties, and redesign Settings buttons to match the neon-border + SVG-icon style guide.

**Architecture:** CSS custom properties in `:root` (light) and `.dark` (dark) define all color tokens. Every component's inline `style` referencing a hex color gets replaced with `var(--token)`. The Settings panel replaces emoji icons with SVG stroke icons and switches from solid-fill to neon-border button style. xterm.js gets a light theme variant that applies on theme switch.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, Zustand 5, xterm.js 6

## Spec Reference

`docs/superpowers/specs/2026-06-24-light-theme-and-settings-buttons-design.md`

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `frontend/src/index.css` | **Modify** | Add `:root` / `.dark` CSS variable blocks; replace all hardcoded hex colors with `var()` |
| `frontend/src/components/Sidebar/Sidebar.tsx` | **Modify** | Replace ~40 hardcoded hex colors with CSS vars |
| `frontend/src/components/Terminal/Terminal.tsx` | **Modify** | Replace 5 hardcoded hex colors with CSS vars |
| `frontend/src/components/Modal/Modal.tsx` | **Modify** | Replace ~8 hardcoded hex colors with CSS vars |
| `frontend/src/components/Modal/ConfirmDialog.tsx` | **Modify** | Replace ~8 hardcoded hex colors with CSS vars |
| `frontend/src/components/Toast/Toast.tsx` | **Modify** | Already uses Tailwind `dark:` — no change needed |
| `frontend/src/components/Layout/MobileNav.tsx` | **Modify** | Already uses Tailwind `dark:` — no change needed |
| `frontend/src/components/Layout/Layout.tsx` | **Modify** | Replace ~6 hardcoded hex colors with CSS vars |
| `frontend/src/components/Settings/SettingsPopup.tsx` | **Modify** | Replace ~3 hardcoded hex colors with CSS vars |
| `frontend/src/components/Settings/Settings.tsx` | **Modify** | Full rewrite: neon-border buttons + SVG icons, replace all hardcoded colors |
| `frontend/src/hooks/useTerminal.ts` | **Modify** | Add light terminal theme, destroy/recreate on theme switch |
| `frontend/src/stores/themeStore.ts` | **No change** | Already correct — toggles `.dark` class |
| `docs/ui-style-guide.md` | **Modify** | Add light theme column to palette, update self-check list |

---

### Task 1: Add CSS custom properties to index.css

**Files:**
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Add `:root` and `.dark` variable blocks**

Add these blocks **after** the `@custom-variant dark` line and **before** the `@import "@xterm/xterm/css/xterm.css"` line in `frontend/src/index.css`:

```css
/* ────────────────────────────────────────────────────────────────────
   Theme tokens — :root = light, .dark = dark.
   Components use var(--token) instead of hardcoded hex.
   ──────────────────────────────────────────────────────────────────── */
:root {
  /* backgrounds */
  --bg-base: #f8fafc;
  --bg-elevated: #f1f5f9;
  --bg-surface: #ffffff;
  /* borders */
  --border-subtle: #e2e8f0;
  --border-strong: #cbd5e1;
  /* text */
  --text-primary: #0f172a;
  --text-secondary: #334155;
  --text-muted: #64748b;
  --text-faint: #94a3b8;
  --text-dim: #cbd5e1;
  /* accent */
  --accent: #7c3aed;
  --accent-bright: #6d28d9;
  --accent-10: rgba(124, 58, 237, 0.10);
  --accent-14: rgba(124, 58, 237, 0.14);
  --accent-glow-sm: 0 0 6px rgba(124, 58, 237, 0.4);
  --accent-glow-md: 0 0 10px rgba(124, 58, 237, 0.5);
  /* danger */
  --danger: #dc2626;
  --danger-12: rgba(220, 38, 38, 0.12);
  --danger-glow: 0 0 6px rgba(220, 38, 38, 0.3);
  /* success */
  --success: #16a34a;
  --success-glow: 0 0 6px #16a34a;
  /* scrollbar */
  --scrollbar-thumb: #cbd5e1;
  --scrollbar-track: #f1f5f9;
  color-scheme: light;
}

.dark {
  /* backgrounds */
  --bg-base: #0a0a0f;
  --bg-elevated: #111827;
  --bg-surface: #1e293b;
  /* borders */
  --border-subtle: #1e293b;
  --border-strong: #334155;
  /* text */
  --text-primary: #e2e8f0;
  --text-secondary: #cbd5e1;
  --text-muted: #94a3b8;
  --text-faint: #64748b;
  --text-dim: #475569;
  /* accent */
  --accent: #a78bfa;
  --accent-bright: #c4b5fd;
  --accent-10: rgba(167, 139, 250, 0.10);
  --accent-14: rgba(167, 139, 250, 0.14);
  --accent-glow-sm: 0 0 6px rgba(167, 139, 250, 0.5);
  --accent-glow-md: 0 0 10px rgba(167, 139, 250, 0.7);
  /* danger */
  --danger: #ef4444;
  --danger-12: rgba(239, 68, 68, 0.12);
  --danger-glow: 0 0 6px rgba(239, 68, 68, 0.3);
  /* success */
  --success: #4ade80;
  --success-glow: 0 0 6px #4ade80;
  /* scrollbar */
  --scrollbar-thumb: #334155;
  --scrollbar-track: #0a0a0f;
  color-scheme: dark;
}
```

Also remove the existing standalone `.dark { color-scheme: dark; }` block (it's now part of the full `.dark` block above).

- [ ] **Step 2: Verify CSS loads without errors**

Run: `cd frontend && pnpm dev` — check browser console for CSS parse errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "feat: add CSS custom properties for light/dark theme tokens"
```

---

### Task 2: Replace hardcoded colors in index.css

**Files:**
- Modify: `frontend/src/index.css`

- [ ] **Step 1: Replace all hardcoded hex colors in index.css with `var()` references**

Replace every occurrence of hardcoded hex values in the stylesheet rules (not inside the `:root`/`.dark` blocks) with the corresponding CSS variable. The mapping:

| Hardcoded | Replace with |
|-----------|-------------|
| `#0a0a0f` | `var(--bg-base)` |
| `#111827` | `var(--bg-elevated)` |
| `#1e293b` (as bg) | `var(--bg-surface)` |
| `#1e293b` (as border) | `var(--border-subtle)` |
| `#334155` (as border) | `var(--border-strong)` |
| `#334155` (as scrollbar thumb) | `var(--scrollbar-thumb)` |
| `#64748b` (text) | `var(--text-faint)` |
| `#94a3b8` (text) | `var(--text-muted)` |
| `#e2e8f0` (text) | `var(--text-primary)` |
| `#a78bfa` | `var(--accent)` |
| `#c4b5fd` | `var(--accent-bright)` |
| `rgba(167,139,250,...)` | use the matching `var(--accent-*)` or keep inline rgba where no token exists |
| `#475569` | `var(--text-dim)` |

**Specific sections to update:**

1. `.omniterm-drag-bar` — `background: #0a0a0f` → `var(--bg-base)`, hover `#111827` → `var(--bg-elevated)`, `#64748b` → `var(--text-faint)`, `#a78bfa` → `var(--accent)`, glow → `var(--accent-glow-sm)`
2. `.omnifm-root` — `background: #0a0a0f`, `color: #e2e8f0` → CSS vars
3. `.fm-toolbar` — `background: #0a0a0f`, `border-bottom: 1px solid #1e293b` → CSS vars
4. `.fm-breadcrumb` — all colors → CSS vars
5. `.fm-bc-root` — border + color → `var(--accent)`, hover bg → `var(--accent-14)`
6. `.fm-btn` — color `#94a3b8` → `var(--text-muted)`, hover → `var(--accent)` + `var(--accent-10)`
7. `.fm-search` — bg, border, color, focus, placeholder → CSS vars
8. `.fm-table-wrap` scrollbar — thumb/track → CSS vars
9. `.fm-table thead` — bg → `var(--bg-base)`
10. `.fm-table th` — color `#94a3b8`, border `#1e293b` → CSS vars
11. `.fm-th-sort:hover` — `#a78bfa` → `var(--accent)`
12. `.fm-th-resize:hover` — `#64748b` → `var(--text-faint)`
13. `.fm-row:hover`, `.fm-tr-selected` — violet rgba → `var(--accent-10)` / `var(--accent-14)`
14. `.fm-row td` — border `#111827` → `var(--bg-elevated)`
15. `.fm-td-name a` — color `#e2e8f0`, hover `#a78bfa` → CSS vars
16. `.fm-td-mtime`, `.fm-td-time`, `.fm-td-size` — `#64748b` → `var(--text-faint)`
17. `.fm-act-icon` — `#64748b` → `var(--text-faint)`, hover → `var(--accent)` + `var(--accent-10)`
18. `.fm-act-icon-danger:hover` — `#ef4444` → `var(--danger)`, bg → `var(--danger-12)`
19. `.fm-edit-input` — bg, border, color → CSS vars
20. `.fm-empty` — `#475569` → `var(--text-dim)`, `.fm-empty-hint` `#334155` → `var(--border-strong)`
21. `.sidebar-glow-*` — violet → `var(--accent)`, green → `var(--success)`, red → `var(--danger)`
22. `settings-slide-in` animation — no color to replace

- [ ] **Step 2: Verify no visual regression in dark mode**

Open the app in the browser. Dark mode should look identical to before.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/index.css
git commit -m "refactor: replace hardcoded hex colors with CSS custom properties in index.css"
```

---

### Task 3: Replace hardcoded colors in Layout.tsx

**Files:**
- Modify: `frontend/src/components/Layout/Layout.tsx`

- [ ] **Step 1: Add `useThemeStore` import and replace colors**

Add import at top:
```tsx
import { useThemeStore } from '../../stores/themeStore'
```

No — actually, for CSS vars we don't need the store. Just replace inline style hex values with `var()`.

In `Layout.tsx`, replace:

| Line(s) | Hardcoded | Replace with |
|---------|-----------|-------------|
| 107 | `background: '#0a0a0f'` | `background: 'var(--bg-base)'` |
| 107 | `color: '#e2e8f0'` | `color: 'var(--text-primary)'` |
| 116 | `background: '#0a0a0f'` | `background: 'var(--bg-base)'` |
| 117 | `borderRight: '1px solid #1e293b'` | `borderRight: '1px solid var(--border-subtle)'` |
| 152 | `background: '#0a0a0f'` | `background: 'var(--bg-base)'` |
| 153 | `borderLeft: '1px solid #1e293b'` | `borderLeft: '1px solid var(--border-subtle)'` |

- [ ] **Step 2: Verify**

Run dev server, check sidebar/terminal/filemanager panels render with correct backgrounds.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Layout/Layout.tsx
git commit -m "refactor: Layout.tsx uses CSS custom properties"
```

---

### Task 4: Replace hardcoded colors in Sidebar.tsx

**Files:**
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

- [ ] **Step 1: Replace all hardcoded colors**

This file has ~40 hardcoded hex references. Replace systematically:

**Shared input styles (line ~173-177):**
```tsx
const inputStyle: React.CSSProperties = {
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-strong)',
  color: 'var(--text-primary)',
}
```

**Collapsed sidebar (line ~182-224):**
- `background: '#0a0a0f'` → `'var(--bg-base)'`
- `color: '#e2e8f0'` → `'var(--text-primary)'`
- `color: '#64748b'` → `'var(--text-faint)'`
- `color: '#a78bfa'` → `'var(--accent)'`
- `background: 'rgba(167,139,250,0.1)'` → `'var(--accent-10)'`
- `background: '#a78bfa'` (dot) → `'var(--accent)'`
- `boxShadow: '0 0 8px #a78bfa, ...'` → `'var(--accent-glow-sm)'` (close enough)
- `border: '1px solid #334155'` → `'1px solid var(--border-strong)'`

**Expanded sidebar (line ~228-566):**
- All `background: '#0a0a0f'` → `'var(--bg-base)'`
- All `color: '#e2e8f0'` → `'var(--text-primary)'`
- All `color: '#94a3b8'` → `'var(--text-muted)'`
- All `color: '#64748b'` → `'var(--text-faint)'`
- All `color: '#475569'` → `'var(--text-dim)'`
- All `color: '#a78bfa'` → `'var(--accent)'`
- All `color: '#c4b5fd'` → `'var(--accent-bright)'`
- All `border: '1px solid #1e293b'` → `'1px solid var(--border-subtle)'`
- All `border: '1px solid #334155'` → `'1px solid var(--border-strong)'`
- All `border: '1px solid #a78bfa'` → `'1px solid var(--accent)'`
- All `background: 'rgba(167,139,250,...)'` → matching `var(--accent-10)` or `var(--accent-14)`
- All `boxShadow: '0 0 ...'` with violet → `var(--accent-glow-sm)` or `var(--accent-glow-md)`
- All `background: '#a78bfa'` → `'var(--accent)'`
- All `background: '#8b5cf6'` / `'#c4b5fd'` (hover) → `'var(--accent-bright)'`
- `background: '#4ade80'` → `'var(--success)'`
- `background: '#ef4444'` → `'var(--danger)'`
- `boxShadow: '0 0 6px #4ade80'` → `'var(--success-glow)'`
- `boxShadow: '0 0 6px #ef4444'` → `'var(--danger-glow)'`
- `border: '1px solid rgba(167,139,250,0.15)'` → `'1px solid var(--accent-14)'` (close enough)
- `border: '1px solid rgba(167,139,250,0.1)'` → `'1px solid var(--accent-10)'`
- `background: 'linear-gradient(90deg, rgba(167,139,250,0.12), transparent)'` → keep as-is (gradient with rgba)
- `borderColor: '#ef4444'` → `'var(--danger)'`
- `background: 'rgba(239,68,68,0.1)'` → `'var(--danger-12)'`

**Sub-components (DeleteButton, ModalCancel, ModalPrimary):**
- Same pattern — replace hex → `var()` using the mapping above.

**Gradient text (OmniTerm logo):**
```tsx
background: 'linear-gradient(90deg, var(--accent), #818cf8)'
```
Keep `#818cf8` as-is (it's a secondary gradient stop, not a primary token).

- [ ] **Step 2: Verify dark mode visually unchanged**

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "refactor: Sidebar.tsx uses CSS custom properties"
```

---

### Task 5: Replace hardcoded colors in Terminal.tsx

**Files:**
- Modify: `frontend/src/components/Terminal/Terminal.tsx`

- [ ] **Step 1: Replace colors**

```tsx
// Empty state (line ~26)
style={{ background: 'var(--bg-base)', color: 'var(--text-faint)', fontFamily: FONT }}

// Emoji filter (line ~33) — keep as-is, filter doesn't use hex for bg

// "选择或创建一个会话" (line ~38)
style={{ fontSize: 14, color: 'var(--text-muted)' }}

// Hint text (line ~39)
style={{ fontSize: 12, marginTop: 8, color: 'var(--text-dim)' }}

// Terminal container (line ~48)
style={{ height: '100%', background: 'var(--bg-base)' }}
```

- [ ] **Step 2: Verify**

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Terminal/Terminal.tsx
git commit -m "refactor: Terminal.tsx uses CSS custom properties"
```

---

### Task 6: Replace hardcoded colors in Modal.tsx and ConfirmDialog.tsx

**Files:**
- Modify: `frontend/src/components/Modal/Modal.tsx`
- Modify: `frontend/src/components/Modal/ConfirmDialog.tsx`

- [ ] **Step 1: Modal.tsx replacements**

```tsx
// Container (line ~38-42)
style={{
  background: 'var(--bg-elevated)',
  borderColor: 'var(--border-strong)',
  fontFamily: "'JetBrains Mono', ...",
}}

// Header border (line ~45)
style={{ borderBottom: '1px solid var(--border-strong)' }}

// Title (line ~46)
style={{ color: 'var(--text-primary)' }}

// Close button (line ~50)
style={{ color: 'var(--text-faint)' }}
// hover → color: 'var(--text-primary)', background: 'var(--accent-10)'
```

- [ ] **Step 2: ConfirmDialog.tsx replacements**

```tsx
// Message text (line ~32)
style={{ color: 'var(--text-muted)' }}

// Cancel button (line ~38)
style={{ border: '1px solid var(--border-strong)', color: 'var(--text-muted)' }}
// hover → background: 'var(--accent-10)', borderColor: 'var(--accent)', color: 'var(--text-primary)'

// Confirm button (line ~57)
style={{ background: destructive ? 'var(--danger)' : 'var(--accent)' }}
// hover → destructive ? 'var(--danger)' : 'var(--accent-bright)'
// Note: need to darken danger on hover — use a slightly darker shade or keep same.
```

- [ ] **Step 3: Verify**

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Modal/Modal.tsx frontend/src/components/Modal/ConfirmDialog.tsx
git commit -m "refactor: Modal and ConfirmDialog use CSS custom properties"
```

---

### Task 7: Replace hardcoded colors in SettingsPopup.tsx

**Files:**
- Modify: `frontend/src/components/Settings/SettingsPopup.tsx`

- [ ] **Step 1: Replace colors**

```tsx
// Container (line ~57-60)
style={{
  ...
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-strong)',
  boxShadow: '0 20px 50px rgba(0,0,0,0.7)',  // keep — shadow isn't theme-dependent
  ...
}}
```

- [ ] **Step 2: Verify**

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Settings/SettingsPopup.tsx
git commit -m "refactor: SettingsPopup uses CSS custom properties"
```

---

### Task 8: Redesign Settings.tsx — neon border + SVG icons

**Files:**
- Modify: `frontend/src/components/Settings/Settings.tsx`

This is the biggest change. Replace emoji icons + solid-fill buttons with SVG stroke icons + neon-border style.

- [ ] **Step 1: Rewrite Settings.tsx**

Replace the entire file content with:

```tsx
import { useTranslation } from 'react-i18next'
import { useThemeStore, type Theme } from '../../stores/themeStore'
import { useAppStore } from '../../stores/appStore'

const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

/* ── SVG icons (16×16, stroke-width 1.5, viewBox 0 0 24 24) ── */

function IconSun({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  )
}

function IconMoon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function IconMonitor({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

const themes: { value: Theme; labelKey: string; Icon: React.FC<{ size?: number }> }[] = [
  { value: 'light', labelKey: 'settings.light', Icon: IconSun },
  { value: 'dark', labelKey: 'settings.dark', Icon: IconMoon },
  { value: 'system', labelKey: 'settings.system', Icon: IconMonitor },
]

const languages = [
  { value: 'zh', label: '中' },
  { value: 'en', label: 'En' },
]

/* ── Neon border button style helpers ── */

const btnBase: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border-strong)',
  borderRadius: 6,
  transition: 'all 0.15s ease',
  fontFamily: FONT,
  cursor: 'pointer',
}

const btnActive: React.CSSProperties = {
  ...btnBase,
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  background: 'var(--accent-10)',
  boxShadow: 'var(--accent-glow-sm)',
}

function btnHover(e: React.MouseEvent) {
  e.currentTarget.style.borderColor = 'var(--accent)'
  e.currentTarget.style.color = 'var(--accent)'
  e.currentTarget.style.background = 'var(--accent-10)'
}

function btnLeave(e: React.MouseEvent, isActive: boolean) {
  if (isActive) {
    e.currentTarget.style.borderColor = 'var(--accent)'
    e.currentTarget.style.color = 'var(--accent)'
    e.currentTarget.style.background = 'var(--accent-10)'
    e.currentTarget.style.boxShadow = 'var(--accent-glow-sm)'
  } else {
    e.currentTarget.style.borderColor = 'var(--border-strong)'
    e.currentTarget.style.color = 'var(--text-muted)'
    e.currentTarget.style.background = 'transparent'
    e.currentTarget.style.boxShadow = 'none'
  }
}

export function Settings() {
  const { t, i18n } = useTranslation()
  const { theme, setTheme } = useThemeStore()
  const { fontSize, setFontSize } = useAppStore()

  return (
    <div style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: FONT }}>
      <div className="max-w-lg mx-auto p-4 space-y-6">
        <h2 style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 600 }}>{t('settings.title')}</h2>

        {/* Theme */}
        <section className="space-y-3">
          <h3 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>{t('settings.theme')}</h3>
          <div className="flex gap-2">
            {themes.map((th) => {
              const isActive = theme === th.value
              return (
                <button
                  key={th.value}
                  onClick={() => setTheme(th.value)}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-sm"
                  style={isActive ? btnActive : btnBase}
                  onMouseEnter={btnHover}
                  onMouseLeave={(e) => btnLeave(e, isActive)}
                >
                  <th.Icon size={16} />
                  <span>{t(th.labelKey)}</span>
                </button>
              )
            })}
          </div>
        </section>

        {/* Language */}
        <section className="space-y-3">
          <h3 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>{t('settings.language')}</h3>
          <div className="flex gap-2">
            {languages.map((lang) => {
              const isActive = i18n.language === lang.value || i18n.language.startsWith(lang.value)
              return (
                <button
                  key={lang.value}
                  onClick={() => i18n.changeLanguage(lang.value)}
                  className="flex-1 flex items-center justify-center px-3 py-2.5 text-sm"
                  style={{ ...(isActive ? btnActive : btnBase), fontSize: 12 }}
                  onMouseEnter={btnHover}
                  onMouseLeave={(e) => btnLeave(e, isActive)}
                >
                  {lang.label}
                </button>
              )
            })}
          </div>
        </section>

        {/* Font size */}
        <section className="space-y-3">
          <h3 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>
            {t('settings.fontSize')}
          </h3>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= 10}
              className="w-9 h-9 flex items-center justify-center text-lg"
              style={{
                ...btnBase,
                opacity: fontSize <= 10 ? 0.5 : 1,
                color: 'var(--text-muted)',
              }}
              onMouseEnter={btnHover}
              onMouseLeave={(e) => btnLeave(e, false)}
            >
              −
            </button>
            <div className="flex-1 text-center">
              <span style={{ fontSize: 24, fontFamily: FONT, fontWeight: 600, color: 'var(--text-primary)' }}>{fontSize}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>px</span>
            </div>
            <button
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= 24}
              className="w-9 h-9 flex items-center justify-center text-lg"
              style={{
                ...btnBase,
                opacity: fontSize >= 24 ? 0.5 : 1,
                color: 'var(--text-muted)',
              }}
              onMouseEnter={btnHover}
              onMouseLeave={(e) => btnLeave(e, false)}
            >
              +
            </button>
          </div>
          <input
            type="range"
            min={10}
            max={24}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            className="w-full"
            style={{ accentColor: 'var(--accent)' }}
          />
        </section>

        {/* Info */}
        <section className="space-y-3">
          <h3 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>{t('settings.about')}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }} className="space-y-1">
            <p>OmniTerm — Web-based tmux terminal manager</p>
            <p style={{ fontSize: 11, color: 'var(--text-faint)' }}>Phase 7 · MIT License</p>
          </div>
        </section>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify**

Check Settings popup in both collapsed and expanded sidebar. Buttons should show neon border + SVG icons. Hover shows violet border + glow. Active shows same + glow.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Settings/Settings.tsx
git commit -m "feat: redesign Settings buttons with neon border + SVG icons"
```

---

### Task 9: Add light terminal theme to useTerminal.ts

**Files:**
- Modify: `frontend/src/hooks/useTerminal.ts`

- [ ] **Step 1: Add theme-aware terminal creation**

The spec says xterm.js doesn't support runtime background color changes, so on theme switch we destroy and recreate the terminal. This is acceptable because theme switches are rare.

Changes:

1. Import `useThemeStore`:
```tsx
import { useThemeStore } from '../stores/themeStore'
```

2. Add terminal theme constants at module level:
```tsx
const DARK_TERMINAL_THEME = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  selectionBackground: '#33467c',
}

const LIGHT_TERMINAL_THEME = {
  background: '#f8fafc',
  foreground: '#0f172a',
  cursor: '#7c3aed',
  cursorAccent: '#f8fafc',
  selectionBackground: 'rgba(124,58,237,0.2)',
  black: '#0f172a',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#7c3aed',
  cyan: '#0891b2',
  white: '#334155',
  brightBlack: '#64748b',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#8b5cf6',
  brightCyan: '#06b6d4',
  brightWhite: '#0f172a',
}
```

3. In `useTerminal`, read the resolved theme:
```tsx
const resolved = useThemeStore((s) => s.resolved)
```

4. In `initTerminal`, use the resolved theme:
```tsx
const term = new Terminal({
  cursorBlink: true,
  fontSize,
  fontFamily: 'ui-monospace, Consolas, monospace',
  theme: resolved === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME,
})
```

5. Add an effect to recreate the terminal on theme change. Since the terminal is tied to the container div via `key` on the parent, the simplest approach is to add the resolved theme to `initTerminal`'s dependency array and force a remount. However, `initTerminal` is memoized — we need a different approach.

**Lazy approach:** Use `resolved` as part of the `key` on the Terminal container div in `Terminal.tsx`. When the key changes, React unmounts and remounts, which triggers `initTerminal` cleanup and re-init.

In `Terminal.tsx`, change:
```tsx
<div ref={containerRef} className="h-full w-full p-1" />
```
to:
```tsx
<div key={resolved} ref={containerRef} className="h-full w-full p-1" />
```

And import `useThemeStore` in Terminal.tsx:
```tsx
import { useThemeStore } from '../../stores/themeStore'
// ...
const resolved = useThemeStore((s) => s.resolved)
```

This is the simplest approach — no need to change `useTerminal.ts` internals beyond adding the theme constants and reading the store.

6. Final `useTerminal.ts` changes:
- Add import for `useThemeStore`
- Add theme constants
- Read `resolved` from store
- Use it in `Terminal` constructor theme option

- [ ] **Step 2: Update Terminal.tsx to pass theme key**

In `Terminal.tsx`:
```tsx
import { useThemeStore } from '../../stores/themeStore'

export function Terminal() {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const fontSize = useAppStore((s) => s.fontSize)
  const resolved = useThemeStore((s) => s.resolved)
  const { initTerminal } = useTerminal({ sessionId: activeSessionId, fontSize })

  // ... rest unchanged

  // In the return for active session:
  return (
    <div style={{ height: '100%', background: 'var(--bg-base)' }}>
      <div key={resolved} ref={containerRef} className="h-full w-full p-1" />
    </div>
  )
}
```

- [ ] **Step 3: Test theme switch**

1. Open app in dark mode → terminal should use dark theme
2. Switch to Light in Settings → terminal should briefly flash and reload with light bg
3. Switch back to Dark → same behavior

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useTerminal.ts frontend/src/components/Terminal/Terminal.tsx
git commit -m "feat: xterm.js adapts to light/dark theme with terminal recreation"
```

---

### Task 10: Update docs/ui-style-guide.md

**Files:**
- Modify: `docs/ui-style-guide.md`

- [ ] **Step 1: Update §1 总览**

Replace:
```
- 没有 "浅色模式" —— 本规范只覆盖深色主题
```
With:
```
- OmniTerm 支持亮/暗双主题，通过 CSS 变量（`:root` / `.dark`）切换
```

Also update the last line of §1:
```
> 最后更新：2026-06-24
```

- [ ] **Step 2: Update §2 色板 — add Light column**

For each palette section (2.1–2.6), add a `Light` column alongside the existing `Hex` column:

**§2.1 背景色阶:**
| Token | Dark | Light | 用途 |
|---|---|---|---|
| `bg-base` | `#0a0a0f` | `#f8fafc` | 所有面板背景 |
| `bg-elevated` | `#111827` | `#f1f5f9` | 浮动层 |

**§2.2 边框色:**
| Token | Dark | Light | 用途 |
|---|---|---|---|
| `border-subtle` | `#1e293b` | `#e2e8f0` | 主要分隔线 |
| `border-strong` | `#334155` | `#cbd5e1` | 浮动层边线 |

**§2.3 文本色阶:**
| Token | Dark | Light | 用途 |
|---|---|---|---|
| `text-primary` | `#e2e8f0` | `#0f172a` | 主要内容 |
| `text-secondary` | `#cbd5e1` | `#334155` | 次要内容 |
| `text-muted` | `#94a3b8` | `#64748b` | 辅助 |
| `text-faint` | `#64748b` | `#94a3b8` | 占位/禁用 |
| `text-dim` | `#475569` | `#cbd5e1` | 最弱 |

**§2.4 强调色:**
| Token | Dark | Light | 用途 |
|---|---|---|---|
| `accent-violet` | `#a78bfa` | `#7c3aed` | 主强调 |
| `accent-violet-bright` | `#c4b5fd` | `#6d28d9` | 次级 violet |

(etc. for remaining tokens)

**§2.5 功能色:**
| Token | Dark | Light | 用途 |
|---|---|---|---|
| `danger` | `#ef4444` | `#dc2626` | 删除 |
| `success` | `#4ade80` | `#16a34a` | 成功状态 |

- [ ] **Step 3: Update §5.2 按钮 — add light state descriptions**

Add after the existing button styles:
```
**Light theme adjustments:**
- Primary hover: `background: #6d28d9` (darker violet for contrast on light bg)
- All `rgba(167,139,250,...)` → `rgba(124,58,237,...)` (light accent)
```

- [ ] **Step 4: Update §9 自检清单**

Add item:
```
- [ ] 是否同时在亮/暗两种主题下测试了视觉效果？
```

- [ ] **Step 5: Commit**

```bash
git add docs/ui-style-guide.md
git commit -m "docs: update style guide with light theme palette and checklist"
```

---

### Task 11: Grep for remaining hardcoded hex colors

**Files:**
- Possibly multiple — any missed colors

- [ ] **Step 1: Search for remaining hardcoded hex colors in frontend components**

Run:
```bash
cd frontend/src
grep -rn '#0a0a0f\|#111827\|#1e293b\|#334155\|#e2e8f0\|#cbd5e1\|#94a3b8\|#64748b\|#475569\|#a78bfa\|#c4b5fd\|#ef4444\|#4ade80' --include='*.tsx' --include='*.ts' | grep -v 'node_modules' | grep -v 'themeStore'
```

Expected: Only `useTerminal.ts` theme constants and `index.css` `:root`/`.dark` blocks should remain.

- [ ] **Step 2: Fix any stragglers**

- [ ] **Step 3: Commit if fixes needed**

```bash
git add -A
git commit -m "refactor: clean up remaining hardcoded hex colors"
```

---

### Task 12: Final verification

- [ ] **Step 1: Dark mode regression check**

Switch to Dark theme. Walk through:
1. Sidebar — workspace list, session list, status bar, gear button
2. Terminal — empty state, connected terminal
3. FileManager — toolbar, file table, breadcrumb, search
4. Modals — create workspace, create session, delete confirm
5. Settings — theme buttons, language buttons, font size slider
6. Toast notifications

All should look identical to before.

- [ ] **Step 2: Light mode check**

Switch to Light theme. Same walkthrough:
1. Light gray backgrounds everywhere
2. Dark text readable
3. Violet accent visible but not jarring
4. Scrollbars light
5. Terminal has light background with dark text
6. xterm ANSI colors readable on light bg

- [ ] **Step 3: System theme check**

Switch to System. Verify it follows OS preference.

- [ ] **Step 4: Build check**

```bash
cd frontend && pnpm build
```

Expected: no errors.

- [ ] **Step 5: Final commit (if any remaining fixes)**

```bash
git add -A
git commit -m "feat: complete light theme + settings button redesign"
```
