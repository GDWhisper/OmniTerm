/** @xterm/xterm creates a hidden <textarea> inside the host container and
 *  focuses it on tap.  On mobile, focusing a textarea with `inputmode="text"`
 *  (the default) makes the soft keyboard pop up, which can cover the visible
 *  terminal context.  When the user is browsing history (via the MobileKeyBar
 *  "滚动" button, or by wheeling/touch-scrolling away from the live bottom),
 *  we set `inputmode="none"` on that textarea so the browser keeps the
 *  keyboard down while they page through history with ↑/↓ taps.
 *
 *  Exiting scroll mode restores the default `"text"` value so IME input
 *  works normally again.
 *
 *  `scrollMode` 的语义按 runtime 分源（pty = 已滚离 live 底部，由
 *  ViewportController 驱动；tmux = 处于 copy-mode），但本模块只关心
 *  「是否正在翻历史」这一个布尔值 —— 两种 runtime 下抑制软键盘的需求
 *  完全一致，故此处不做分流。
 *
 *  Reference: HTML `inputmode` attribute — supported in iOS Safari 12.2+
 *  and Android Chrome, ignored on desktop (no on-screen keyboard). */

/** inputmode to use while the user is browsing history. */
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
