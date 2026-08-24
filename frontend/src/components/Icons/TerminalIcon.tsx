
interface TerminalIconProps {
  size?: number
  className?: string
  primaryColor?: string
}

/** Pixel-art terminal / monitor icon used in the CreateSessionModal category card. */
export function TerminalIcon({ size = 28, className, primaryColor = 'var(--text-primary)' }: TerminalIconProps) {
  return (
    <svg
      role="img"
      aria-label="terminal icon"
      width={size}
      height={size}
      viewBox="0 0 28 28"
      shapeRendering="crispEdges"
      style={{ imageRendering: 'pixelated', flexShrink: 0 }}
      className={className}
    >
      {/* Screen bezel */}
      <rect x="2" y="2" width="24" height="18" fill="none" stroke={primaryColor} strokeWidth="2" />
      {/* Screen inner */}
      <rect x="5" y="5" width="18" height="12" fill="none" stroke={primaryColor} strokeWidth="1" />
      {/* Scan line */}
      <line x1="5" y1="11" x2="23" y2="11" stroke={primaryColor} strokeWidth="1" />
      {/* Stand neck */}
      <rect x="12" y="20" width="4" height="2" fill={primaryColor} />
      {/* Stand base */}
      <rect x="8" y="22" width="12" height="2" fill={primaryColor} />
      {/* Power LED */}
      <rect x="13" y="19" width="2" height="1" fill="var(--accent)" />
    </svg>
  )
}
