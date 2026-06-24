import { useTranslation } from 'react-i18next'
import { useThemeStore, type Theme } from '../../stores/themeStore'
import { useAppStore } from '../../stores/appStore'

const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

/* ── SVG icons (16×16, stroke-width 1.5, viewBox 0 0 24 24) ── */

function IconSun({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  )
}

function IconMoon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  )
}

function IconMonitor({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  )
}

const themes: { value: Theme; labelKey: string; Icon: React.FC<{ size?: number }> }[] = [
  { value: 'light', labelKey: 'settings.light', Icon: IconSun },
  { value: 'dark', labelKey: 'settings.dark', Icon: IconMoon },
  { value: 'system', labelKey: 'settings.system', Icon: IconMonitor },
]

const languages = [
  { value: 'zh', label: '中' },
  { value: 'en', label: 'En' },
]

/* ── Neon border button style helpers ── */

const btnBase: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--border-strong)',
  borderRadius: 6,
  transition: 'all 0.15s ease',
  fontFamily: FONT,
  cursor: 'pointer',
}

const btnActive: React.CSSProperties = {
  ...btnBase,
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  background: 'var(--accent-10)',
  boxShadow: 'var(--accent-glow-sm)',
}

function btnHover(e: React.MouseEvent) {
  const el = e.currentTarget as HTMLElement
  el.style.borderColor = 'var(--accent)'
  el.style.color = 'var(--accent)'
  el.style.background = 'var(--accent-10)'
}

function btnLeave(e: React.MouseEvent, isActive: boolean) {
  const el = e.currentTarget as HTMLElement
  if (isActive) {
    el.style.borderColor = 'var(--accent)'
    el.style.color = 'var(--accent)'
    el.style.background = 'var(--accent-10)'
    el.style.boxShadow = 'var(--accent-glow-sm)'
  } else {
    el.style.borderColor = 'var(--border-strong)'
    el.style.color = 'var(--text-muted)'
    el.style.background = 'transparent'
    el.style.boxShadow = 'none'
  }
}

export function Settings() {
  const { t, i18n } = useTranslation()
  const { theme, setTheme } = useThemeStore()
  const { fontSize, setFontSize } = useAppStore()

  return (
    <div style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', fontFamily: FONT }}>
      <div className="max-w-lg mx-auto p-4 space-y-6">
        <h2 style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 600 }}>{t('settings.title')}</h2>

        {/* Theme */}
        <section className="space-y-3">
          <h3 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>{t('settings.theme')}</h3>
          <div className="flex gap-2">
            {themes.map((th) => {
              const isActive = theme === th.value
              return (
                <button
                  key={th.value}
                  onClick={() => setTheme(th.value)}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 text-sm"
                  style={isActive ? btnActive : btnBase}
                  onMouseEnter={btnHover}
                  onMouseLeave={(e) => btnLeave(e, isActive)}
                >
                  <th.Icon size={16} />
                  <span>{t(th.labelKey)}</span>
                </button>
              )
            })}
          </div>
        </section>

        {/* Language */}
        <section className="space-y-3">
          <h3 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>{t('settings.language')}</h3>
          <div className="flex gap-2">
            {languages.map((lang) => {
              const isActive = i18n.language === lang.value || i18n.language.startsWith(lang.value)
              return (
                <button
                  key={lang.value}
                  onClick={() => i18n.changeLanguage(lang.value)}
                  className="flex-1 flex items-center justify-center px-3 py-2.5 text-sm"
                  style={{ ...(isActive ? btnActive : btnBase), fontSize: 12 }}
                  onMouseEnter={btnHover}
                  onMouseLeave={(e) => btnLeave(e, isActive)}
                >
                  {lang.label}
                </button>
              )
            })}
          </div>
        </section>

        {/* Font size */}
        <section className="space-y-3">
          <h3 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>
            {t('settings.fontSize')}
          </h3>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setFontSize(fontSize - 1)}
              disabled={fontSize <= 10}
              className="w-9 h-9 flex items-center justify-center text-lg"
              style={{
                ...btnBase,
                opacity: fontSize <= 10 ? 0.5 : 1,
                color: 'var(--text-muted)',
              }}
              onMouseEnter={btnHover}
              onMouseLeave={(e) => btnLeave(e, false)}
            >
              −
            </button>
            <div className="flex-1 text-center">
              <span style={{ fontSize: 24, fontFamily: FONT, fontWeight: 600, color: 'var(--text-primary)' }}>{fontSize}</span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 4 }}>px</span>
            </div>
            <button
              onClick={() => setFontSize(fontSize + 1)}
              disabled={fontSize >= 24}
              className="w-9 h-9 flex items-center justify-center text-lg"
              style={{
                ...btnBase,
                opacity: fontSize >= 24 ? 0.5 : 1,
                color: 'var(--text-muted)',
              }}
              onMouseEnter={btnHover}
              onMouseLeave={(e) => btnLeave(e, false)}
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
            style={{ accentColor: 'var(--accent)' }}
          />
        </section>

        {/* Info */}
        <section className="space-y-3">
          <h3 style={{ color: 'var(--text-muted)', fontSize: 12, fontWeight: 500 }}>{t('settings.about')}</h3>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }} className="space-y-1">
            <p>OmniTerm — Web-based tmux terminal manager</p>
            <p style={{ fontSize: 11, color: 'var(--text-faint)' }}>Phase 7 · MIT License</p>
          </div>
        </section>
      </div>
    </div>
  )
}
