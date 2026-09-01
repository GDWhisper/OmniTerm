import { useEffect, useRef } from 'react'
import { clampDrawerHeight } from '../utils/drawer'

/**
 * 底部抽屉高度拖拽状态机（DrawerShell 内部使用）。
 *
 * 提取自 FileDrawer/GitDrawer 的复制逻辑（2026-08-01 重构）：
 * pointerdown 记录起点 → window pointermove 计算增量（向上拖 = 变高）→
 * pointerup/pointercancel 释放。高度钳制见 `clampDrawerHeight`。
 * 持久化由调用方在 onHeightChange 里做（松手时写一次，避免高频
 * pointermove 写 storage）。
 *
 * 走 Pointer Events 而非 mouse 事件：mouse 事件在触摸设备上完全不派发，
 * 纯 mousedown 绑定 = 触摸屏无法拖动（2026-09 修复）。调用方元素须设
 * `touch-action: none`（见 DrawerShell），否则浏览器会把手势当页面滚动。
 */
export function useDrawerResize(height: number, onHeightChange: (height: number) => void) {
  const dragRef = useRef<{ pointerId: number; startY: number; startH: number } | null>(null)

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || e.pointerId !== drag.pointerId) return
      const delta = drag.startY - e.clientY // up = increase
      onHeightChange(clampDrawerHeight(drag.startH + delta))
    }
    const onPointerEnd = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || e.pointerId !== drag.pointerId) return
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerEnd)
    window.addEventListener('pointercancel', onPointerEnd)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerEnd)
      window.removeEventListener('pointercancel', onPointerEnd)
    }
  }, [onHeightChange])

  const handleDragStart = (e: React.PointerEvent) => {
    if (dragRef.current) return // 已有指针在拖（多指触摸时第二指不接管）
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    dragRef.current = { pointerId: e.pointerId, startY: e.clientY, startH: height }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }
  return handleDragStart
}
