/**
 * Shared font stacks for the OmniTerm frontend.
 *
 * Three layers, matching the CSS classes in `src/index.css` and the spec in
 * `docs/ui-style-guide.md` §2. Keep these in sync with the `.font-logo`,
 * `.font-pixel`, `.font-reader` CSS rules.
 *
 *   - READER_FONT → body / code / inputs / terminal (always readable)
 *   - LOGO_FONT   → logo wordmark only
 *   - PIXEL_FONT  → titles, buttons, status labels (always on)
 */

/** Reader / body / code / inputs / terminal. JetBrains Mono is self-hosted
 *  via @font-face in index.css (jetbrains-mono-latin[-ext].woff2), so it loads
 *  locally with no remote dependency. Keep this stack in sync with the
 *  `--reader-font` CSS variable and the `.font-reader` rule in index.css. */
export const READER_FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

/** Logo wordmark — Press Start 2P first, VT323 fallback. */
export const LOGO_FONT = "'Press Start 2P', 'VT323', monospace"

/** Display text — titles, buttons, status labels. */
export const PIXEL_FONT = "'Silkscreen', 'VT323', 'Press Start 2P', monospace"
