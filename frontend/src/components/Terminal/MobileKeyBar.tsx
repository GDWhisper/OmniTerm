const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

interface MobileKeyBarProps {
  onKey: (name: string) => void
  scrollMode: boolean
  onToggleScrollMode: () => void
}

const funcKeys = ['Ctrl', 'Esc', 'Tab', '复制', '粘贴']

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
      {/* Row 1: function keys + ↑ + 滚动 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {funcKeys.map((k) => (
          <button key={k} onClick={() => onKey(k)} style={keyButtonStyle}>{k}</button>
        ))}
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          <button onClick={() => onKey('↑')} style={keyButtonStyle}>↑</button>
          <button
            onClick={onToggleScrollMode}
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
      {/* Row 2: ← ↓ → (keyboard T-shape, ↓ centered under ↑) */}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <div style={{ display: 'flex', gap: 6, marginRight: 46 }}>
          <button onClick={() => onKey('←')} style={keyButtonStyle}>←</button>
          <button onClick={() => onKey('↓')} style={keyButtonStyle}>↓</button>
          <button onClick={() => onKey('→')} style={keyButtonStyle}>→</button>
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
