const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

interface MobileKeyBarProps {
  onKey: (name: string) => void
  scrollMode: boolean
  onToggleScrollMode: () => void
}

const keys = [
  ['Ctrl', 'Esc', 'Tab', '滚动', '复制', '粘贴'],
  ['←', '→', '↑', '↓'],
]

export function MobileKeyBar({ onKey, scrollMode, onToggleScrollMode }: MobileKeyBarProps) {
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
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        {keys[0].map((k) => {
          const isScroll = k === '滚动'
          return (
            <button
              key={k}
              onClick={isScroll ? onToggleScrollMode : () => onKey(k)}
              style={{
                ...keyButtonStyle,
                ...(isScroll ? {
                  color: scrollMode ? 'var(--accent)' : 'var(--text-muted)',
                  background: scrollMode ? 'rgba(167,139,250,0.10)' : 'var(--bg-surface)',
                } : {}),
              }}
            >
              {k}
            </button>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
        {keys[1].map((k) => (
          <button key={k} onClick={() => onKey(k)} style={keyButtonStyle}>{k}</button>
        ))}
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
