interface GitBranchIconProps {
  size?: number
  color?: string
  className?: string
}

/** Git branch icon — mimics the classic git logo node/fork shape */
export function GitBranchIcon({ size = 14, color = 'currentColor', className }: GitBranchIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flexShrink: 0 }}
    >
      {/* Main vertical line */}
      <line x1="5" y1="3" x2="5" y2="13" />
      {/* Branch fork going right-up */}
      <line x1="5" y1="8" x2="11" y2="4" />
      {/* Top node (main branch tip) */}
      <circle cx="5" cy="3" r="1.5" fill={color} stroke="none" />
      {/* Bottom node (base) */}
      <circle cx="5" cy="13" r="1.5" fill={color} stroke="none" />
      {/* Branch tip node */}
      <circle cx="11" cy="4" r="1.5" fill={color} stroke="none" />
    </svg>
  )
}
