/** Mobile touch scroll bridge for xterm.js.
 *
 *  xterm has no native touch scrolling (its touch layer only drives tap
 *  gestures and text selection). On desktop, scrolling reaches tmux via
 *  wheel events → mouse escape sequences (tmux `mouse on` is enabled
 *  server-side). This module converts vertical finger drags into synthetic
 *  WheelEvents dispatched on the original touch target, reusing that exact
 *  desktop path. Horizontal drags are left untouched so xterm's
 *  drag-to-select keeps working (see plan D2). */

/** Pixels of movement before the gesture axis is decided. */
export const AXIS_SLOP_PX = 10
/** Scroll amplification — raw pixel deltas feel sluggish vs native scroll. */
export const TOUCH_SCROLL_FACTOR = 2

export interface TouchScrollHandlers {
  onStart: (e: TouchEvent) => void
  onMove: (e: TouchEvent) => void
  onEnd: () => void
}

export function createTouchScroll(onScroll: (deltaY: number) => void): TouchScrollHandlers {
  let startX = 0
  let startY = 0
  let lastY = 0
  let tracking = false
  let axis: 'x' | 'y' | null = null

  return {
    onStart(e) {
      if (e.touches.length !== 1) {
        tracking = false
        return
      }
      const touch = e.touches[0]
      startX = touch.clientX
      startY = touch.clientY
      lastY = touch.clientY
      axis = null
      tracking = true
    },
    onMove(e) {
      if (!tracking || e.touches.length !== 1) return
      const touch = e.touches[0]
      if (!axis) {
        const dx = touch.clientX - startX
        const dy = touch.clientY - startY
        if (Math.abs(dy) >= AXIS_SLOP_PX && Math.abs(dy) > Math.abs(dx)) axis = 'y'
        else if (Math.abs(dx) >= AXIS_SLOP_PX && Math.abs(dx) > Math.abs(dy)) axis = 'x'
        else return
      }
      if (axis !== 'y') return
      // Suppress browser scroll + compatibility mouse events (selection).
      e.preventDefault()
      const delta = lastY - touch.clientY
      lastY = touch.clientY
      if (delta !== 0) onScroll(delta * TOUCH_SCROLL_FACTOR)
    },
    onEnd() {
      tracking = false
      axis = null
    },
  }
}

/** Attach the bridge to the xterm host container. Returns a detach function.
 *
 *  `onScroll` fires with the synthesized deltaY right before each wheel event
 *  is dispatched (deltaY < 0 = wheel up = viewing history). Callers use it to
 *  keep UI state in sync with tmux's copy mode: a wheel-up scroll makes tmux
 *  enter copy mode, so the MobileKeyBar「滚动」button highlight should follow. */
export function attachTouchScroll(container: HTMLElement, onScroll?: (deltaY: number) => void): () => void {
  let wheelTarget: EventTarget | null = null
  const handlers = createTouchScroll((deltaY) => {
    if (!wheelTarget) return
    onScroll?.(deltaY)
    wheelTarget.dispatchEvent(
      new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true }),
    )
  })
  const onStart = (e: TouchEvent) => {
    // xterm.js 的 wheel listener 挂在 `this.element`（class="xterm"）上。
    // 在 Chromium 中，把合成 WheelEvent 派发到触摸 target（通常是 .xterm-screen
    // 内的子元素）后事件不会冒泡到 .xterm 的 listener，导致 pty viewport 接管
    // 与 tmux 默认滚动都失效。因此直接把事件派发到 .xterm 元素本身。
    const xtermEl = container.querySelector('.xterm')
    wheelTarget = xtermEl ?? e.target
    handlers.onStart(e)
  }
  container.addEventListener('touchstart', onStart, { passive: true })
  container.addEventListener('touchmove', handlers.onMove, { passive: false })
  container.addEventListener('touchend', handlers.onEnd)
  container.addEventListener('touchcancel', handlers.onEnd)
  return () => {
    container.removeEventListener('touchstart', onStart)
    container.removeEventListener('touchmove', handlers.onMove)
    container.removeEventListener('touchend', handlers.onEnd)
    container.removeEventListener('touchcancel', handlers.onEnd)
  }
}
