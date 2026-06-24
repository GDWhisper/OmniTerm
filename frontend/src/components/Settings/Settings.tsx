import { useTranslation } from 'react-i18next'
import { useThemeStore, type Theme } from '../../stores/themeStore'
import { useAppStore } from '../../stores/appStore'

const themes: { value: Theme; labelKey: string; icon: string }[] = [
  { value: 'light', labelKey: 'settings.light', icon: '☀️' },
  { value: 'dark', labelKey: 'settings.dark', icon: '🌙' },
  { value: 'system', labelKey: 'settings.system', icon: '💻' },
]

const languages = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

export function Settings() {
  const { t, i18n } = useTranslation()
  const { theme, setTheme } = useThemeStore()
  const { fontSize, setFontSize } = useAppStore()

  return (
    <div className="text-gray-900 dark:text-gray-100" style={{ background: '#0f1729' }}>
      <div className="max-w-lg mx-auto p-4 space-y-6">
        <h2 className="text-lg font-semibold">{t('settings.title')}</h2>

        {/* Theme */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('settings.theme')}</h3>
          <div className="flex gap-2">
            {themes.map((th) => (
              <button
                key={th.value}
                onClick={() => setTheme(th.value)}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  theme === th.value
                    ? 'bg-blue-500 text-white shadow-sm'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700'
                }`}
              >
                <span>{th.icon}</span>
                <span>{t(th.labelKey)}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Language */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('settings.language')}</h3>
          <div className="flex gap-2">
            {languages.map((lang) => (
              <button
                key={lang.value}
                onClick={() => i18n.changeLanguage(lang.value)}
                className={`flex-1 flex items-center justify-center px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  i18n.language === lang.value || i18n.language.startsWith(lang.value)
                    ? 'bg-blue-500 text-white shadow-sm'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700'
                }`}
              >
                <span>{lang.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Font size */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
            {t('settings.fontSize')}
          </h3>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= 10}
              className="w-9 h-9 flex items-center justify-center rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 transition-colors text-lg"
            >
              −
            </button>
            <div className="flex-1 text-center">
              <span className="text-2xl font-mono font-semibold">{fontSize}</span>
              <span className="text-xs text-gray-400 ml-1">px</span>
            </div>
            <button
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= 24}
              className="w-9 h-9 flex items-center justify-center rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 transition-colors text-lg"
            >
              +
            </button>
          </div>
          <input
            type="range"
            min={10}
            max={24}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
        </section>

        {/* Info */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">{t('settings.about')}</h3>
          <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
            <p>OmniTerm — Web-based tmux terminal manager</p>
            <p className="text-xs">Phase 7 · MIT License</p>
          </div>
        </section>
      </div>
    </div>
  )
}
