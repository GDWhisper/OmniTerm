import type { FC } from 'react'
import { OMNITERM_SPRITE, SPRITE_SIZE } from './omnitermSprite'

interface OmniTermLogoProps {
  /** Rendered size in px (default 48, must be multiple of 16 for crisp pixels) */
  size?: number
  className?: string
}

/**
 * 16×16 pixel-art CRT terminal sprite, rendered with image-rendering:
 * pixelated for chunky retro blocks.
 *
 * The pixel data lives in `omnitermSprite.ts` — the single source of truth
 * shared with the favicon/PWA-icon generator. Edit THAT file, not this one;
 * derived assets are regenerated with `node scripts/gen-logo-icons.mjs`.
 */
export const OmniTermLogo: FC<OmniTermLogoProps> = ({ size = 48, className }) => (
  <svg
    width={size}
    height={size}
    viewBox={`0 0 ${SPRITE_SIZE} ${SPRITE_SIZE}`}
    shapeRendering="crispEdges"
    className={className}
    style={{ imageRendering: 'pixelated', flexShrink: 0 }}
    aria-label="OmniTerm logo"
    role="img"
  >
    {OMNITERM_SPRITE.map((r) => (
      <rect key={`${r.x},${r.y},${r.w},${r.h}`} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />
    ))}
  </svg>
)
