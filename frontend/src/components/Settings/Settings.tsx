import { useThemeStore, type Theme } from '../../stores/themeStore'
import { useAppStore } from '../../stores/appStore'

const themes: { value: Theme; label: string; icon: string }[] = [
  { value: 'light', label: '亮色', icon: '☀️' },
  { value: 'dark', label: '暗色', icon: '🌙' },
  { value: 'system', label: '跟随系统', icon: '💻' },
]

export function Settings() {
  const { theme, setTheme } = useThemeStore()
  const { fontSize, setFontSize } = useAppStore()

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      <div className="max-w-lg mx-auto p-4 space-y-6">
        <h2 className="text-lg font-semibold">设置</h2>

        {/* Theme */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">主题</h3>
          <div className="flex gap-2">
            {themes.map((t) => (
              <button
                key={t.value}
                onClick={() => setTheme(t.value)}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  theme === t.value
                    ? 'bg-blue-500 text-white shadow-sm'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-200 dark:border-gray-700'
                }`}
              >
                <span>{t.icon}</span>
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Font size */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">
            终端字体大小
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
          <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400">关于</h3>
          <div className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
            <p>OmniTerm — Web-based tmux terminal manager</p>
            <p className="text-xs">Phase 7 · MIT License</p>
          </div>
        </section>
      </div>
    </div>
  )
}
