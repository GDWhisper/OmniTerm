import { useState, useRef, useEffect } from 'react'
import type { ConfigOption } from '../../stores/chatStore'
import { READER_FONT } from '../../utils/fonts'

const CATEGORY_LABELS: Record<string, string> = {
  mode: 'Mode',
  model: 'Model',
  model_config: 'Config',
  thought_level: 'Thinking',
}

const CATEGORY_ORDER = ['mode', 'model', 'thought_level', 'model_config']

function ConfigDropdown({
  option,
  onSelect,
}: {
  option: ConfigOption
  onSelect: (configId: string, value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const current = option.options.find((o) => o.value === option.currentValue)
  const label = CATEGORY_LABELS[option.category] ?? option.name

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          fontSize: 11,
          fontFamily: READER_FONT,
          background: open ? 'var(--bg-surface)' : 'var(--bg-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>{label}:</span>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
          {current?.name ?? option.currentValue}
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-faint)' }}>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 2,
            minWidth: 140,
            maxHeight: 200,
            overflowY: 'auto',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 6,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 100,
            padding: '4px 0',
          }}
        >
          {option.options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onSelect(option.id, opt.value)
                setOpen(false)
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '5px 10px',
                fontSize: 11,
                fontFamily: READER_FONT,
                border: 'none',
                background: opt.value === option.currentValue ? 'var(--accent-14)' : 'transparent',
                color: opt.value === option.currentValue ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontWeight: opt.value === option.currentValue ? 600 : 400,
              }}
            >
              {opt.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function UsageIndicator({ usage }: { usage: Record<string, unknown> }) {
  const used = typeof usage['used'] === 'number' ? usage['used'] : null
  const size = typeof usage['size'] === 'number' ? usage['size'] : null
  const pct = used !== null && size !== null && size > 0 ? (used / size) * 100 : null
  const costObj = usage['cost']
  const cost = costObj && typeof costObj === 'object' && typeof (costObj as Record<string, unknown>)['amount'] === 'number'
    ? (costObj as Record<string, unknown>)['amount'] as number
    : null

  if (pct === null && cost === null) return null

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 10,
        color: 'var(--text-faint)',
        fontFamily: READER_FONT,
      }}
    >
      {pct !== null && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <span
            style={{
              width: 32,
              height: 4,
              borderRadius: 2,
              background: 'var(--bg-surface)',
              overflow: 'hidden',
              display: 'inline-block',
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${Math.min(100, pct)}%`,
                borderRadius: 2,
                background: pct > 80 ? 'var(--danger, #FF7B72)' : 'var(--accent)',
              }}
            />
          </span>
          {Math.round(pct)}%
        </span>
      )}
      {cost !== null && <span>${cost.toFixed(4)}</span>}
    </div>
  )
}

export function ConfigToolbar({
  configOptions,
  usage,
  onSetConfigOption,
}: {
  configOptions: ConfigOption[]
  usage: Record<string, unknown> | null
  onSetConfigOption: (configId: string, value: string) => void
}) {
  if (configOptions.length === 0 && !usage) return null

  const sorted = [...configOptions].sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a.category)
    const bi = CATEGORY_ORDER.indexOf(b.category)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg-base)',
        flexWrap: 'wrap',
      }}
    >
      {sorted.map((opt) => (
        <ConfigDropdown key={opt.id} option={opt} onSelect={onSetConfigOption} />
      ))}
      {usage && (
        <div style={{ marginLeft: 'auto' }}>
          <UsageIndicator usage={usage} />
        </div>
      )}
    </div>
  )
}
