# Settings Popup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change Settings from a full-panel terminal replacement to a floating popup anchored in the Sidebar.

**Architecture:** A new `SettingsPopup` component renders inside `Sidebar.tsx` using absolute positioning. In expanded state it fills the sidebar width above the status bar; in collapsed state it floats to the right of the 40px sidebar at 280px fixed width. Click-outside and Escape dismiss it.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, Zustand 5

## Global Constraints

- Desktop only — mobile `MobileContent` tab behavior unchanged
- `appStore.ts` — no changes to `settingsOpen` / `toggleSettings()`
- Follow existing inline-style + Tailwind hybrid pattern (Sidebar uses inline styles heavily)
- Dark-tech palette: `#0f1729` bg, `#1e293b` border, `#a78bfa` accent

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `frontend/src/components/Settings/SettingsPopup.tsx` | **Create** | Floating popup container with dismiss logic |
| `frontend/src/components/Settings/Settings.tsx` | **Modify** | Remove `h-full`, adapt to popup container |
| `frontend/src/components/Sidebar/Sidebar.tsx` | **Modify** | Render `SettingsPopup`, update collapsed gear button |
| `frontend/src/components/Layout/Layout.tsx` | **Modify** | Remove Settings conditional, always render Terminal |

---

### Task 1: Create SettingsPopup component

**Files:**
- Create: `frontend/src/components/Settings/SettingsPopup.tsx`

**Interfaces:**
- Consumes: `useAppStore` → `settingsOpen`, `toggleSettings()`, `sidebarCollapsed`
- Consumes: `<Settings />` component from `./Settings`
- Produces: `SettingsPopup` component (imported by `Sidebar.tsx`)

- [ ] **Step 1: Create SettingsPopup.tsx**

```tsx
import { useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { Settings } from './Settings'

const STATUS_BAR_H = 50 // px — matches Sidebar bottom status bar height

export function SettingsPopup() {
  const ref = useRef<HTMLDivElement>(null)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSettings = useAppStore((s) => s.toggleSettings)

  // Click outside to close
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        toggleSettings()
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [toggleSettings])

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleSettings()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [toggleSettings])

  const expanded = !sidebarCollapsed

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className="settings-popup"
      style={{
        position: 'absolute',
        ...(expanded
          ? {
              bottom: STATUS_BAR_H,
              left: 0,
              width: '100%',
              maxHeight: `calc(100% - ${STATUS_BAR_H}px - 8px)`,
            }
          : {
              bottom: 0,
              left: '100%',
              width: 280,
              maxHeight: 400,
            }),
        zIndex: 50,
        background: '#0f1729',
        border: '1px solid #1e293b',
        borderRadius: 8,
        boxShadow: '0 -4px 20px rgba(0,0,0,0.5)',
        overflowY: 'auto',
        animation: 'settings-slide-in 150ms ease-out',
      }}
    >
      <Settings />
    </div>
  )
}
```

- [ ] **Step 2: Add slide-in animation to global CSS**

Open `frontend/src/index.css` and append the keyframes rule at the end:

```css
@keyframes settings-slide-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/Settings/SettingsPopup.tsx frontend/src/index.css
git commit -m "feat: create SettingsPopup floating component"
```

---

### Task 2: Adapt Settings.tsx for popup container

**Files:**
- Modify: `frontend/src/components/Settings/Settings.tsx:22`

**Interfaces:**
- No API changes — visual-only adjustment

- [ ] **Step 1: Update Settings.tsx outer div**

Change line 22 from:
```tsx
<div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
```

To:
```tsx
<div className="overflow-y-auto text-gray-900 dark:text-gray-100" style={{ background: '#0f1729' }}>
```

This removes `h-full` (popup container controls height) and unifies the background to match the popup.

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/Settings/Settings.tsx
git commit -m "fix: adapt Settings component for popup container"
```

---

### Task 3: Integrate SettingsPopup into Sidebar

**Files:**
- Modify: `frontend/src/components/Sidebar/Sidebar.tsx`

**Interfaces:**
- Consumes: `SettingsPopup` from `../Settings/SettingsPopup`
- Consumes: `settingsOpen` from `useAppStore`

- [ ] **Step 1: Add SettingsPopup import**

At the top of `Sidebar.tsx`, add after existing imports (line 8):
```tsx
import { SettingsPopup } from '../Settings/SettingsPopup'
```

Also add `settingsOpen` to the destructured store values (around line 13-25):
```tsx
const {
  // ... existing values ...
  settingsOpen,
  // ... rest ...
} = useAppStore()
```

- [ ] **Step 2: Render SettingsPopup in expanded sidebar**

In the expanded sidebar return block (line 223+), insert the popup between the content div and the bottom status bar. The content div currently ends at line 422 (`</div>`), and the status bar starts at line 424.

After the content `</div>` (line 422) and before the status bar `{/* Bottom status bar */}` (line 424), add:

```tsx
{/* Settings Popup */}
{settingsOpen && <SettingsPopup />}
```

- [ ] **Step 3: Render SettingsPopup in collapsed sidebar**

In the collapsed sidebar return block (line 178-220), insert the popup before the gear button. After the centered purple dot div (line 199) and before the gear button (line 201), add:

```tsx
{settingsOpen && <SettingsPopup />}
```

- [ ] **Step 4: Update collapsed gear button onClick**

Change line 202 from:
```tsx
onClick={() => { toggleSidebarCollapsed(); toggleSettings() }}
```

To:
```tsx
onClick={() => { toggleSettings() }}
```

The popup now floats out from the collapsed sidebar without expanding it.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Sidebar/Sidebar.tsx
git commit -m "feat: integrate SettingsPopup into Sidebar"
```

---

### Task 4: Remove Settings from Layout center pane

**Files:**
- Modify: `frontend/src/components/Layout/Layout.tsx`

**Interfaces:**
- Removes: `Settings` import (line 6)
- Removes: `settingsOpen` from destructured store (line 20)

- [ ] **Step 1: Remove Settings import**

Delete line 6:
```tsx
import { Settings } from '../Settings/Settings'
```

- [ ] **Step 2: Remove settingsOpen from store destructuring**

Delete `settingsOpen,` from the destructured `useAppStore()` call (line 20).

- [ ] **Step 3: Simplify center pane rendering**

Change lines 132-135 from:
```tsx
{/* Terminal or Settings — key forces full remount on session switch for clean WebSocket lifecycle */}
<div className="flex-1 min-w-0">
  {settingsOpen ? <Settings /> : <Terminal key={activeSessionId ?? 'empty'} />}
</div>
```

To:
```tsx
{/* Terminal — key forces full remount on session switch for clean WebSocket lifecycle */}
<div className="flex-1 min-w-0">
  <Terminal key={activeSessionId ?? 'empty'} />
</div>
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/Layout/Layout.tsx
git commit -m "feat: remove Settings from Layout center pane"
```

---

### Task 5: Visual verification

- [ ] **Step 1: Start dev server and verify**

```bash
cd /home/pax/coding/OmniTerm-dev
./dev.sh restart
```

- [ ] **Step 2: Test expanded sidebar popup**

1. Click gear button → popup appears above status bar
2. Click outside popup → popup closes
3. Click gear again → popup opens
4. Press Escape → popup closes
5. Terminal remains visible behind popup

- [ ] **Step 3: Test collapsed sidebar popup**

1. Collapse sidebar (◀ button)
2. Click gear → popup floats to right of 40px sidebar at 280px width
3. Click outside → popup closes
4. Sidebar stays collapsed (no expansion)

- [ ] **Step 4: Test drag resize**

1. Open popup in expanded sidebar
2. Drag sidebar wider/narrower → popup width follows
3. Popup content scrolls if height is constrained

- [ ] **Step 5: Test mobile unchanged**

1. Resize to mobile breakpoint
2. Settings tab in bottom nav still shows full-screen Settings

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: visual adjustments for settings popup"
```
