/** @xterm/xterm creates a hidden <textarea> inside the host container and
 *  focuses it on tap.  On mobile, focusing a textarea with `inputmode="text"`
 *  (the default) makes the soft keyboard pop up, which can cover the visible
 *  terminal context.  When the user has entered tmux scroll/copy mode via the
 *  MobileKeyBar "滚动" button, we set `inputmode="none"` on that textarea so
 *  the browser keeps the keyboard down while they page through history with
 *  ↑/↓ taps.
 *
 *  Exiting scroll mode restores the default `"text"` value so IME input
 *  works normally again.
 *
 *  Reference: HTML `inputmode` attribute — supported in iOS Safari 12.2+
 *  and Android Chrome, ignored on desktop (no on-screen keyboard). */

/** inputmode to use while the user is in tmux scroll/copy mode. */
export const SCROLL_INPUTMODE = 'none'

/** Default inputmode when not scrolling — same value the browser assigns
 *  to a bare <textarea>, stated explicitly for symmetry with SCROLL_INPUTMODE. */
export const NORMAL_INPUTMODE = 'text'

/** Sync the xterm textarea's `inputmode` attribute with the current scroll
 *  state.  No-op when the container or its textarea is not yet in the DOM
 *  (xterm creates the textarea asynchronously inside term.open); the next
 *  scrollMode change will pick it up. */
export function syncTextareaInputMode(container: HTMLDivElement | null, scrollMode: boolean): void {
  if (!container) return
  const textarea = container.querySelector('textarea')
  if (!textarea) return
  textarea.setAttribute('inputmode', scrollMode ? SCROLL_INPUTMODE : NORMAL_INPUTMODE)
}
