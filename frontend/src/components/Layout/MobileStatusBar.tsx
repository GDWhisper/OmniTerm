import { useTranslation } from 'react-i18next'

interface MobileStatusBarProps {
  connected: boolean
  sessionName: string
  onSessionClick: () => void
  onNewSession: () => void
}

const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

export function MobileStatusBar({ connected, sessionName, onSessionClick, onNewSession }: MobileStatusBarProps) {
  const { t } = useTranslation()

  return (
    <div
      style={{
        height: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px',
        background: 'var(--bg-base)',
        borderBottom: '1px solid var(--border-subtle)',
        fontFamily: FONT,
        fontSize: 11,
        flexShrink: 0,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)' }}>
        <span style={{ color: connected ? 'var(--success)' : 'var(--danger)', fontSize: 10 }}>●</span>
        {connected ? t('sidebar.connected') : t('sidebar.disconnected')}
      </span>
      <button
        onClick={onSessionClick}
        style={{
          flex: 1,
          margin: '0 12px',
          textAlign: 'center',
          color: 'var(--text-primary)',
          fontWeight: 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          background: 'transparent',
          border: 'none',
          padding: 0,
        }}
      >
        {sessionName}
      </button>
      <button
        onClick={onNewSession}
        style={{
          color: 'var(--accent)',
          background: 'transparent',
          border: 'none',
          fontSize: 18,
          lineHeight: 1,
          padding: '4px 6px',
        }}
        aria-label={t('sidebar.createSession')}
      >
        +
      </button>
    </div>
  )
}
