/** Viewport-space snapshot of a trigger element, taken at click time. */
export interface PopoverAnchorRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PopoverAnchor {
  /** Position snapshot: PopoverConfirm positions itself from this, not from
   *  a live DOM reference (list polling may replace the trigger node). */
  rect: PopoverAnchorRect
  /** Nearest scrollable ancestor of the trigger at click time (window when
   *  none). Scoping scroll-dismissal to this container keeps unrelated panes
   *  (streaming chat / terminal auto-scroll) from closing the popover. */
  scrollRoot: EventTarget
}

function findScrollRoot(el: Element): EventTarget {
  let node = el.parentElement
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return node
    node = node.parentElement
  }
  return window
}

export function popoverAnchor(el: Element): PopoverAnchor {
  const rect = el.getBoundingClientRect()
  return {
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
    scrollRoot: findScrollRoot(el),
  }
}
