import { useCallback } from 'react'
import { READER_FONT } from '../../utils/fonts'

interface MobileKeyBarProps {
  latchMod: string | null
  onSetLatchMod: (mod: string | null) => void
  onKey: (name: string) => void
  scrollMode: boolean
  onToggleScrollMode: () => void
}

const MOD_KEYS = ['Shift', 'Ctrl', 'Alt'] as const
const ROW1_ITEMS = ['Esc', 'Shift', 'Tab', 'PgUp', 'PgDn'] as const
const ROW2_ITEMS = ['Ctrl', 'Alt', 'Del', 'Home', 'End'] as const

export function MobileKeyBar({ latchMod, onSetLatchMod, onKey, scrollMode, onToggleScrollMode }: MobileKeyBarProps) {
  // After any button tap, drop focus from whatever element is now active so
  // the soft keyboard doesn't pop. On mobile, tapping a <button> moves focus
  // to the button itself (activeElement === button, NOT the textarea), so we
  // must blur the *button* — otherwise when it later loses focus, focus falls
  // back to xterm's textarea and the IME keyboard opens.
  // Skip blur when a modifier is latched (user tapped Ctrl/Shift/Alt to keep
  // the keyboard up for typing the next key).
  const maybeBlurAfterTap = useCallback(() => {
    if (latchMod) return
    setTimeout(() => {
      const ae = document.activeElement
      if (ae instanceof HTMLElement &&
          (ae.tagName === 'TEXTAREA' || ae.classList.contains('mobikey-btn'))) {
        ae.blur()
      }
    }, 0)
  }, [latchMod])

  const handleClick = useCallback(
    (name: string) => {
      // Modifier keys toggle the latch
      if ((MOD_KEYS as readonly string[]).includes(name)) {
        const mod = name.toLowerCase() as 'shift' | 'ctrl' | 'alt'
        onSetLatchMod(latchMod === mod ? null : mod)
      } else if (latchMod) {
        const mod = latchMod.charAt(0).toUpperCase() + latchMod.slice(1)
        onKey(`${mod}+${name}`)
        onSetLatchMod(null)
      } else {
        onKey(name)
      }
      maybeBlurAfterTap()
    },
    [latchMod, onKey, maybeBlurAfterTap, onSetLatchMod],
  )

  const modBtnStyle = (mod: string): React.CSSProperties => {
    const active = latchMod === mod.toLowerCase()
    return {
      ...keyButtonStyle,
      color: active ? 'var(--accent)' : 'var(--text-secondary)',
      background: active ? 'rgba(167,139,250,0.12)' : 'var(--bg-surface)',
      borderColor: active ? 'var(--accent)' : 'var(--border-strong)',
    }
  }

  const isModKey = (name: string) => (MOD_KEYS as readonly string[]).includes(name)

  // Common props so every key button behaves the same: never focusable
  // (tabIndex -1), and swallow the default focus/selection that mobile
  // browsers trigger on press — this is what keeps the soft keyboard closed
  // when tapping arrows / function keys.
  const mobiBtnProps = {
    type: 'button' as const,
    tabIndex: -1,
    className: 'mobikey-btn',
    onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
  }

  const renderBtn = (k: string) => (
    <button
      key={k}
      {...mobiBtnProps}
      onClick={() => handleClick(k)}
      style={isModKey(k) ? modBtnStyle(k) : keyButtonStyle}
    >
      {k}
    </button>
  )

  return (
    <>
      <style>{`
        .mobikey-btn {
          -webkit-tap-highlight-color: transparent;
          user-select: none;
          touch-action: manipulation;
        }
        .mobikey-btn:active {
          transform: scale(0.93);
          filter: brightness(1.35);
        }
      `}</style>
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '6px 8px',
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border-subtle)',
        fontFamily: READER_FONT,
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      {/* Row 1: Esc Shift Tab PgUp PgDn  ·  ↑ 滚动 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {ROW1_ITEMS.map(renderBtn)}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button {...mobiBtnProps} key="arrow-up" onClick={() => handleClick('↑')} style={keyButtonStyle}>↑</button>
          <button
            {...mobiBtnProps}
            key="scroll"
            onClick={() => { onToggleScrollMode(); maybeBlurAfterTap() }}
            style={{
              ...keyButtonStyle,
              color: scrollMode ? 'var(--accent)' : 'var(--text-muted)',
              background: scrollMode ? 'rgba(167,139,250,0.10)' : 'var(--bg-surface)',
            }}
          >
            滚动
          </button>
        </div>
      </div>
      {/* Row 2: Ctrl Alt Del Home End  ·  ← ↓ → */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {ROW2_ITEMS.map(renderBtn)}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button {...mobiBtnProps} key="arrow-left" onClick={() => handleClick('←')} style={keyButtonStyle}>←</button>
          <button {...mobiBtnProps} key="arrow-down" onClick={() => handleClick('↓')} style={keyButtonStyle}>↓</button>
          <button {...mobiBtnProps} key="arrow-right" onClick={() => handleClick('→')} style={keyButtonStyle}>→</button>
        </div>
      </div>
    </div>
    </>
  )
}

const keyButtonStyle: React.CSSProperties = {
  minWidth: 40,
  minHeight: 32,
  padding: '0 8px',
  borderRadius: 5,
  border: '1px solid var(--border-strong)',
  background: 'var(--bg-surface)',
  color: 'var(--text-secondary)',
  fontFamily: READER_FONT,
  fontSize: 11,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'transform 0.08s ease, filter 0.08s ease',
}
