import { useState, useCallback } from 'react'

const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

interface MobileKeyBarProps {
  onKey: (name: string) => void
  scrollMode: boolean
  onToggleScrollMode: () => void
}

const MOD_KEYS = ['Shift', 'Ctrl', 'Alt'] as const
const ROW1_ITEMS = ['Esc', 'Shift', 'Tab', 'PgUp', 'PgDn'] as const
const ROW2_ITEMS = ['Ctrl', 'Alt', 'Del', 'Home', 'End'] as const

export function MobileKeyBar({ onKey, scrollMode, onToggleScrollMode }: MobileKeyBarProps) {
  const [latchMod, setLatchMod] = useState<'shift' | 'ctrl' | 'alt' | null>(null)

  const handleClick = useCallback(
    (name: string) => {
      // Modifier keys toggle the latch
      if (MOD_KEYS.includes(name as any)) {
        const mod = name.toLowerCase() as 'shift' | 'ctrl' | 'alt'
        setLatchMod((prev) => (prev === mod ? null : mod))
        return
      }

      // Non-modifier key: send combo if a modifier is latched
      if (latchMod) {
        const mod = latchMod.charAt(0).toUpperCase() + latchMod.slice(1)
        onKey(`${mod}+${name}`)
        setLatchMod(null) // release latch after combo
      } else {
        onKey(name)
      }
    },
    [latchMod, onKey],
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

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '6px 8px',
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border-subtle)',
        fontFamily: FONT,
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      {/* Row 1: Esc Shift Tab PgUp PgDn  ·  ↑ 滚动 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {ROW1_ITEMS.map((k) => (
          <button
            key={k}
            onClick={() => handleClick(k)}
            onPointerDown={(e) => e.preventDefault()}
            style={isModKey(k) ? modBtnStyle(k) : keyButtonStyle}
          >
            {k}
          </button>
        ))}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button onClick={() => handleClick('↑')} onPointerDown={(e) => e.preventDefault()} style={keyButtonStyle}>↑</button>
          <button
            onClick={onToggleScrollMode}
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
        {ROW2_ITEMS.map((k) => (
          <button
            key={k}
            onClick={() => handleClick(k)}
            onPointerDown={(e) => e.preventDefault()}
            style={isModKey(k) ? modBtnStyle(k) : keyButtonStyle}
          >
            {k}
          </button>
        ))}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button onClick={() => handleClick('←')} onPointerDown={(e) => e.preventDefault()} style={keyButtonStyle}>←</button>
          <button onClick={() => handleClick('↓')} onPointerDown={(e) => e.preventDefault()} style={keyButtonStyle}>↓</button>
          <button onClick={() => handleClick('→')} onPointerDown={(e) => e.preventDefault()} style={keyButtonStyle}>→</button>
        </div>
      </div>
    </div>
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
  fontFamily: FONT,
  fontSize: 11,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}
