import { useAppStore } from '../../stores/appStore'
import { IconSessions, IconTerminal, IconFiles } from '../Icons/MobileIcons'

const tabs = [
  { id: 'sessions' as const, Icon: IconSessions },
  { id: 'terminal' as const, Icon: IconTerminal },
  { id: 'files' as const, Icon: IconFiles },
]

export function MobileNav() {
  const { activeTab, setActiveTab } = useAppStore()

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        padding: '6px 0',
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border-subtle)',
        flexShrink: 0,
      }}
    >
      <nav
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 40,
          padding: '5px 32px',
          borderRadius: 20,
          background: 'var(--bg-base)',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                background: isActive ? 'rgba(167,139,250,0.10)' : 'transparent',
                border: 'none',
                borderRadius: 6,
                transition: 'all 0.15s ease',
              }}
              aria-label={tab.id}
            >
              <tab.Icon width={18} height={18} />
            </button>
          )
        })}
      </nav>
    </div>
  )
}
