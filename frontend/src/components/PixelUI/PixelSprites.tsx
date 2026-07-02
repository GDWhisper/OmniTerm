import type { FC } from 'react'

interface SpriteProps {
  size?: number
  className?: string
  /** Override primary fill color (used for dark/light theme adaptation) */
  primaryColor?: string
}

const baseStyle = { imageRendering: 'pixelated' as const, flexShrink: 0 }

export const FolderSprite: FC<SpriteProps> = ({ size = 16, className, primaryColor = '#8B5A2B' }) => (
  <svg width={size} height={size * 0.875} viewBox="0 0 16 14" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="0" y="2" width="16" height="12" fill={primaryColor} />
    <rect x="0" y="0" width="6" height="4" fill={primaryColor} />
    <rect x="0" y="4" width="16" height="2" fill="#A06A3B" />
  </svg>
)

export const FileSprite: FC<SpriteProps> = ({ size = 16, className, primaryColor = '#A89474' }) => (
  <svg width={size * 0.875} height={size} viewBox="0 0 14 16" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="2" y="0" width="10" height="14" fill={primaryColor} />
    <rect x="4" y="2" width="6" height="2" fill="#FAF2DE" />
    <rect x="4" y="6" width="6" height="1" fill="#FAF2DE" />
    <rect x="4" y="8" width="6" height="1" fill="#FAF2DE" />
    <rect x="4" y="10" width="4" height="1" fill="#FAF2DE" />
  </svg>
)

export const FileCodeSprite: FC<SpriteProps> = ({ size = 16, className }) => (
  <svg width={size * 0.875} height={size} viewBox="0 0 14 16" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="2" y="0" width="10" height="14" fill="#58A6FF" />
    <rect x="4" y="3" width="2" height="1" fill="#12141A" />
    <rect x="3" y="4" width="1" height="2" fill="#12141A" />
    <rect x="4" y="6" width="2" height="1" fill="#12141A" />
    <rect x="8" y="3" width="2" height="1" fill="#12141A" />
    <rect x="10" y="4" width="1" height="2" fill="#12141A" />
    <rect x="8" y="6" width="2" height="1" fill="#12141A" />
  </svg>
)

export const StatusRunningSprite: FC<SpriteProps> = ({ size = 16, className }) => (
  <svg width={size} height={size * 0.5} viewBox="0 0 16 8" shapeRendering="crispEdges" style={baseStyle} className={className}>
    {[0, 3, 6, 9, 12].map((x) => (
      <rect key={x} x={x} y="0" width="2" height="8" fill="#7EE787" />
    ))}
  </svg>
)

export const StatusStoppedSprite: FC<SpriteProps> = ({ size = 16, className }) => (
  <svg width={size} height={size * 0.5} viewBox="0 0 16 8" shapeRendering="crispEdges" style={baseStyle} className={className}>
    {[0, 3, 6, 9, 12].map((x) => (
      <rect key={x} x={x} y="0" width="2" height="8" fill="#A89474" />
    ))}
  </svg>
)

export const GitBranchSprite: FC<SpriteProps> = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" style={baseStyle} className={className}>
    <rect x="4" y="2" width="2" height="12" fill="#F778BA" />
    <rect x="10" y="2" width="2" height="6" fill="#F778BA" />
    <rect x="6" y="6" width="4" height="2" fill="#F778BA" />
    <rect x="3" y="1" width="4" height="2" fill="#F778BA" />
    <rect x="9" y="1" width="4" height="2" fill="#F778BA" />
    <rect x="3" y="13" width="4" height="2" fill="#F778BA" />
  </svg>
)
