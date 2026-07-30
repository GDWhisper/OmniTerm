export function CountBadge({ count }: { count: number }) {
  return (
    <span
      className="status-badge-3d"
      style={{
        fontFamily: 'var(--pixel-font-static)',
        fontSize: 16,
        lineHeight: 1,
        background: 'var(--wood-shadow, #3A2E1F)',
        color: '#7EE787',
        padding: '1px 6px',
        minWidth: 24,
        textAlign: 'center',
      }}
    >
      {count}
    </span>
  )
}
