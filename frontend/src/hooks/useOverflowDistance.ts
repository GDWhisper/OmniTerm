import { useLayoutEffect, useState, type RefObject } from 'react'

/**
 * 测量「内容比可视宽度多出多少像素」——横向滚动才能看全的那部分。
 *
 * 判据是「内容元素宽 - 视口宽」，不用视口的 scrollWidth：scrollWidth 会
 * 把 transform 平移后的溢出算进去（滚动动画进行中量到的是被平移的值），
 * offsetWidth 是布局宽、不受 transform 影响。
 *
 * 用途是渐隐 + 滚动的溢出提示（侧栏会话标题、聊天配置栏当前值共用）：
 * 多出的宽度即滚动距离；0 表示内容放得下——此时既不该挂遮罩，也不该滚动。
 *
 * @param viewportRef 裁剪视口（overflow:hidden）
 * @param contentRef  视口内的内容元素（不换行，宽度 = 完整文案宽）
 * @param contentKey  内容标识：内容变了宽度会变，必须重测
 */
export function useOverflowDistance(
  viewportRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  contentKey: string,
): number {
  const [distance, setDistance] = useState(0)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const measure = () => {
      const next = Math.max(0, content.offsetWidth - viewport.clientWidth)
      // ±1px 抖动不重渲染（亚像素舍入、滚动条出现/消失都会造成抖动）
      setDistance((prev) => (Math.abs(prev - next) <= 1 ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    observer.observe(content)
    return () => observer.disconnect()
  }, [viewportRef, contentRef, contentKey])

  return distance
}
