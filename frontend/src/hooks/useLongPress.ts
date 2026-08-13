import { useCallback, useEffect, useRef } from 'react'
import type { TouchEvent } from 'react'

export interface LongPressPoint {
  x: number
  y: number
}

interface UseLongPressOptions {
  /** 长按达成时回调，参数为触点坐标（菜单锚点用）与触发事件（供 target 判断）。 */
  onLongPress: (point: LongPressPoint, e: TouchEvent) => void
  /** 长按时长（ms）。与终端 paste 菜单共用 500ms（mobile 计划 D6 范式）。 */
  longPressMs?: number
  /** 触点位移超过该值取消长按（防止滚动时误触）。 */
  cancelPx?: number
  /** 为 true 时忽略全部触摸（如非移动端）。 */
  disabled?: boolean
}

/**
 * 移动端长按手势 hook（D3）。
 *
 * 提取自 Terminal.tsx 的 paste 菜单内联实现，两个消费方（终端粘贴 + 聊天气泡
 * 动作菜单）共用同一套语义：按下计时、位移取消、触手即清。`hapticTap` 与菜单
 * 定位等消费方差异留在回调里，hook 保持纯手势语义。
 *
 * 用法：把返回的 onTouch* 绑到触发区域容器上。
 */
export function useLongPress({
  onLongPress,
  longPressMs = 500,
  cancelPx = 10,
  disabled = false,
}: UseLongPressOptions) {
  const startRef = useRef<LongPressPoint | null>(null)
  const timerRef = useRef<number | null>(null)
  // 最新回调存 ref：避免调用方每次渲染新建回调导致 touch handler 引用漂移
  // （ChatMessage 是 memo 组件，handler 必须稳定）。
  const onLongPressRef = useRef(onLongPress)
  useEffect(() => {
    onLongPressRef.current = onLongPress
  }, [onLongPress])

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    startRef.current = null
  }, [])

  // 卸载清理未触发的计时器
  useEffect(() => clear, [clear])

  const onTouchStart = useCallback(
    (e: TouchEvent) => {
      if (disabled) return
      const touch = e.touches[0]
      if (!touch) return
      clear()
      const point = { x: touch.clientX, y: touch.clientY }
      startRef.current = point
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        onLongPressRef.current(point, e)
      }, longPressMs)
    },
    [disabled, longPressMs, clear],
  )

  const onTouchMove = useCallback(
    (e: TouchEvent) => {
      const start = startRef.current
      if (!start) return
      const touch = e.touches[0]
      if (!touch) return
      if (
        Math.abs(touch.clientX - start.x) > cancelPx ||
        Math.abs(touch.clientY - start.y) > cancelPx
      ) {
        clear()
      }
    },
    [cancelPx, clear],
  )

  const onTouchEnd = useCallback(() => clear(), [clear])
  const onTouchCancel = useCallback(() => clear(), [clear])

  return { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, clear }
}
