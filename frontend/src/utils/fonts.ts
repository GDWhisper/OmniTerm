/**
 * Shared font stacks for the OmniTerm frontend.
 *
 * Three layers, matching the CSS classes in `src/index.css` and the spec in
 * `docs/ui-style-guide.md` §2. Keep these in sync with the `.font-logo`,
 * `.font-pixel`, `.font-reader` CSS rules.
 *
 *   - READER_FONT → body / code / inputs / terminal (always readable)
 *   - LOGO_FONT   → logo wordmark only
 *   - PIXEL_FONT  → titles, buttons, status labels (gated by body.pixel-font-on
 *                   in CSS; falls back to monospace when the toggle is off)
 */

/** Reader / body / code / inputs / terminal. JetBrains Mono must be installed
 *  locally or loaded via index.html — neither is currently true, so this stack
 *  silently falls back to the system monospace (`ui-monospace`, `Consolas`).
 *  See docs/debug-log.md if you change the loading strategy. */
export const READER_FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

/** Logo wordmark — Press Start 2P first, VT323 fallback. */
export const LOGO_FONT = "'Press Start 2P', 'VT323', monospace"

/** Display text — titles, buttons, status labels. */
export const PIXEL_FONT = "'VT323', 'Press Start 2P', monospace"
