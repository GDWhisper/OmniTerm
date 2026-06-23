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
    <nav className="flex border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => setActiveTab(tab.id)}
          className={`flex-1 py-3 px-2 text-center text-sm transition-colors ${
            activeTab === tab.id
              ? 'text-blue-500 dark:text-blue-400 border-b-2 border-blue-500 dark:border-blue-400 bg-blue-50 dark:bg-gray-800/50'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
          }`}
        >
          <span className="block text-lg">{tab.icon}</span>
          <span className="block mt-1">{t(tab.labelKey)}</span>
        </button>
      ))}
    </nav>
  )
}
