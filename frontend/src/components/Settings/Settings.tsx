import { useTranslation } from 'react-i18next'
import { useThemeStore, type Theme } from '../../stores/themeStore'
import { useAppStore } from '../../stores/appStore'

const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

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
    <div style={{ background: '#111827', color: '#e2e8f0', fontFamily: FONT }}>
      <div className="max-w-lg mx-auto p-4 space-y-6">
        <h2 style={{ color: '#e2e8f0', fontSize: 14, fontWeight: 600 }}>{t('settings.title')}</h2>

        {/* Theme */}
        <section className="space-y-3">
          <h3 style={{ color: '#94a3b8', fontSize: 12, fontWeight: 500 }}>{t('settings.theme')}</h3>
          <div className="flex gap-2">
            {themes.map((th) => (
              <button
                key={th.value}
                onClick={() => setTheme(th.value)}
                className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-sm"
                style={{
                  borderRadius: 6,
                  transition: 'all 0.15s ease',
                  fontFamily: FONT,
                  ...(theme === th.value
                    ? {
                        background: '#a78bfa',
                        color: '#0a0a0f',
                        fontWeight: 600,
                        border: '1px solid #a78bfa',
                      }
                    : {
                        background: 'transparent',
                        color: '#cbd5e1',
                        border: '1px solid #334155',
                      }),
                }}
                onMouseEnter={(e) => {
                  if (theme !== th.value) {
                    e.currentTarget.style.borderColor = '#a78bfa'
                    e.currentTarget.style.color = '#a78bfa'
                    e.currentTarget.style.background = 'rgba(167,139,250,0.08)'
                  } else {
                    e.currentTarget.style.background = '#c4b5fd'
                    e.currentTarget.style.boxShadow = '0 0 10px rgba(167,139,250,0.4)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (theme !== th.value) {
                    e.currentTarget.style.borderColor = '#334155'
                    e.currentTarget.style.color = '#cbd5e1'
                    e.currentTarget.style.background = 'transparent'
                  } else {
                    e.currentTarget.style.background = '#a78bfa'
                    e.currentTarget.style.boxShadow = 'none'
                  }
                }}
              >
                <span>{th.icon}</span>
                <span>{t(th.labelKey)}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Language */}
        <section className="space-y-3">
          <h3 style={{ color: '#94a3b8', fontSize: 12, fontWeight: 500 }}>{t('settings.language')}</h3>
          <div className="flex gap-2">
            {languages.map((lang) => (
              <button
                key={lang.value}
                onClick={() => i18n.changeLanguage(lang.value)}
                className="flex-1 flex items-center justify-center px-3 py-2.5 text-sm"
                style={{
                  borderRadius: 6,
                  transition: 'all 0.15s ease',
                  fontFamily: FONT,
                  ...(i18n.language === lang.value || i18n.language.startsWith(lang.value)
                    ? {
                        background: '#a78bfa',
                        color: '#0a0a0f',
                        fontWeight: 600,
                        border: '1px solid #a78bfa',
                      }
                    : {
                        background: 'transparent',
                        color: '#cbd5e1',
                        border: '1px solid #334155',
                      }),
                }}
                onMouseEnter={(e) => {
                  const isActive = i18n.language === lang.value || i18n.language.startsWith(lang.value)
                  if (!isActive) {
                    e.currentTarget.style.borderColor = '#a78bfa'
                    e.currentTarget.style.color = '#a78bfa'
                    e.currentTarget.style.background = 'rgba(167,139,250,0.08)'
                  } else {
                    e.currentTarget.style.background = '#c4b5fd'
                    e.currentTarget.style.boxShadow = '0 0 10px rgba(167,139,250,0.4)'
                  }
                }}
                onMouseLeave={(e) => {
                  const isActive = i18n.language === lang.value || i18n.language.startsWith(lang.value)
                  if (!isActive) {
                    e.currentTarget.style.borderColor = '#334155'
                    e.currentTarget.style.color = '#cbd5e1'
                    e.currentTarget.style.background = 'transparent'
                  } else {
                    e.currentTarget.style.background = '#a78bfa'
                    e.currentTarget.style.boxShadow = 'none'
                  }
                }}
              >
                <span>{lang.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Font size */}
        <section className="space-y-3">
          <h3 style={{ color: '#94a3b8', fontSize: 12, fontWeight: 500 }}>
            {t('settings.fontSize')}
          </h3>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= 10}
              className="w-9 h-9 flex items-center justify-center text-lg"
              style={{
                borderRadius: 6,
                transition: 'all 0.15s ease',
                fontFamily: FONT,
                background: 'transparent',
                color: '#cbd5e1',
                border: '1px solid #334155',
                opacity: fontSize <= 10 ? 0.5 : 1,
              }}
              onMouseEnter={(e) => {
                if (fontSize > 10) {
                  e.currentTarget.style.borderColor = '#a78bfa'
                  e.currentTarget.style.color = '#a78bfa'
                  e.currentTarget.style.background = 'rgba(167,139,250,0.08)'
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '#334155'
                e.currentTarget.style.color = '#cbd5e1'
                e.currentTarget.style.background = 'transparent'
              }}
            >
              −
            </button>
            <div className="flex-1 text-center">
              <span style={{ fontSize: 24, fontFamily: FONT, fontWeight: 600, color: '#e2e8f0' }}>{fontSize}</span>
              <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 4 }}>px</span>
            </div>
            <button
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= 24}
              className="w-9 h-9 flex items-center justify-center text-lg"
              style={{
                borderRadius: 6,
                transition: 'all 0.15s ease',
                fontFamily: FONT,
                background: 'transparent',
                color: '#cbd5e1',
                border: '1px solid #334155',
                opacity: fontSize >= 24 ? 0.5 : 1,
              }}
              onMouseEnter={(e) => {
                if (fontSize < 24) {
                  e.currentTarget.style.borderColor = '#a78bfa'
                  e.currentTarget.style.color = '#a78bfa'
                  e.currentTarget.style.background = 'rgba(167,139,250,0.08)'
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = '#334155'
                e.currentTarget.style.color = '#cbd5e1'
                e.currentTarget.style.background = 'transparent'
              }}
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
            className="w-full"
            style={{ accentColor: '#a78bfa' }}
          />
        </section>

        {/* Info */}
        <section className="space-y-3">
          <h3 style={{ color: '#94a3b8', fontSize: 12, fontWeight: 500 }}>{t('settings.about')}</h3>
          <div style={{ fontSize: 12, color: '#94a3b8' }} className="space-y-1">
            <p>OmniTerm — Web-based tmux terminal manager</p>
            <p style={{ fontSize: 11, color: '#64748b' }}>Phase 7 · MIT License</p>
          </div>
        </section>
      </div>
    </div>
  )
}
