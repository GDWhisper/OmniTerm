import type { FC } from 'react'

export interface BaseSpriteProps {
  size?: number
  className?: string
}

export interface SpriteProps extends BaseSpriteProps {
  /** Override primary fill color (used for dark/light theme adaptation) */
  primaryColor?: string
}

const baseStyle = { imageRendering: 'pixelated' as const, flexShrink: 0 }

export const FolderSprite: FC<SpriteProps> = ({ size = 16, className, primaryColor = '#8B5A2B' }) => (
  <svg role="img" aria-label="folder icon" width={size} height={size * 0.875} viewBox="0 0 16 14" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="0" y="2" width="16" height="12" fill={primaryColor} />
    <rect x="0" y="0" width="6" height="4" fill={primaryColor} />
    <rect x="0" y="4" width="16" height="2" fill="#A06A3B" />
  </svg>
)

export const FileSprite: FC<SpriteProps> = ({ size = 16, className, primaryColor = '#A89474' }) => (
  <svg role="img" aria-label="file icon" width={size * 0.875} height={size} viewBox="0 0 14 16" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="2" y="0" width="10" height="14" fill={primaryColor} />
    <rect x="4" y="2" width="6" height="2" fill="#FAF2DE" />
    <rect x="4" y="6" width="6" height="1" fill="#FAF2DE" />
    <rect x="4" y="8" width="6" height="1" fill="#FAF2DE" />
    <rect x="4" y="10" width="4" height="1" fill="#FAF2DE" />
  </svg>
)

export const FileCodeSprite: FC<BaseSpriteProps> = ({ size = 16, className }) => (
  <svg role="img" aria-label="code file icon" width={size * 0.875} height={size} viewBox="0 0 14 16" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="2" y="0" width="10" height="14" fill="#58A6FF" />
    <rect x="4" y="3" width="2" height="1" fill="#12141A" />
    <rect x="3" y="4" width="1" height="2" fill="#12141A" />
    <rect x="4" y="6" width="2" height="1" fill="#12141A" />
    <rect x="8" y="3" width="2" height="1" fill="#12141A" />
    <rect x="10" y="4" width="1" height="2" fill="#12141A" />
    <rect x="8" y="6" width="2" height="1" fill="#12141A" />
  </svg>
)

/** Shared internal component for status bar sprites — differs only in fill color. */
const StatusBarSprite: FC<BaseSpriteProps & { color: string; ariaLabel: string }> = ({
  size = 16,
  className,
  color,
  ariaLabel,
}) => (
  <svg role="img" aria-label={ariaLabel} width={size} height={size * 0.5} viewBox="0 0 16 8" shapeRendering="crispEdges" style={baseStyle} className={className}>
    {[0, 3, 6, 9, 12].map((x) => (
      <rect key={x} x={x} y="0" width="2" height="8" fill={color} />
    ))}
  </svg>
)

export const StatusRunningSprite: FC<BaseSpriteProps> = (props) => (
  <StatusBarSprite {...props} color="#7EE787" ariaLabel="running status" />
)

export const StatusStoppedSprite: FC<BaseSpriteProps> = (props) => (
  <StatusBarSprite {...props} color="#A89474" ariaLabel="stopped status" />
)

/** WebSocket/HTTP link status — 3 thick vertical bars (4px wide, 2px gap),
 *  all lit or all dim (binary). Chunky weight chosen over the original 5 thin
 *  bars (2px) — thin bars got visually lost on the dark badge background.
 *  Uses fixed terminal-style colors (bright green / red) because the sprite
 *  lives on a dark "badge" background (see .title-bar-badge + bottom
 *  connection status in Sidebar). Don't theme-adapt — the "connection is
 *  alive" signal is intentionally consistent across themes. */
export const SignalBarsSprite: FC<BaseSpriteProps & { connected: boolean }> = ({
  size = 16,
  className,
  connected,
}) => {
  const color = connected ? '#7EE787' : '#FF7B72'
  return (
    <svg
      role="img"
      aria-label={connected ? 'link ok' : 'link lost'}
      width={size}
      height={size * 0.5}
      viewBox="0 0 16 8"
      shapeRendering="crispEdges"
      style={{ ...baseStyle, fill: color }}
      className={className}
    >
      {[0, 6, 12].map((x) => (
        <rect key={x} x={x} y="0" width="4" height="8" />
      ))}
    </svg>
  )
}

export const GitBranchSprite: FC<BaseSpriteProps & { color?: string }> = ({ size = 16, className, color = '#F778BA' }) => (
  <svg role="img" aria-label="git branch" width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="4" y="2" width="2" height="12" fill={color} />
    <rect x="10" y="2" width="2" height="6" fill={color} />
    <rect x="6" y="6" width="4" height="2" fill={color} />
    <rect x="3" y="1" width="4" height="2" fill={color} />
    <rect x="9" y="1" width="4" height="2" fill={color} />
    <rect x="3" y="13" width="4" height="2" fill={color} />
  </svg>
)
