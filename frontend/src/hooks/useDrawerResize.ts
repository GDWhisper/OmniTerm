import { useEffect, useRef } from 'react'

/**
 * 底部抽屉高度拖拽状态机（DrawerShell 内部使用）。
 *
 * 提取自 FileDrawer/GitDrawer 的复制逻辑（2026-08-01 重构）：
 * mousedown 记录起点 → window mousemove 计算增量（向上拖 = 变高）→
 * mouseup 释放。高度钳制在 [120, innerHeight-60]。持久化由调用方在
 * onHeightChange 里做（松手时写一次，避免高频 mousemove 写 storage）。
 */
export function useDrawerResize(height: number, onHeightChange: (height: number) => void) {
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - e.clientY // up = increase
      const newH = Math.max(120, Math.min(window.innerHeight - 60, dragRef.current.startH + delta))
      onHeightChange(newH)
    }
    const onMouseUp = () => {
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [onHeightChange])

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: height }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }
  return handleDragStart
}
