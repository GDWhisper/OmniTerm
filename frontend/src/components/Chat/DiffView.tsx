import { READER_FONT } from '../../utils/fonts'

// 聊天流内联 unified diff 渲染（轻量、无行号；带行号的完整版见 GitPanel/DiffView）。
export function DiffView({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre
      style={{
        margin: 0,
        padding: '6px 8px',
        background: 'var(--bg-elevated)',
        borderRadius: 4,
        fontSize: '0.846em',
        overflow: 'auto',
        maxHeight: 300,
        fontFamily: READER_FONT,
        lineHeight: 1.5,
      }}
    >
      {lines.map((line, i) => {
        let color = 'var(--text-muted)'
        let bg = 'transparent'
        if (line.startsWith('+++') || line.startsWith('---')) {
          color = 'var(--text-faint)'
        } else if (line.startsWith('@@')) {
          color = 'var(--accent)'
        } else if (line.startsWith('+')) {
          color = 'var(--success)'
          bg = 'color-mix(in srgb, var(--success) 15%, transparent)'
        } else if (line.startsWith('-')) {
          color = 'var(--danger)'
          bg = 'color-mix(in srgb, var(--danger) 15%, transparent)'
        }
        return (
          <div key={i} style={{ color, background: bg, minHeight: '1em' }}>{line || ' '}</div>
        )
      })}
    </pre>
  )
}
