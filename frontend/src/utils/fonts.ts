/**
 * Shared font stacks for the OmniTerm frontend.
 *
 * Single source of truth is the CSS variables in `src/index.css` `:root`
 * (`--reader-font` / `--logo-font` / `--pixel-font` / `--pixel-font-static`)
 * — see `docs/ui-style-guide.md` §2. Inline styles that need a pixel or logo
 * font must use `fontFamily: 'var(--pixel-font)'` etc. so they respect the
 * pixel-font BETA toggle (body.pixel-font-on).
 */

/** Reader / body / code / inputs / terminal. JetBrains Mono is self-hosted
 *  via @font-face in index.css (jetbrains-mono-latin[-ext].woff2), so it loads
 *  locally with no remote dependency. Kept as a JS constant because consumers
 *  like xterm.js need a resolved font string, not a CSS var. Keep in sync with
 *  the `--reader-font` CSS variable and the `.font-reader` rule in index.css. */
export const READER_FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"
