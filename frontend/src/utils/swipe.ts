/** Pure gesture math for the mobile follow-finger tab swipe (Layout.tsx).
 *  Kept DOM-free so the decision rules are unit-testable. */

/** Pixels before the gesture axis (horizontal vs vertical) is decided. */
export const SWIPE_AXIS_SLOP_PX = 12
/** Minimum horizontal displacement at touchend to commit a tab switch. */
export const SWIPE_COMMIT_PX = 64
/** Drag multiplier when there is no neighbor tab in the dragged direction. */
export const EDGE_RESISTANCE = 0.35

export type SwipeAxis = 'x' | 'y' | null

export function decideSwipeAxis(dx: number, dy: number): SwipeAxis {
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  if (ady >= SWIPE_AXIS_SLOP_PX && ady > adx) return 'y'
  if (adx >= SWIPE_AXIS_SLOP_PX && adx > ady) return 'x'
  return null
}

/** dx > 0 drags rightward (toward previous tab); dx < 0 toward next. */
export function applyEdgeResistance(dx: number, canPrev: boolean, canNext: boolean): number {
  if (dx > 0 && !canPrev) return dx * EDGE_RESISTANCE
  if (dx < 0 && !canNext) return dx * EDGE_RESISTANCE
  return dx
}

export function resolveSwipeCommit(
  dx: number,
  canPrev: boolean,
  canNext: boolean,
): 'prev' | 'next' | null {
  if (dx <= -SWIPE_COMMIT_PX && canNext) return 'next'
  if (dx >= SWIPE_COMMIT_PX && canPrev) return 'prev'
  return null
}
