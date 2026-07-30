import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { READER_FONT } from '../../utils/fonts'
import { hapticTap } from '../../utils/haptics'

interface MobileKeyBarProps {
  latchMod: string | null
  onSetLatchMod: (mod: string | null) => void
  onKey: (name: string) => void
  scrollMode: boolean
  onToggleScrollMode: () => void
  /** Refocus the xterm textarea so the soft keyboard stays open.
   *  Called after toggling a modifier latch (Ctrl/Shift/Alt) so the
   *  user can immediately type a combo key via the soft keyboard/IME. */
  refocusTextarea?: () => void
}

const MOD_KEYS = ['Shift', 'Ctrl', 'Alt'] as const
const ROW1_ITEMS = ['Esc', '^C', 'Shift', 'Tab', 'PgUp', 'PgDn'] as const
const ROW2_ITEMS = ['Ctrl', 'Alt', 'Del', 'Home', 'End'] as const
/** Keys that never combine with a latched modifier — sent as-is. */
const LATCH_BYPASS_KEYS = new Set<string>(['Enter', '^C'])

export function MobileKeyBar({ latchMod, onSetLatchMod, onKey, scrollMode, onToggleScrollMode, refocusTextarea }: MobileKeyBarProps) {
  const { t } = useTranslation()
  const handleClick = useCallback(
    (name: string) => {
      hapticTap()
      // Modifier keys toggle the latch and refocus the xterm textarea so
      // the soft keyboard stays open for the subsequent character (e.g.
      // Ctrl+C typed via IME).
      if ((MOD_KEYS as readonly string[]).includes(name)) {
        const mod = name.toLowerCase() as 'shift' | 'ctrl' | 'alt'
        onSetLatchMod(latchMod === mod ? null : mod)
        refocusTextarea?.()
      } else if (LATCH_BYPASS_KEYS.has(name)) {
        if (latchMod) onSetLatchMod(null)
        onKey(name)
      } else if (latchMod) {
        const mod = latchMod.charAt(0).toUpperCase() + latchMod.slice(1)
        onKey(`${mod}+${name}`)
        onSetLatchMod(null)
      } else {
        onKey(name)
      }
    },
    [latchMod, onKey, onSetLatchMod, refocusTextarea],
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

  // Common props for all key buttons: type='button' prevents accidental
  // form submission; className enables the active-scale animation.
  // Tab-able by default so tapping a non-modifier key naturally moves
  // focus away from the xterm textarea — the browser hides the soft
  // keyboard without any programmatic fighting.
  const mobiBtnProps = {
    type: 'button' as const,
    className: 'mobikey-btn',
  }

  const renderBtn = (k: string, fluid = false) => (
    <button
      key={k}
      {...mobiBtnProps}
      onClick={() => handleClick(k)}
      style={{
        ...(isModKey(k) ? modBtnStyle(k) : keyButtonStyle),
        ...(fluid ? { flex: 1, minWidth: 0 } : {}),
      }}
    >
      {k}
    </button>
  )

  return (
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
      {/* Row 1: Esc ^C Shift Tab PgUp PgDn  ·  ↑ 滚动 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 0 }}>
          {ROW1_ITEMS.map((k) => renderBtn(k, true))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
          <button {...mobiBtnProps} key="arrow-up" onClick={() => handleClick('↑')} style={clusterKeyStyle}>↑</button>
          <button
            {...mobiBtnProps}
            key="scroll"
            onClick={() => { onToggleScrollMode() }}
            style={{
              ...clusterKeyStyle,
              minWidth: 52,
              color: scrollMode ? 'var(--accent)' : 'var(--text-muted)',
              background: scrollMode ? 'rgba(167,139,250,0.10)' : 'var(--bg-surface)',
            }}
          >
            {t('terminal.keyScroll')}
          </button>
        </div>
      </div>
      {/* Row 2: Ctrl Alt Del Home End  ·  ← ↓ → ⏎ */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 0 }}>
          {ROW2_ITEMS.map((k) => renderBtn(k, true))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
          <button {...mobiBtnProps} key="arrow-left" onClick={() => handleClick('←')} style={clusterKeyStyle}>←</button>
          <button {...mobiBtnProps} key="arrow-down" onClick={() => handleClick('↓')} style={clusterKeyStyle}>↓</button>
          <button {...mobiBtnProps} key="arrow-right" onClick={() => handleClick('→')} style={clusterKeyStyle}>→</button>
          <button {...mobiBtnProps} key="enter" onClick={() => handleClick('Enter')} style={clusterKeyStyle}>⏎</button>
        </div>
      </div>
    </div>
  )
}

const keyButtonStyle: React.CSSProperties = {
  minWidth: 36,
  minHeight: 36,
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

const clusterKeyStyle: React.CSSProperties = {
  ...keyButtonStyle,
  flexShrink: 0,
}
