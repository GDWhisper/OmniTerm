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

/** Attach the bridge to the xterm host container. Returns a detach function. */
export function attachTouchScroll(container: HTMLElement): () => void {
  let wheelTarget: EventTarget | null = null
  const handlers = createTouchScroll((deltaY) => {
    if (!wheelTarget) return
    wheelTarget.dispatchEvent(
      new WheelEvent('wheel', { deltaY, deltaMode: 0, bubbles: true, cancelable: true }),
    )
  })
  const onStart = (e: TouchEvent) => {
    wheelTarget = e.target
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
