import type { FC } from 'react'

interface OmniTermLogoProps {
  /** Rendered size in px (default 48, must be multiple of 16 for crisp pixels) */
  size?: number
  className?: string
}

/**
 * 16×16 pixel-art CRT terminal sprite.
 *   var(--logo-frame) thick outer frame  (theme-aware: matches logo-title-bar border)
 *   #12141A screen
 *   #7EE787 > prompt cursor (green)
 *   #58A6FF _ input cursor (blue)
 * Renders with image-rendering: pixelated for chunky retro blocks.
 */
export const OmniTermLogo: FC<OmniTermLogoProps> = ({ size = 48, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    shapeRendering="crispEdges"
    className={className}
    style={{ imageRendering: 'pixelated', flexShrink: 0 }}
    aria-label="OmniTerm logo"
    role="img"
  >
    {/* thick outer frame — uses --logo-frame so dark theme gets the deep graphite
        edge that matches the title bar's bottom border (was stuck on #3A2E1F
        light-wood-shadow in dark mode, looked "too brown" / inconsistent) */}
    <rect x="1" y="1" width="14" height="2" style={{ fill: 'var(--logo-frame)' }} />
    <rect x="1" y="11" width="14" height="2" style={{ fill: 'var(--logo-frame)' }} />
    <rect x="1" y="1" width="2" height="12" style={{ fill: 'var(--logo-frame)' }} />
    <rect x="13" y="1" width="2" height="12" style={{ fill: 'var(--logo-frame)' }} />
    {/* screen */}
    <rect x="3" y="3" width="10" height="8" fill="#12141A" />
    {/* > prompt (green) */}
    <rect x="4" y="5" width="2" height="1" fill="#7EE787" />
    <rect x="5" y="6" width="1" height="1" fill="#7EE787" />
    <rect x="4" y="7" width="2" height="1" fill="#7EE787" />
    {/* _ cursor (blue) */}
    <rect x="7" y="8" width="4" height="1" fill="#58A6FF" />
    {/* stand */}
    <rect x="7" y="13" width="2" height="1" style={{ fill: 'var(--logo-frame)' }} />
    {/* base */}
    <rect x="5" y="14" width="6" height="1" style={{ fill: 'var(--logo-frame)' }} />
  </svg>
)
