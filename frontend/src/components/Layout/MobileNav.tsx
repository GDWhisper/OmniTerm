import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'

const tabs = [
  { id: 'terminal' as const, labelKey: 'mobile.terminal', icon: '⌨️' },
  { id: 'files' as const, labelKey: 'mobile.files', icon: '📁' },
  { id: 'sessions' as const, labelKey: 'mobile.sessions', icon: '📋' },
  { id: 'settings' as const, labelKey: 'mobile.settings', icon: '⚙️' },
]

export function MobileNav() {
  const { t } = useTranslation()
  const { activeTab, setActiveTab } = useAppStore()

  return (
    <nav className="flex border-b" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-elevated)' }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className="flex-1 py-3 px-2 text-center text-sm transition-colors"
          style={activeTab === tab.id
            ? { color: 'var(--accent)', borderBottom: '2px solid var(--accent)', background: 'var(--accent-10)' }
            : { color: 'var(--text-muted)' }
          }
        >
          <span className="block text-lg">{tab.icon}</span>
          <span className="block mt-1">{t(tab.labelKey)}</span>
        </button>
      ))}
    </nav>
  )
}
