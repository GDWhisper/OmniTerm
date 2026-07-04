import { useCallback, useRef } from 'react'
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
  // Track whether xterm.js textarea was focused before the touch started.
  // On mobile, touchstart fires before the browser shifts focus to the button,
  // so `document.activeElement` still reflects the pre-tap state.
  const textareaWasFocusedRef = useRef(false)

  // Record pre-tap focus state. touchstart fires before the browser shifts
  // focus, so document.activeElement reflects the state before this tap.
  const handleTouchStart = useCallback(() => {
    textareaWasFocusedRef.current = document.activeElement instanceof HTMLTextAreaElement
  }, [])

  // After any button action, blur the textarea if it wasn't focused before
  // the tap (prevents IME keyboard from opening). If it was focused (user
  // was typing), leave it alone. Also skip blur when a modifier is latched
  // (user tapped Ctrl/Shift/Alt to use with keyboard input next).
  const maybeBlurAfterTap = useCallback(() => {
    if (textareaWasFocusedRef.current || latchMod) return
    setTimeout(() => {
      const ae = document.activeElement
      if (ae instanceof HTMLTextAreaElement) ae.blur()
    }, 0)
  }, [latchMod])

  const handleClick = useCallback(
    (name: string) => {
      // Modifier keys toggle the latch
      if (MOD_KEYS.includes(name as any)) {
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

  const isModKey = (name: string) => MOD_KEYS.includes(name as any)

  const renderBtn = (k: string) => (
    <button
      key={k}
      className="mobikey-btn"
      tabIndex={-1}
      onTouchStart={handleTouchStart}
      onClick={() => handleClick(k)}
      onPointerDown={(e) => e.preventDefault()}
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
          <button className="mobikey-btn" tabIndex={-1} onTouchStart={handleTouchStart} onClick={() => handleClick('↑')} onPointerDown={(e) => e.preventDefault()} style={keyButtonStyle}>↑</button>
          <button
            className="mobikey-btn"
            tabIndex={-1}
            onTouchStart={handleTouchStart}
            onClick={() => { onToggleScrollMode(); maybeBlurAfterTap() }}
            onPointerDown={(e) => e.preventDefault()}
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
          <button className="mobikey-btn" tabIndex={-1} onTouchStart={handleTouchStart} onClick={() => handleClick('←')} onPointerDown={(e) => e.preventDefault()} style={keyButtonStyle}>←</button>
          <button className="mobikey-btn" tabIndex={-1} onTouchStart={handleTouchStart} onClick={() => handleClick('↓')} onPointerDown={(e) => e.preventDefault()} style={keyButtonStyle}>↓</button>
          <button className="mobikey-btn" tabIndex={-1} onTouchStart={handleTouchStart} onClick={() => handleClick('→')} onPointerDown={(e) => e.preventDefault()} style={keyButtonStyle}>→</button>
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
