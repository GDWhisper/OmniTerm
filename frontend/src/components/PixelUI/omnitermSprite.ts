/**
 * OmniTerm CRT pixel sprite — SINGLE SOURCE OF TRUTH.
 *
 * The 16×16 sprite is defined here once and consumed by two places:
 *   1. `OmniTermLogo.tsx` — the in-app inline SVG (sidebar, 48px).
 *   2. `scripts/gen-logo-icons.mjs` — generates the derived assets
 *      `frontend/public/favicon.svg`, `icon-192.png` and `icon-512.png`.
 *
 * Edit ONLY this file to change the logo, then regenerate the derived assets:
 *
 *   node scripts/gen-logo-icons.mjs
 *
 * CI runs the same script with `--check` and fails if the committed derived
 * assets drift from this source. Keep the file free of non-erasable syntax
 * (no enum/namespace) so Node's type stripping can import it directly.
 */

/** Fixed brand palette — NOT theme-aware (ui-style-guide §3.1). */
export const LOGO_COLORS = {
  /** Thick outer frame (matches `--wood-shadow`, so the CRT reads as
   *  "embedded" in the logo-title-bar's bottom border in both themes). */
  frame: '#3A2E1F',
  /** Screen glass. */
  screen: '#12141A',
  /** `>` shell prompt. */
  prompt: '#7EE787',
  /** `_` input cursor. */
  cursor: '#58A6FF',
} as const

export interface SpriteRect {
  x: number
  y: number
  w: number
  h: number
  fill: string
}

/** Native sprite grid edge, in pixels. */
export const SPRITE_SIZE = 16

/**
 * Painted back-to-front on a {@link SPRITE_SIZE}×{@link SPRITE_SIZE} grid
 * (later rects overwrite earlier ones). The mark is centred vertically; it
 * has no monitor stand/base.
 */
export const OMNITERM_SPRITE: readonly SpriteRect[] = [
  // thick outer frame
  { x: 1, y: 2, w: 14, h: 2, fill: LOGO_COLORS.frame },
  { x: 1, y: 12, w: 14, h: 2, fill: LOGO_COLORS.frame },
  { x: 1, y: 2, w: 2, h: 12, fill: LOGO_COLORS.frame },
  { x: 13, y: 2, w: 2, h: 12, fill: LOGO_COLORS.frame },
  // screen
  { x: 3, y: 4, w: 10, h: 8, fill: LOGO_COLORS.screen },
  // > prompt
  { x: 4, y: 6, w: 2, h: 1, fill: LOGO_COLORS.prompt },
  { x: 5, y: 7, w: 1, h: 1, fill: LOGO_COLORS.prompt },
  { x: 4, y: 8, w: 2, h: 1, fill: LOGO_COLORS.prompt },
  // _ cursor
  { x: 7, y: 9, w: 4, h: 1, fill: LOGO_COLORS.cursor },
]
