# Keybinding Mode & Copy-on-Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a modern keybinding mode toggle in Settings and enable auto-copy-on-select for the terminal.

**Architecture:** A `keybindingMode` state in appStore controls whether `attachCustomKeyEventHandler` intercepts modern shortcuts and translates them to tmux prefix sequences. A separate `mouseup` listener on the terminal container triggers clipboard copy when text is selected. Both features are purely frontend — no backend changes.

**Tech Stack:** React, Zustand, xterm.js (`attachCustomKeyEventHandler`, `getSelection`, `onSelectionChange`), Clipboard API

## Global Constraints

- All UI text must use `useTranslation()` i18n keys — no hardcoded strings
- State persistence uses `localStorage` (consistent with `fontSize`, `sidebarWidth`)
- No new npm dependencies
- Style must follow existing Settings.tsx pattern (CSS variables, btnBase/btnActive/btnHover/btnLeave)

---

### Task 1: Add `keybindingMode` to appStore

**Files:**
- Modify: `frontend/src/stores/appStore.ts:14-72` (interface + initial state + setter)

**Interfaces:**
- Produces: `keybindingMode: 'tmux' | 'modern'` state, `setKeybindingMode(mode)` setter — consumed by Task 2 and Task 3

- [ ] **Step 1: Add type and state to appStore**

In `frontend/src/stores/appStore.ts`, add to the `AppState` interface after `fontSize: number` (line 24):

```typescript
  // Keybinding
  keybindingMode: 'tmux' | 'modern'
```

Add to the actions section after `setFontSize`:

```typescript
  setKeybindingMode: (mode: 'tmux' | 'modern') => void
```

Add to the initial state after `fontSize` (line 81):

```typescript
  keybindingMode: (localStorage.getItem('omniterm_keybinding_mode') as 'tmux' | 'modern') || 'tmux',
```

Add to the actions after `setFontSize` (around line 111):

```typescript
  setKeybindingMode: (mode) => {
    localStorage.setItem('omniterm_keybinding_mode', mode)
    set({ keybindingMode: mode })
  },
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/stores/appStore.ts
git commit -m "feat: add keybindingMode state to appStore"
```

---

### Task 2: Add modern keybinding interception to useTerminal

**Files:**
- Modify: `frontend/src/hooks/useTerminal.ts:46-213` (useTerminal hook)

**Interfaces:**
- Consumes: `keybindingMode` from appStore (Task 1)
- Produces: modern keybindings work when mode is 'modern', no-op when 'tmux'

**Keybinding map (6 shortcuts):**

| Shortcut | tmux sequence | Description |
|----------|--------------|-------------|
| Ctrl+Shift+D | `\x02%` | Horizontal split |
| Ctrl+Shift+S | `\x02"` | Vertical split |
| Ctrl+Alt+Arrow | `\x02<arrow>` | Switch pane |
| Ctrl+Shift+Q | `\x02c` | New window |
| Ctrl+Shift+X | `\x02x` | Close pane |
| Ctrl+Shift+1-9 | `\x02<n>` | Switch window |

Note: `\x02` is the byte for `Ctrl+B` (tmux default prefix).

- [ ] **Step 1: Add import for useAppStore keybindingMode**

In `frontend/src/hooks/useTerminal.ts`, the import for `useAppStore` already exists on line 6. Add a selector read for `keybindingMode` inside the `useTerminal` function, after line 48 (`const resolved = ...`):

```typescript
  const keybindingMode = useAppStore((s) => s.keybindingMode)
```

- [ ] **Step 2: Add attachCustomKeyEventHandler in connectWs**

In `frontend/src/hooks/useTerminal.ts`, inside the `connectWs` callback, after the `onResize` listener (after line 138), add the keybinding interceptor. Note: we capture `keybindingMode` from the store at call time so the handler reflects the current mode.

```typescript
    // Modern keybinding interception
    listenerDisposablesRef.current.push(
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        // Only intercept in modern mode
        const mode = useAppStore.getState().keybindingMode
        if (mode !== 'modern') return true

        const ctrl = ev.ctrlKey
        const shift = ev.shiftKey
        const alt = ev.altKey
        const key = ev.key

        // Ctrl+Shift+D → horizontal split
        if (ctrl && shift && !alt && key === 'D') {
          ws.send(new TextEncoder().encode('\x02%'))
          return false
        }
        // Ctrl+Shift+S → vertical split
        if (ctrl && shift && !alt && key === 'S') {
          ws.send(new TextEncoder().encode('\x02"'))
          return false
        }
        // Ctrl+Shift+Q → new window
        if (ctrl && shift && !alt && key === 'Q') {
          ws.send(new TextEncoder().encode('\x02c'))
          return false
        }
        // Ctrl+Shift+X → close pane
        if (ctrl && shift && !alt && key === 'X') {
          ws.send(new TextEncoder().encode('\x02x'))
          return false
        }
        // Ctrl+Shift+1-9 → switch window
        if (ctrl && shift && !alt && key >= '1' && key <= '9') {
          ws.send(new TextEncoder().encode('\x02' + key))
          return false
        }
        // Ctrl+Alt+Arrow → switch pane
        if (ctrl && !shift && alt && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
          const arrowMap: Record<string, string> = {
            ArrowUp: '\x02\x1b[A',
            ArrowDown: '\x02\x1b[B',
            ArrowRight: '\x02\x1b[C',
            ArrowLeft: '\x02\x1b[D',
          }
          ws.send(new TextEncoder().encode(arrowMap[key]))
          return false
        }

        return true // not intercepted — let xterm handle normally
      })
    )
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useTerminal.ts
git commit -m "feat: add modern keybinding interception via attachCustomKeyEventHandler"
```

---

### Task 3: Add copy-on-select to useTerminal

**Files:**
- Modify: `frontend/src/hooks/useTerminal.ts:164-213` (createTerminal function)

**Interfaces:**
- Produces: auto-copy to clipboard on mouse select — no consumers, standalone feature

- [ ] **Step 1: Add mouseup listener for auto-copy**

In `frontend/src/hooks/useTerminal.ts`, inside the `createTerminal` callback, after the ResizeObserver setup (after line 209, before `setTerminalReady(true)`), add:

```typescript
    // Auto-copy selected text to clipboard on mouse select
    const handleMouseUp = () => {
      const selection = term.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {
          // Clipboard API may fail without user gesture or in insecure contexts
        })
      }
    }
    container.addEventListener('mouseup', handleMouseUp)
```

- [ ] **Step 2: Clean up the mouseup listener on dispose**

In the `disposeTerminal` callback, add cleanup before the terminal disposal. Add after `observerRef.current = null` (line 146):

```typescript
    // mouseup cleanup is handled by container removal — no explicit removeEventListener needed
```

Actually, we need to store the handler and container ref to properly clean up. Let me revise: store the handler in a ref so disposeTerminal can remove it.

Add a new ref near the other refs (after line 56):

```typescript
  const mouseUpHandlerRef = useRef<(() => void) | null>(null)
```

In `createTerminal`, store the handler ref:

```typescript
    mouseUpHandlerRef.current = handleMouseUp
```

In `disposeTerminal`, add cleanup (after `observerRef.current = null`, line 146):

```typescript
    if (mouseUpHandlerRef.current && containerRef.current) {
      containerRef.current.removeEventListener('mouseup', mouseUpHandlerRef.current)
      mouseUpHandlerRef.current = null
    }
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add frontend/src/hooks/useTerminal.ts
git commit -m "feat: auto-copy terminal selection to clipboard on mouseup"
```

---

### Task 4: Add keyboard mode toggle to Settings UI

**Files:**
- Modify: `frontend/src/components/Settings/Settings.tsx:1-204`
- Modify: `frontend/src/locales/en/translation.json:31-38`
- Modify: `frontend/src/locales/zh/translation.json:31-38`

**Interfaces:**
- Consumes: `keybindingMode`, `setKeybindingMode` from appStore (Task 1)
- Produces: i18n keys `settings.keybinding`, `settings.keybindingTmux`, `settings.keybindingModern`, `settings.keybindingHint`

- [ ] **Step 1: Add i18n translations (English)**

In `frontend/src/locales/en/translation.json`, add after line 38 (`"settings.about": "About"`):

```json
  "settings.keybinding": "Keyboard Shortcuts",
  "settings.keybindingTmux": "tmux Native",
  "settings.keybindingModern": "Modern",
  "settings.keybindingHint": "Modern mode: Ctrl+Shift+D/S split, Ctrl+Shift+Q new window, Ctrl+Shift+X close, Ctrl+Alt+Arrow switch pane, Ctrl+Shift+1-9 switch window",
```

- [ ] **Step 2: Add i18n translations (Chinese)**

In `frontend/src/locales/zh/translation.json`, add after line 38 (`"settings.about": "关于"`):

```json
  "settings.keybinding": "快捷键模式",
  "settings.keybindingTmux": "tmux 原生",
  "settings.keybindingModern": "现代化",
  "settings.keybindingHint": "现代化模式：Ctrl+Shift+D/S 分屏，Ctrl+Shift+Q 新建窗口，Ctrl+Shift+X 关闭，Ctrl+Alt+方向键 切换窗格，Ctrl+Shift+1-9 切换窗口",
```

- [ ] **Step 3: Add keybinding section to Settings.tsx**

In `frontend/src/components/Settings/Settings.tsx`, add the import for `useAppStore` at the top (line 3):

```typescript
import { useAppStore } from '../../stores/appStore'
```

Add the keybinding mode options array after the `languages` array (after line 45):

```typescript
const keybindingModes = [
  { value: 'tmux' as const, labelKey: 'settings.keybindingTmux' },
  { value: 'modern' as const, labelKey: 'settings.keybindingModern' },
]
```

In the `Settings` component, add the store hook after line 91 (`const { fontSize, setFontSize } = ...`):

```typescript
  const { keybindingMode, setKeybindingMode } = useAppStore()
```

Add the keybinding section after the Font size section (after line 191, before the Info section):

```tsx
        {/* Keybinding Mode */}
        <section className="space-y-3">
          <h3 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>{t('settings.keybinding')}</h3>
          <div className="flex gap-2">
            {keybindingModes.map((kb) => {
              const isActive = keybindingMode === kb.value
              return (
                <button
                  key={kb.value}
                  onClick={() => setKeybindingMode(kb.value)}
                  className="flex-1 flex items-center justify-center px-3 py-2.5 text-sm"
                  style={{ ...(isActive ? btnActive : btnBase), fontSize: 12 }}
                  onMouseEnter={btnHover}
                  onMouseLeave={(e) => btnLeave(e, isActive)}
                >
                  {t(kb.labelKey)}
                </button>
              )
            })}
          </div>
          {keybindingMode === 'modern' && (
            <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
              {t('settings.keybindingHint')}
            </p>
          )}
        </section>
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /home/pax/coding/OmniTerm-dev/frontend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Verify dev server starts and Settings page renders**

Run: `cd /home/pax/coding/OmniTerm-dev && ./dev.sh start`
Then open `http://localhost:9778`, navigate to Settings, verify the keybinding toggle appears.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Settings/Settings.tsx frontend/src/locales/en/translation.json frontend/src/locales/zh/translation.json
git commit -m "feat: add keyboard mode toggle to Settings page"
```

---

### Task 5: End-to-end manual testing

- [ ] **Step 1: Test copy-on-select**

1. Open a terminal session
2. Type some text (e.g., `echo hello world`)
3. Mouse-drag to select "hello world"
4. Release mouse button
5. Paste in another app → verify "hello world" is in clipboard

- [ ] **Step 2: Test tmux native mode (default)**

1. Verify keybinding mode is "tmux Native" in Settings
2. In terminal, press `Ctrl+B %` → verify horizontal split occurs
3. Press `Ctrl+B "` → verify vertical split occurs
4. Verify `Ctrl+Shift+D` does NOT trigger split (passes through as normal terminal input)

- [ ] **Step 3: Test modern mode**

1. Go to Settings, switch to "Modern" keybinding mode
2. In terminal, press `Ctrl+Shift+D` → verify horizontal split occurs
3. Press `Ctrl+Shift+S` → verify vertical split occurs
4. Press `Ctrl+Shift+Q` → verify new window is created
5. Press `Ctrl+Alt+Arrow` → verify pane switching works
6. Press `Ctrl+Shift+1` → verify switch to window 1
7. Press `Ctrl+Shift+X` → verify pane closes
8. Verify `Ctrl+B %` still works (tmux native commands are not blocked in modern mode — they pass through normally)

- [ ] **Step 4: Test mode persistence**

1. Switch to Modern mode
2. Refresh the page
3. Go to Settings → verify Modern mode is still selected
4. Verify modern shortcuts still work in terminal

- [ ] **Step 5: Commit final state (if any fixes needed)**

```bash
git add -A
git commit -m "fix: adjustments from manual testing"
```
