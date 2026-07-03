import { useTranslation } from 'react-i18next'
import { SECTIONS } from './data'

const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

export function TmuxCheatsheet() {
  const { t } = useTranslation()

  return (
    <div style={{ fontFamily: FONT, padding: '12px 16px' }}>
      <p
        style={{
          fontSize: 11,
          color: 'var(--text-faint)',
          lineHeight: 1.5,
          marginBottom: 12,
        }}
      >
        {t('tmuxCheatsheet.prefixHint')}
      </p>

      {SECTIONS.map((section) => (
        <section key={section.titleKey} style={{ marginBottom: 14 }}>
          <h3
            style={{
              color: 'var(--text-muted)',
              fontSize: 11,
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              marginBottom: 6,
            }}
          >
            {t(section.titleKey)}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {section.items.map((item) => (
              <div
                key={item.labelKey}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 12,
                }}
              >
                <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {t(item.labelKey)}
                </span>
                <code
                  style={{
                    fontSize: 11,
                    color: 'var(--accent)',
                    fontFamily: FONT,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {item.cmd}
                </code>
              </div>
            ))}
          </div>
          {section.hintKey && (
            <p
              style={{
                fontSize: 10,
                color: 'var(--text-dim)',
                lineHeight: 1.5,
                marginTop: 5,
              }}
            >
              {t(section.hintKey)}
            </p>
          )}
        </section>
      ))}
    </div>
  )
}
