import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useThemeStore, type Theme } from '../../stores/themeStore'
import { useAppStore, DEFAULT_UI_ZOOM, MIN_DISCONNECT_MIN, MAX_DISCONNECT_MIN, PERM_TIMEOUT_NEVER_SECS, PERM_TIMEOUT_STEP_SECS, MAX_PERM_TIMEOUT_SECS, clampPermTimeoutSecs } from '../../stores/appStore'
import { TERMINAL_ENGINES, terminalEngineLabel } from '../../utils/terminalEngine'
import { permTimeoutDuration } from '../../utils/permTimeout'
import { BetaBadge } from '../Common/BetaBadge'
import { api } from '../../api/client'
import type { PermissionTimeoutMode } from '../../api/client'
import { canFullscreen } from '../../hooks/useImmersive'
import { READER_FONT } from '../../utils/fonts'
import { AgentSettings } from './AgentSettings'
import { AuthSection } from './AuthSection'
import { AuditLogSection } from './AuditLogSection'
import { OverlayScroll } from '../Common/OverlayScroll'
import { SectionTitle, ToggleRow } from './toggleRow'
import { btnBase } from './settingsStyles'

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

/** 权限请求超时行为模式选项（顺序即面板展示顺序；abort 为默认安全策略）。 */
const PERM_TIMEOUT_MODES: { value: PermissionTimeoutMode; labelKey: string; hintKey: string }[] = [
  { value: 'wait', labelKey: 'settings.permTimeoutWait', hintKey: 'settings.permTimeoutWaitHint' },
  { value: 'auto', labelKey: 'settings.permTimeoutAuto', hintKey: 'settings.permTimeoutAutoHint' },
  { value: 'abort', labelKey: 'settings.permTimeoutAbort', hintKey: 'settings.permTimeoutAbortHint' },
]

/** Minutes above which an over-long disconnect/recycle timeout is flagged. */
const WARNING_THRESHOLD_MIN = 30

/* ── Disconnect / recycle timeout slider (minutes) ── */

interface DisconnectSliderProps {
  titleKey: string
  hintKey: string
  warningKey: string
  value: number
  onChange: (n: number) => void
  /** Optional fire-and-forget side effect (e.g. persisting to the backend). */
  onCommit?: (n: number) => void
  /** 警告触发线（严格大于 `warnAboveMin` 才显示）。缺省回退
   *  `WARNING_THRESHOLD_MIN`（>= 即警告，适配默认值远低于 30 的滑块）。 */
  warnAboveMin?: number
  /** 档位下限 / 上限 / 步进，缺省 1..60 步进 1（分钟制滑块）。权限超时滑块走
   *  秒制档位（30 秒粒度、上限 1 小时、最左档 `min=0` 即「总是」）。 */
  min?: number
  max?: number
  step?: number
  /** 大号数值的展示；缺省 `值 + settings.minutesUnit`。权限超时滑块的「秒」档与
   *  「总是」档文案各不相同，传入自定义渲染（口径与告知消息共用 `utils/permTimeout.ts`）。 */
  renderValue?: (value: number) => React.ReactNode
}

function DisconnectSlider({ titleKey, hintKey, warningKey, value, onChange, onCommit, warnAboveMin, min = MIN_DISCONNECT_MIN, max = MAX_DISCONNECT_MIN, step = 1, renderValue }: DisconnectSliderProps) {
  const { t } = useTranslation()
  const warn =
    warnAboveMin === undefined ? value >= WARNING_THRESHOLD_MIN : value > warnAboveMin
  return (
    <section className="space-y-2">
      <SectionTitle>{t(titleKey)}</SectionTitle>
      {renderValue ? (
        renderValue(value)
      ) : (
        <div className="flex items-baseline gap-1">
          <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{value}</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('settings.minutesUnit')}</span>
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value)
          onChange(n)
          onCommit?.(n)
        }}
        className="w-full"
      />
      <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t(hintKey)}</p>
      {warn && (
        <p style={{ fontSize: 11, color: 'var(--warning)', lineHeight: 1.5 }}>{t(warningKey)}</p>
      )}
    </section>
  )
}

/* ── Neon border button style helpers ── */

const btnActive: React.CSSProperties = {
  ...btnBase,
  borderColor: 'var(--accent)',
  color: 'var(--accent)',
  background: 'var(--accent-10)',
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
  } else {
    el.style.borderColor = 'var(--border-strong)'
    el.style.color = 'var(--text-muted)'
    el.style.background = 'transparent'
  }
}

/* ── Section heading (used by every section) ── */

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
          <span style={{ fontSize: 18, fontFamily: READER_FONT, fontWeight: 600, color: 'var(--text-primary)' }}>{effectiveFontSize}</span>
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
      />
    </section>
  )
}

function UiZoomSection() {
  const { t } = useTranslation()
  const { uiZoom, setUiZoom } = useAppStore()
  return (
    <section className="space-y-2">
      <SectionTitle>{t('settings.uiZoom')}</SectionTitle>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setUiZoom(uiZoom - 10)}
          disabled={uiZoom <= 50}
          style={{
            ...btnBase,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            opacity: uiZoom <= 50 ? 0.5 : 1,
            color: 'var(--text-muted)',
          }}
          onMouseEnter={btnHover}
          onMouseLeave={(e) => btnLeave(e, false)}
        >
          −
        </button>
        <div className="flex-1 text-center">
          <span style={{ fontSize: 18, fontFamily: READER_FONT, fontWeight: 600, color: 'var(--text-primary)' }}>{uiZoom}</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 3 }}>%</span>
        </div>
        <button
          onClick={() => setUiZoom(uiZoom + 10)}
          disabled={uiZoom >= 200}
          style={{
            ...btnBase,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            opacity: uiZoom >= 200 ? 0.5 : 1,
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
        min={50}
        max={200}
        step={10}
        value={uiZoom}
        onChange={(e) => setUiZoom(Number(e.target.value))}
        className="w-full"
      />
      {uiZoom !== DEFAULT_UI_ZOOM && (
        <button
          onClick={() => setUiZoom(DEFAULT_UI_ZOOM)}
          style={{ ...btnBase, fontSize: 11, padding: '3px 10px', color: 'var(--text-muted)' }}
          onMouseEnter={btnHover}
          onMouseLeave={(e) => btnLeave(e, false)}
        >
          {t('settings.uiZoomReset')}
        </button>
      )}
    </section>
  )
}

function ChatFontSizeSection() {
  const { t } = useTranslation()
  const { chatFontSize, setChatFontSize } = useAppStore()
  return (
    <section className="space-y-2">
      <SectionTitle>{t('settings.chatFontSize')}</SectionTitle>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setChatFontSize(chatFontSize - 1)}
          disabled={chatFontSize <= 10}
          style={{
            ...btnBase,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            opacity: chatFontSize <= 10 ? 0.5 : 1,
            color: 'var(--text-muted)',
          }}
          onMouseEnter={btnHover}
          onMouseLeave={(e) => btnLeave(e, false)}
        >
          −
        </button>
        <div className="flex-1 text-center">
          <span style={{ fontSize: 18, fontFamily: READER_FONT, fontWeight: 600, color: 'var(--text-primary)' }}>{chatFontSize}</span>
          <span style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 3 }}>px</span>
        </div>
        <button
          onClick={() => setChatFontSize(chatFontSize + 1)}
          disabled={chatFontSize >= 20}
          style={{
            ...btnBase,
            width: 28,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 14,
            opacity: chatFontSize >= 20 ? 0.5 : 1,
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
        max={20}
        value={chatFontSize}
        onChange={(e) => setChatFontSize(Number(e.target.value))}
        className="w-full"
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

/**
 * 默认终端引擎。与创建会话弹窗的初始高亮、「在此打开终端」共用同一个值
 * （`appStore.defaultTerminalEngine`，单一真源见 `utils/terminalEngine.ts`）；
 * 弹窗内显式点选也会写回这里，因此不再叠第二层「上次使用」优先级。
 * pty 仍在 beta 期，选项带角标；宿主探测无复用器时 tmux 选项不可选并说明原因。
 */
function DefaultEngineSection() {
  const { t } = useTranslation()
  const defaultTerminalEngine = useAppStore((s) => s.defaultTerminalEngine)
  const setDefaultTerminalEngine = useAppStore((s) => s.setDefaultTerminalEngine)
  const multiplexerAvailable = useAppStore((s) => s.multiplexerAvailable)
  const multiplexer = useAppStore((s) => s.multiplexer)

  return (
    <section className="space-y-2">
      <SectionTitle>{t('settings.defaultEngine')}</SectionTitle>
      <div className="flex gap-1.5">
        {TERMINAL_ENGINES.map((engine) => {
          const isActive = defaultTerminalEngine === engine
          const disabled = engine === 'tmux' && !multiplexerAvailable
          return (
            <button
              key={engine}
              type="button"
              disabled={disabled}
              onClick={() => setDefaultTerminalEngine(engine)}
              className="flex-1 flex items-center justify-center"
              style={{
                ...(isActive ? btnActive : btnBase),
                fontSize: 12,
                padding: '5px 8px',
                ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
              }}
              onMouseEnter={disabled ? undefined : btnHover}
              onMouseLeave={disabled ? undefined : (e) => btnLeave(e, isActive)}
            >
              {terminalEngineLabel(engine, t)}
              {engine === 'pty' && <>&nbsp;<BetaBadge /></>}
            </button>
          )
        })}
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
        {t('settings.defaultEngineHint')}
      </p>
      {!multiplexerAvailable && (
        <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          {t('sidebar.muxUnavailable', { mux: multiplexer })}
        </p>
      )}
    </section>
  )
}

function AutoCopySection() {
  const autoCopySelect = useAppStore((s) => s.autoCopySelect)
  const setAutoCopySelect = useAppStore((s) => s.setAutoCopySelect)
  return <ToggleRow labelKey="settings.autoCopySelect" hintKey="settings.autoCopySelectHint" value={autoCopySelect} onToggle={() => setAutoCopySelect(!autoCopySelect)} />
}

function TmuxMouseSection() {
  const { t } = useTranslation()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const sendDataRef = useRef(useAppStore.getState().terminalSendData)

  // Keep ref in sync with the store
  useEffect(() => {
    return useAppStore.subscribe((s) => { sendDataRef.current = s.terminalSendData })
  }, [])

  // Fetch current mouse option on mount
  useEffect(() => {
    api.tmuxGetMouse().then((r) => setEnabled(r.enabled)).catch(() => setEnabled(false))
  }, [])

  const handleToggle = async () => {
    const next = !enabled
    setEnabled(next)
    try {
      await api.tmuxSetMouse(next)
      // Force the connected tmux client to re-read the option immediately
      sendDataRef.current?.(`\x02:set -g mouse ${next ? 'on' : 'off'}\n`)
    } catch {
      setEnabled(!next) // revert on failure
    }
  }

  if (enabled === null) return null // still loading

  return (
    <section className="space-y-2">
      <SectionTitle>{t('settings.tmuxMouse')}</SectionTitle>
      <button
        onClick={handleToggle}
        style={{
          ...btnBase,
          fontSize: 12,
          padding: '5px 8px',
          display: 'flex', alignItems: 'center', gap: 6,
          ...(enabled ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-10)' } : {}),
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: enabled ? 'var(--success)' : 'var(--text-dim)',
          transition: 'background 0.15s ease',
        }} />
        {enabled ? t('settings.on') : t('settings.off')}
      </button>
      <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t('settings.tmuxMouseHint')}</p>
    </section>
  )
}

function AnimationsSection() {
  const pixelAnimationsEnabled = useAppStore((s) => s.pixelAnimationsEnabled)
  const setPixelAnimationsEnabled = useAppStore((s) => s.setPixelAnimationsEnabled)
  return <ToggleRow labelKey="settings.pixelAnimations" hintKey="settings.pixelAnimationsHint" value={pixelAnimationsEnabled} onToggle={() => setPixelAnimationsEnabled(!pixelAnimationsEnabled)} badge />
}

function SoundSection() {
  const { t } = useTranslation()
  const soundEnabled = useAppStore((s) => s.soundEnabled)
  const setSoundEnabled = useAppStore((s) => s.setSoundEnabled)
  const soundCoinEnabled = useAppStore((s) => s.soundCoinEnabled)
  const setSoundCoinEnabled = useAppStore((s) => s.setSoundCoinEnabled)
  const soundStompEnabled = useAppStore((s) => s.soundStompEnabled)
  const setSoundStompEnabled = useAppStore((s) => s.setSoundStompEnabled)
  const soundPingEnabled = useAppStore((s) => s.soundPingEnabled)
  const setSoundPingEnabled = useAppStore((s) => s.setSoundPingEnabled)

  const previewCoin = () => import('../../utils/audioFeedback').then(m => m.play8BitSound('coin', true))
  const previewStomp = () => import('../../utils/audioFeedback').then(m => m.play8BitSound('stomp', true))
  const previewPing = () => import('../../utils/audioFeedback').then(m => m.playPing(true))

  const subDisabled = !soundEnabled

  return (
    <section className="space-y-4">
      <div className="space-y-2">
        <SectionTitle>{t('settings.sound.master')}</SectionTitle>
        <button
          onClick={() => setSoundEnabled(!soundEnabled)}
          style={{
            ...btnBase,
            fontSize: 12,
            padding: '5px 8px',
            display: 'flex', alignItems: 'center', gap: 6,
            ...(soundEnabled ? { border: '1px solid var(--accent)', color: 'var(--accent)', background: 'var(--accent-10)' } : {}),
          }}
        >
          <span style={{
            width: 8, height: 8, borderRadius: '50%',
            background: soundEnabled ? 'var(--success)' : 'var(--text-dim)',
            transition: 'background 0.15s ease',
          }} />
          {soundEnabled ? t('settings.on') : t('settings.off')}
        </button>
        <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t('settings.sound.masterHint')}</p>
      </div>

      <div style={{ opacity: subDisabled ? 0.45 : 1, transition: 'opacity 0.2s ease', pointerEvents: subDisabled ? 'none' : 'auto' }}>
        <SoundItem
          labelKey="settings.sound.coin"
          hintKey="settings.sound.coinHint"
          value={soundCoinEnabled}
          onToggle={() => setSoundCoinEnabled(!soundCoinEnabled)}
          onPreview={previewCoin}
        />
        <div style={{ height: 16 }} />
        <SoundItem
          labelKey="settings.sound.stomp"
          hintKey="settings.sound.stompHint"
          value={soundStompEnabled}
          onToggle={() => setSoundStompEnabled(!soundStompEnabled)}
          onPreview={previewStomp}
        />
        <div style={{ height: 16 }} />
        <SoundItem
          labelKey="settings.sound.ping"
          hintKey="settings.sound.pingHint"
          value={soundPingEnabled}
          onToggle={() => setSoundPingEnabled(!soundPingEnabled)}
          onPreview={previewPing}
        />
      </div>
    </section>
  )
}

interface SoundItemProps {
  labelKey: string
  hintKey: string
  value: boolean
  onToggle: () => void
  onPreview: () => void
}

function SoundItem({ labelKey, hintKey, value, onToggle, onPreview }: SoundItemProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <button
            onClick={onToggle}
            style={{
              ...btnBase,
              fontSize: 12,
              padding: '5px 8px',
              display: 'flex', alignItems: 'center', gap: 6,
              width: '100%',
              ...(value ? { border: '1px solid var(--accent)', color: 'var(--accent)', background: 'var(--accent-10)' } : {}),
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: value ? 'var(--success)' : 'var(--text-dim)',
              transition: 'background 0.15s ease',
            }} />
            {t(labelKey)}
          </button>
        </div>
        <button
          type="button"
          className="btn-pixel btn-pixel-accent"
          style={{ padding: '3px 10px', fontSize: 12, letterSpacing: 'var(--pixel-tracking-sm)' }}
          onClick={(e) => { e.stopPropagation(); onPreview() }}
        >
          ▶
        </button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t(hintKey)}</p>
    </div>
  )
}

/** 会话内容展示：聊天面板里默认展开什么。 */
function SessionDisplaySection() {
  const expandThinking = useAppStore(s => s.expandThinking)
  const expandToolCalls = useAppStore(s => s.expandToolCalls)
  const setExpandThinking = useAppStore(s => s.setExpandThinking)
  const setExpandToolCalls = useAppStore(s => s.setExpandToolCalls)

  return (
    <>
      <ToggleRow
        labelKey="settings.expandThinking"
        hintKey="settings.expandThinkingHint"
        value={expandThinking}
        onToggle={() => setExpandThinking(!expandThinking)}
      />
      <ToggleRow
        labelKey="settings.expandToolCalls"
        hintKey="settings.expandToolCallsHint"
        value={expandToolCalls}
        onToggle={() => setExpandToolCalls(!expandToolCalls)}
      />
    </>
  )
}

/** 超时断开与回收（ACP 空闲回收 / 终端失焦 / 终端空闲）。 */
function SessionTimeoutSection() {
  const acpIdleRecycleMin = useAppStore(s => s.acpIdleRecycleMin)
  const setAcpIdleRecycleMin = useAppStore(s => s.setAcpIdleRecycleMin)
  const blurDisconnectMin = useAppStore(s => s.blurDisconnectMin)
  const setBlurDisconnectMin = useAppStore(s => s.setBlurDisconnectMin)
  const idleDisconnectMin = useAppStore(s => s.idleDisconnectMin)
  const setIdleDisconnectMin = useAppStore(s => s.setIdleDisconnectMin)

  return (
    <>
      <DisconnectSlider
        titleKey="settings.acpIdleRecycle"
        hintKey="settings.acpIdleRecycleHint"
        warningKey="settings.acpIdleRecycleWarning"
        value={acpIdleRecycleMin}
        onChange={setAcpIdleRecycleMin}
        onCommit={(n) => {
          api.setAcpIdleRecycle(n).catch(() => {})
        }}
      />
      <DisconnectSlider
        titleKey="settings.tmuxBlurDisconnect"
        hintKey="settings.tmuxBlurDisconnectHint"
        warningKey="settings.tmuxDisconnectWarning"
        value={blurDisconnectMin}
        onChange={setBlurDisconnectMin}
      />
      <DisconnectSlider
        titleKey="settings.tmuxIdleDisconnect"
        hintKey="settings.tmuxIdleDisconnectHint"
        warningKey="settings.tmuxDisconnectWarning"
        value={idleDisconnectMin}
        onChange={setIdleDisconnectMin}
      />
    </>
  )
}

/** 权限超时时长档位文案：「总是」/「30 秒」/「30 分钟」——口径与聊天里的超时
 *  告知消息共用 `utils/permTimeout.ts`（整分钟报分钟，其余报秒），面板与聊天
 *  不会各说各话。 */
function permTimeoutValueLabel(secs: number, t: (key: string, opts?: Record<string, unknown>) => string) {
  const d = permTimeoutDuration(secs)
  return d ? t(d.key, { value: d.value }) : t('settings.permTimeoutAlways')
}

function PermissionTimeoutSection() {
  const { t } = useTranslation()
  const mode = useAppStore((s) => s.permTimeoutMode)
  const secs = useAppStore((s) => s.permTimeoutSecs)
  const active = PERM_TIMEOUT_MODES.find((m) => m.value === mode) ?? PERM_TIMEOUT_MODES[2]

  // 「总是」档只对自动推进有意义（有请求即自动放行，不等待）：auto 模式露出最左
  // 档，abort/wait 从 30 秒起——从 auto（0）切到 abort 时把越界值夹回最近的可用档。
  const minSecs = mode === 'auto' ? PERM_TIMEOUT_NEVER_SECS : PERM_TIMEOUT_STEP_SECS

  // 模式与时长同一设置：任一侧改动都整体 PUT（后端白名单校验 + 热更新）。
  const commit = (nextMode: PermissionTimeoutMode, nextSecs: number) => {
    useAppStore.getState().setPermTimeoutMode(nextMode)
    useAppStore.getState().setPermTimeoutSecs(nextSecs)
    api.setPermissionTimeout(nextMode, nextSecs).catch(() => {})
  }

  return (
    <>
      <section className="space-y-2">
        <SectionTitle>{t('settings.permTimeout')}</SectionTitle>
        <div className="flex gap-1.5">
          {PERM_TIMEOUT_MODES.map((m) => {
            const isActive = m.value === mode
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => {
                  // 「总是」档只在 auto 下有语义：从 auto 切走时把时长夹回最近的可用档
                  // （滑块下限同步抬到 30 秒，避免面板显示一个拖不到的值）。
                  const floor = m.value === 'auto' ? PERM_TIMEOUT_NEVER_SECS : PERM_TIMEOUT_STEP_SECS
                  commit(m.value, clampPermTimeoutSecs(Math.max(secs, floor)))
                }}
                className="flex-1 flex items-center justify-center"
                style={{ ...(isActive ? btnActive : btnBase), fontSize: 12, padding: '5px 8px' }}
                onMouseEnter={btnHover}
                onMouseLeave={(e) => btnLeave(e, isActive)}
              >
                {t(m.labelKey)}
              </button>
            )
          })}
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t(active.hintKey)}</p>
        {mode === 'auto' && (
          <p style={{ fontSize: 11, color: 'var(--warning)', lineHeight: 1.5 }}>
            {t('settings.permTimeoutAutoWarning')}
          </p>
        )}
      </section>
      {mode !== 'wait' && (
        <DisconnectSlider
          titleKey="settings.permTimeoutDuration"
          hintKey="settings.permTimeoutDurationHint"
          warningKey="settings.permTimeoutDurationWarning"
          value={secs}
          min={minSecs}
          max={MAX_PERM_TIMEOUT_SECS}
          step={PERM_TIMEOUT_STEP_SECS}
          renderValue={(v) => (
            <span style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>
              {permTimeoutValueLabel(v, t)}
            </span>
          )}
          onChange={(n) => useAppStore.getState().setPermTimeoutSecs(n)}
          onCommit={(n) => commit(mode, n)}
          // 默认 30 分钟即历史行为，只有调得比默认更长才提醒内存驻留。
          warnAboveMin={WARNING_THRESHOLD_MIN * 60}
        />
      )}
    </>
  )
}

function CrtSection() {
  const crtScanlines = useAppStore((s) => s.crtScanlines)
  const setCrtScanlines = useAppStore((s) => s.setCrtScanlines)
  return <ToggleRow labelKey="settings.crtScanlines" hintKey="settings.crtScanlinesHint" value={crtScanlines} onToggle={() => setCrtScanlines(!crtScanlines)} badge />
}

function ParchmentSection() {
  const parchmentTextureEnabled = useAppStore((s) => s.parchmentTextureEnabled)
  const setParchmentTextureEnabled = useAppStore((s) => s.setParchmentTextureEnabled)
  return <ToggleRow labelKey="settings.parchmentTexture" hintKey="settings.parchmentTextureHint" value={parchmentTextureEnabled} onToggle={() => setParchmentTextureEnabled(!parchmentTextureEnabled)} badge />
}

function PixelFontSection() {
  const pixelFontEnabled = useAppStore((s) => s.pixelFontEnabled)
  const setPixelFontEnabled = useAppStore((s) => s.setPixelFontEnabled)
  return <ToggleRow labelKey="settings.pixelFont" hintKey="settings.pixelFontHint" value={pixelFontEnabled} onToggle={() => setPixelFontEnabled(!pixelFontEnabled)} badge />
}

function MobileGestureSection() {
  const mobileGestureEnabled = useAppStore((s) => s.mobileGestureEnabled)
  const setMobileGestureEnabled = useAppStore((s) => s.setMobileGestureEnabled)
  return <ToggleRow labelKey="settings.mobileGesture" hintKey="settings.mobileGestureHint" value={mobileGestureEnabled} onToggle={() => setMobileGestureEnabled(!mobileGestureEnabled)} />
}

function MobileHapticSection() {
  const mobileHapticEnabled = useAppStore((s) => s.mobileHapticEnabled)
  const setMobileHapticEnabled = useAppStore((s) => s.setMobileHapticEnabled)
  return <ToggleRow labelKey="settings.mobileHaptic" hintKey="settings.mobileHapticHint" value={mobileHapticEnabled} onToggle={() => setMobileHapticEnabled(!mobileHapticEnabled)} />
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
type CategoryId = 'appearance' | 'audio' | 'auth' | 'terminal' | 'sessions' | 'language' | 'mobile' | 'agents'

interface Category {
  id: CategoryId
  labelKey: string
  /** 语义分组：同一子数组里的 section 渲染进同一张悬浮卡片（同组 = 同一类设置，
   *  如「显示尺寸」「像素特效」）。分组只影响卡片边界，不改变 section 自身结构，
   *  新增 section 时按语义决定并入哪个组或单起一组。 */
  groups: SectionComponent[][]
  /** When true, the tab is only shown on mobile viewports. */
  mobileOnly?: boolean
}

const CATEGORIES: Category[] = [
  {
    id: 'appearance',
    labelKey: 'settings.category.appearance',
    groups: [
      [ThemeSection],
      [UiZoomSection, FontSizeSection, ChatFontSizeSection],
      [PixelFontSection, CrtSection, AnimationsSection, ParchmentSection],
      [AboutSection],
    ],
  },
  {
    id: 'audio',
    labelKey: 'settings.category.audio',
    groups: [[SoundSection]],
  },
  {
    id: 'auth',
    labelKey: 'settings.category.auth',
    groups: [[AuthSection], [AuditLogSection]],
  },
  {
    id: 'terminal',
    labelKey: 'settings.category.terminal',
    groups: [[DefaultEngineSection], [AutoCopySection, TmuxMouseSection]],
  },
  {
    id: 'sessions',
    labelKey: 'settings.category.sessions',
    groups: [[PermissionTimeoutSection], [SessionDisplaySection], [SessionTimeoutSection]],
  },
  {
    id: 'language',
    labelKey: 'settings.category.language',
    groups: [[LanguageSection]],
  },
  {
    id: 'agents',
    labelKey: 'settings.category.agents',
    groups: [[AgentSettings]],
  },
  {
    id: 'mobile',
    labelKey: 'settings.category.mobile',
    groups: [[MobileGestureSection, MobileHapticSection, ImmersiveSection]],
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
      <OverlayScroll style={{ flex: 1, minWidth: 0 }} contentClassName="settings-content">
        {activeCategory.groups.map((group, i) => (
          <div className="settings-card" key={i}>
            {group.map((Section, j) => (
              <Section key={j} />
            ))}
          </div>
        ))}
      </OverlayScroll>
    </div>
  )
}
