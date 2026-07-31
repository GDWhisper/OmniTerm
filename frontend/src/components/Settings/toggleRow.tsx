import { useTranslation } from 'react-i18next'
import { BetaBadge } from '../Common/BetaBadge'
import { btnBase } from './settingsStyles'

/* Shared UI primitives for settings sections (used by Settings.tsx and AuthSection.tsx). */

const sectionTitleStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 11,
  fontWeight: 500,
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
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
  badge?: boolean
  /** Render the hint in danger color (e.g. security warnings). */
  dangerHint?: boolean
}

export function ToggleRow({ labelKey, hintKey, value, onToggle, badge, dangerHint }: ToggleRowProps) {
  const { t } = useTranslation()
  return (
    <section className="space-y-2">
      <SectionTitle>
        {t(labelKey)}
        {badge && <>{' '}<BetaBadge /></>}
      </SectionTitle>
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
        {value ? t('settings.on') : t('settings.off')}
      </button>
      <p style={{ fontSize: 11, color: dangerHint ? 'var(--danger)' : 'var(--text-faint)', lineHeight: 1.5 }}>{t(hintKey)}</p>
    </section>
  )
}
