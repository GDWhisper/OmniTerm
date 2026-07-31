import { useCallback, useRef } from 'react'

/**
 * 流式内容滚动锚定（stick-to-bottom）。
 *
 * 用于「内容在 maxHeight + overflow 容器里流式增长」的组件（thinking 块、
 * 工具内容预览等）：默认钉住容器底部，用户上翻阅读时解除跟随，滚回底部
 * 自动恢复。
 *
 * 用法：
 * ```ts
 * const { containerRef, handleScroll, stickToBottom, resetStick } = useStickScroll<HTMLDivElement>()
 *
 * // 内容更新时（仅内容可能增长的阶段）钉底；active=false 时无操作
 * useLayoutEffect(() => {
 *   if (streaming) stickToBottom()
 * }, [text, open, streaming, stickToBottom])
 *
 * // 折叠会卸载容器、丢失滚动位置；重新展开时恢复跟随态
 * const toggle = () => { const next = !open; setOpen(next); if (next) resetStick() }
 * ```
 *
 * `stickToBottom` / `handleScroll` / `resetStick` 均稳定（useCallback deps 为空），
 * 可安全放入 effect 依赖数组而不触发多余运行。
 */
export function useStickScroll<T extends HTMLElement>() {
  const containerRef = useRef<T | null>(null)
  const stickRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }, [])

  const stickToBottom = useCallback(() => {
    if (!stickRef.current) return
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  const resetStick = useCallback(() => {
    stickRef.current = true
  }, [])

  return { containerRef, handleScroll, stickToBottom, resetStick }
}
