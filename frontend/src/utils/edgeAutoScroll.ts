/**
 * 指针进入滚动容器上/下边缘带时按帧滚动容器（拖拽排序 / 拖拽投放共用）。
 *
 * 供 rAF 循环逐帧调用：返回 true 表示本次确实滚动了（已到边界返回 false），
 * 调用方据此重算拖拽跟随与插入点。容器无高度（jsdom 等无布局环境）时不动作。
 */
export interface EdgeAutoScrollOptions {
  /** 边缘触发带宽度（px） */
  edge?: number
  /** 每帧滚动步长（px） */
  step?: number
}

const DEFAULT_EDGE_PX = 40
const DEFAULT_STEP_PX = 8

export function autoScrollNearEdge(
  container: HTMLElement,
  clientY: number,
  { edge = DEFAULT_EDGE_PX, step = DEFAULT_STEP_PX }: EdgeAutoScrollOptions = {},
): boolean {
  const rect = container.getBoundingClientRect()
  if (rect.height <= 0) return false
  let delta = 0
  if (clientY < rect.top + edge) delta = -step
  else if (clientY > rect.bottom - edge) delta = step
  if (delta === 0) return false
  const before = container.scrollTop
  container.scrollTop = before + delta
  return container.scrollTop !== before
}
