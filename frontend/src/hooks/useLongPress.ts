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

/** 滚动发生后该时长内的新触摸不启动长按：滚动停止后轻触静止（放下手指阅读/
 * 继续操作）极易被误判为长按；滚动中的触摸另由 scrollTop 检测即时取消。 */
export const SCROLL_COOLDOWN_MS = 400

// 滚动不冒泡但捕获阶段可达（window → 滚动容器），模块级一次注册即可覆盖所有
// 滚动容器（聊天气泡列表、文件列表等），无需给每个消费方传滚动信号。
let lastScrollAt = 0
if (typeof window !== 'undefined') {
  window.addEventListener(
    'scroll',
    () => {
      lastScrollAt = Date.now()
    },
    { capture: true, passive: true },
  )
}

/** 向上找触摸目标最近的纵向滚动容器（overflow-y auto/scroll），供滚动检测。
 *  返回 null 表示目标不在可滚动容器内（长按不受滚动语义约束）。 */
export function findScrollContainer(el: EventTarget | null): HTMLElement | null {
  let node = el instanceof Element ? (el as HTMLElement) : null
  while (node) {
    const cs = window.getComputedStyle(node)
    if (/(auto|scroll|overlay)/.test(cs.overflowY)) return node
    node = node.parentElement
  }
  return null
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
  // 触摸起始时最近滚动容器及其 scrollTop：慢速拖动（位移 < cancelPx）时内容已
  // 滚动但位移未达取消阈值，靠 scrollTop 变化识别滚动手势。
  const scrollContainerRef = useRef<HTMLElement | null>(null)
  const scrollTopAtStartRef = useRef<number | null>(null)
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
    scrollContainerRef.current = null
    scrollTopAtStartRef.current = null
  }, [])

  // 卸载清理未触发的计时器
  useEffect(() => clear, [clear])

  const onTouchStart = useCallback(
    (e: TouchEvent) => {
      if (disabled) return
      const touch = e.touches[0]
      if (!touch) return
      clear()
      // 滚动刚结束（冷却期内）的触摸视为继续滚动/阅读，不启动长按计时——
      // 否则滚动停止后轻触静止会误触功能菜单，且菜单关闭后循环触发。
      if (Date.now() - lastScrollAt < SCROLL_COOLDOWN_MS) return
      const point = { x: touch.clientX, y: touch.clientY }
      startRef.current = point
      const container = findScrollContainer(e.target)
      scrollContainerRef.current = container
      scrollTopAtStartRef.current = container ? container.scrollTop : null
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
        return
      }
      // 慢速拖动：位移未超阈值但内容已滚动（scrollTop 变化）→ 视为滚动手势，
      // 即时取消长按。「滚动」与位移大小无关，滚动即取消是防止滑动上下文
      // 时手指停住误触功能菜单的关键。
      const container = scrollContainerRef.current
      if (
        container &&
        scrollTopAtStartRef.current !== null &&
        container.scrollTop !== scrollTopAtStartRef.current
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
