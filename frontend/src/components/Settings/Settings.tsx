import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useThemeStore, type Theme } from '../../stores/themeStore'
import { useAppStore } from '../../stores/appStore'
import { canFullscreen } from '../../hooks/useImmersive'

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

/* ── Section heading (used by every section) ── */

const sectionTitleStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  void t
  return <h3 style={sectionTitleStyle}>{children}</h3>
}

/* ── Reusable toggle row (label + ON/OFF button + hint) ── */

interface ToggleRowProps {
  labelKey: string
  hintKey: string
  value: boolean
  onToggle: () => void
}

function ToggleRow({ labelKey, hintKey, value, onToggle }: ToggleRowProps) {
  const { t } = useTranslation()
  return (
    <section className="space-y-2">
      <SectionTitle>{t(labelKey)}</SectionTitle>
      <button
        onClick={onToggle}
        style={{
          ...btnBase,
          fontSize: 12,
          padding: '5px 8px',
          display: 'flex', alignItems: 'center', gap: 6,
          ...(value ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-10)' } : {}),
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: value ? 'var(--success)' : 'var(--text-dim)',
          transition: 'background 0.15s ease',
        }} />
        {value ? 'ON' : 'OFF'}
      </button>
      <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t(hintKey)}</p>
    </section>
  )
}

/* ── Individual section components ── */

function ThemeSection() {
  const { t } = useTranslation()
  const { theme, setTheme } = useThemeStore()
  return (
    <section className="space-y-2">
      <SectionTitle>{t('settings.theme')}</SectionTitle>
      <div className="flex gap-1.5">
        {themes.map((th) => {
          const isActive = theme === th.value
          return (
            <button
              key={th.value}
              onClick={() => setTheme(th.value)}
              className="flex-1 flex items-center justify-center gap-1.5"
              style={{ ...(isActive ? btnActive : btnBase), fontSize: 12, padding: '5px 8px' }}
              onMouseEnter={btnHover}
              onMouseLeave={(e) => btnLeave(e, isActive)}
            >
              <th.Icon size={14} />
              <span>{t(th.labelKey)}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function FontSizeSection() {
  const { t } = useTranslation()
  const { fontSize, mobileFontSize, isMobile, setFontSize, setMobileFontSize } = useAppStore()
  const effectiveFontSize = isMobile ? mobileFontSize : fontSize
  const setEffectiveFontSize = isMobile ? setMobileFontSize : setFontSize
  return (
    <section className="space-y-2">
      <SectionTitle>{t('settings.fontSize')}</SectionTitle>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setEffectiveFontSize(effectiveFontSize - 1)}
          disabled={effectiveFontSize <= 10}
          style={{
            ...btnBase,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            opacity: effectiveFontSize <= 10 ? 0.5 : 1,
            color: 'var(--text-muted)',
          }}
          onMouseEnter={btnHover}
          onMouseLeave={(e) => btnLeave(e, false)}
        >
          −
        </button>
        <div className="flex-1 text-center">
          <span style={{ fontSize: 18, fontFamily: FONT, fontWeight: 600, color: 'var(--text-primary)' }}>{effectiveFontSize}</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 3 }}>px</span>
        </div>
        <button
          onClick={() => setEffectiveFontSize(effectiveFontSize + 1)}
          disabled={effectiveFontSize >= 24}
          style={{
            ...btnBase,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            opacity: effectiveFontSize >= 24 ? 0.5 : 1,
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
        value={effectiveFontSize}
        onChange={(e) => setEffectiveFontSize(Number(e.target.value))}
        className="w-full"
        style={{ accentColor: 'var(--accent)', height: 4 }}
      />
    </section>
  )
}

function LanguageSection() {
  const { t, i18n } = useTranslation()
  return (
    <section className="space-y-2">
      <SectionTitle>{t('settings.language')}</SectionTitle>
      <div className="flex gap-1.5">
        {languages.map((lang) => {
          const isActive = i18n.language === lang.value || i18n.language.startsWith(lang.value)
          return (
            <button
              key={lang.value}
              onClick={() => i18n.changeLanguage(lang.value)}
              className="flex-1 flex items-center justify-center"
              style={{ ...(isActive ? btnActive : btnBase), fontSize: 12, padding: '5px 8px' }}
              onMouseEnter={btnHover}
              onMouseLeave={(e) => btnLeave(e, isActive)}
            >
              {lang.label}
            </button>
          )
        })}
      </div>
    </section>
  )
}

function AutoCopySection() {
  const autoCopySelect = useAppStore((s) => s.autoCopySelect)
  const setAutoCopySelect = useAppStore((s) => s.setAutoCopySelect)
  return <ToggleRow labelKey="settings.autoCopySelect" hintKey="settings.autoCopySelectHint" value={autoCopySelect} onToggle={() => setAutoCopySelect(!autoCopySelect)} />
}

function AnimationsSection() {
  const pixelAnimationsEnabled = useAppStore((s) => s.pixelAnimationsEnabled)
  const setPixelAnimationsEnabled = useAppStore((s) => s.setPixelAnimationsEnabled)
  return <ToggleRow labelKey="settings.pixelAnimations" hintKey="settings.pixelAnimationsHint" value={pixelAnimationsEnabled} onToggle={() => setPixelAnimationsEnabled(!pixelAnimationsEnabled)} />
}

function SoundSection() {
  const soundEnabled = useAppStore((s) => s.soundEnabled)
  const setSoundEnabled = useAppStore((s) => s.setSoundEnabled)
  return <ToggleRow labelKey="settings.sound" hintKey="settings.soundHint" value={soundEnabled} onToggle={() => setSoundEnabled(!soundEnabled)} />
}

function CrtSection() {
  const crtScanlines = useAppStore((s) => s.crtScanlines)
  const setCrtScanlines = useAppStore((s) => s.setCrtScanlines)
  return <ToggleRow labelKey="settings.crtScanlines" hintKey="settings.crtScanlinesHint" value={crtScanlines} onToggle={() => setCrtScanlines(!crtScanlines)} />
}

function PixelUiSection() {
  const pixelUiEnabled = useAppStore((s) => s.pixelUiEnabled)
  const setPixelUiEnabled = useAppStore((s) => s.setPixelUiEnabled)
  return <ToggleRow labelKey="settings.pixelUi" hintKey="settings.pixelUiHint" value={pixelUiEnabled} onToggle={() => setPixelUiEnabled(!pixelUiEnabled)} />
}

function PixelFontSection() {
  const pixelFontEnabled = useAppStore((s) => s.pixelFontEnabled)
  const setPixelFontEnabled = useAppStore((s) => s.setPixelFontEnabled)
  return <ToggleRow labelKey="settings.pixelFont" hintKey="settings.pixelFontHint" value={pixelFontEnabled} onToggle={() => setPixelFontEnabled(!pixelFontEnabled)} />
}

function ParchmentSection() {
  const parchmentTextureEnabled = useAppStore((s) => s.parchmentTextureEnabled)
  const setParchmentTextureEnabled = useAppStore((s) => s.setParchmentTextureEnabled)
  return <ToggleRow labelKey="settings.parchmentTexture" hintKey="settings.parchmentTextureHint" value={parchmentTextureEnabled} onToggle={() => setParchmentTextureEnabled(!parchmentTextureEnabled)} />
}

function TransitionsSection() {
  const transitionsEnabled = useAppStore((s) => s.transitionsEnabled)
  const setTransitionsEnabled = useAppStore((s) => s.setTransitionsEnabled)
  return <ToggleRow labelKey="settings.transitions" hintKey="settings.transitionsHint" value={transitionsEnabled} onToggle={() => setTransitionsEnabled(!transitionsEnabled)} />
}

function MobileGestureSection() {
  const mobileGestureEnabled = useAppStore((s) => s.mobileGestureEnabled)
  const setMobileGestureEnabled = useAppStore((s) => s.setMobileGestureEnabled)
  return <ToggleRow labelKey="settings.mobileGesture" hintKey="settings.mobileGestureHint" value={mobileGestureEnabled} onToggle={() => setMobileGestureEnabled(!mobileGestureEnabled)} />
}

function ImmersiveSection() {
  const immersiveMode = useAppStore((s) => s.immersiveMode)
  const setImmersiveMode = useAppStore((s) => s.setImmersiveMode)
  // Only render if Fullscreen API is supported (mirrors the original guard).
  if (!canFullscreen()) return null
  return <ToggleRow labelKey="settings.immersiveMode" hintKey="settings.immersiveModeHint" value={immersiveMode} onToggle={() => setImmersiveMode(!immersiveMode)} />
}

function AboutSection() {
  const { t } = useTranslation()
  return (
    <section className="space-y-2">
      <SectionTitle>{t('settings.about')}</SectionTitle>
      <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
        <p>{t('settings.slogan')}</p>
      </div>
    </section>
  )
}

/* ── Category config: which sections appear in which tab ── */

type SectionComponent = React.FC
type CategoryId = 'appearance' | 'audio' | 'edit' | 'language' | 'mobile'

interface Category {
  id: CategoryId
  labelKey: string
  sections: SectionComponent[]
  /** When true, the tab is only shown on mobile viewports. */
  mobileOnly?: boolean
}

const CATEGORIES: Category[] = [
  {
    id: 'appearance',
    labelKey: 'settings.category.appearance',
    sections: [ThemeSection, FontSizeSection, CrtSection, AnimationsSection, PixelUiSection, PixelFontSection, ParchmentSection, AboutSection],
  },
  {
    id: 'audio',
    labelKey: 'settings.category.audio',
    sections: [SoundSection],
  },
  {
    id: 'edit',
    labelKey: 'settings.category.edit',
    sections: [AutoCopySection, TransitionsSection],
  },
  {
    id: 'language',
    labelKey: 'settings.category.language',
    sections: [LanguageSection],
  },
  {
    id: 'mobile',
    labelKey: 'settings.category.mobile',
    sections: [MobileGestureSection, ImmersiveSection],
    mobileOnly: true,
  },
]

/* ── Main component: game-style tabbed settings panel ── */

export function Settings() {
  const { t } = useTranslation()
  const isMobile = useAppStore((s) => s.isMobile)
  const [activeId, setActiveId] = useState<CategoryId>('appearance')

  const visibleCategories = CATEGORIES.filter((c) => !c.mobileOnly || isMobile)
  // Defensive: if the previously active tab is hidden (e.g. switched to desktop), fall back to first.
  const activeCategory = visibleCategories.find((c) => c.id === activeId) ?? visibleCategories[0]

  return (
    <div className="settings-layout">
      <nav className="settings-tabs" aria-label={t('settings.title')}>
        {visibleCategories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            className={`settings-tab${activeCategory.id === cat.id ? ' active' : ''}`}
            onClick={() => setActiveId(cat.id)}
            aria-current={activeCategory.id === cat.id ? 'page' : undefined}
          >
            {t(cat.labelKey)}
          </button>
        ))}
      </nav>
      <div className="settings-content">
        {activeCategory.sections.map((Section, i) => (
          <Section key={i} />
        ))}
      </div>
    </div>
  )
}
