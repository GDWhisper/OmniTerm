interface KeyboardIconProps {
  size?: number
  color?: string
  className?: string
}

/** Keyboard icon — used for terminal empty state */
export function KeyboardIcon({ size = 40, color = 'currentColor', className }: KeyboardIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0 }}
    >
      {/* Keyboard body */}
      <rect x="2" y="6" width="20" height="12" rx="2" />
      {/* Row 1: function keys */}
      <line x1="6" y1="9" x2="6" y2="9.01" />
      <line x1="10" y1="9" x2="10" y2="9.01" />
      <line x1="14" y1="9" x2="14" y2="9.01" />
      <line x1="18" y1="9" x2="18" y2="9.01" />
      {/* Row 2: middle keys */}
      <line x1="5" y1="12" x2="5" y2="12.01" />
      <line x1="8" y1="12" x2="8" y2="12.01" />
      <line x1="11" y1="12" x2="11" y2="12.01" />
      <line x1="14" y1="12" x2="14" y2="12.01" />
      <line x1="17" y1="12" x2="17" y2="12.01" />
      <line x1="20" y1="12" x2="20" y2="12.01" />
      {/* Row 3: space bar area */}
      <line x1="7" y1="15" x2="17" y2="15" />
    </svg>
  )
}
