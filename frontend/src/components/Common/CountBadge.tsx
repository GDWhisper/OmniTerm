export function CountBadge({ count }: { count: number }) {
  return (
    <span
      style={{
        fontFamily: 'var(--pixel-font-static)',
        fontSize: 16,
        lineHeight: 1,
        background: 'var(--wood-shadow, #3A2E1F)',
        color: '#7EE787',
        padding: '1px 6px',
        minWidth: 24,
        textAlign: 'center',
        boxShadow: `
          inset 0 2px 0 var(--wood-inset-dark, #140F0A),
          inset 2px 0 0 var(--wood-inset-dark, #140F0A),
          inset 0 -2px 0 var(--wood-inset-light, #6E543A),
          inset -2px 0 0 var(--wood-inset-light, #6E543A)
        `,
      }}
    >
      {count}
    </span>
  )
}
