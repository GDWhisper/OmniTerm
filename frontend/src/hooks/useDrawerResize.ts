import { useEffect, useRef } from 'react'
import { clampDrawerHeight } from '../utils/drawer'
import { clampFileManagerWidth } from '../utils/layout'

/** 一次拖拽会话：指针身份 + 按下时的坐标与业务快照 */
interface DragSession<T> {
  pointerId: number
  startX: number
  startY: number
  snapshot: T
}

interface PointerDragOptions<T> {
  /** 拖拽期间 body 光标（'ns-resize' / 'nwse-resize'） */
  cursor: string
  /** 按下时生成业务快照（通常是按下那一刻的尺寸，避免逐帧累加漂移） */
  onStart: () => T
  /** 相对按下点的位移增量（dx 右为正，dy 下为正） */
  onMove: (snapshot: T, dx: number, dy: number) => void
  /** 松手/取消时调用一次（用于持久化），未发生位移则不调用 */
  onEnd?: (snapshot: T) => void
}

/**
 * Pointer Events 拖拽会话状态机（`useDrawerResize` / `useCornerResize` 共用）。
 *
 * 走 Pointer Events 而非 mouse 事件：mouse 事件在触摸设备上完全不派发，
 * 纯 mousedown 绑定 = 触摸屏无法拖动（2026-09 修复）。调用方元素须设
 * `touch-action: none`，否则浏览器会把手势当页面滚动。
 *
 * 回调经 ref 转发，window 监听只在挂载时注册一次，避免父组件每次渲染
 * 都反复 add/removeEventListener。
 *
 * @returns pointerdown 处理器；返回 true 表示拖拽已开始（调用方可据此初始化状态）
 */
function usePointerDrag<T>({ cursor, onStart, onMove, onEnd }: PointerDragOptions<T>) {
  const dragRef = useRef<DragSession<T> | null>(null)
  const cbRef = useRef({ cursor, onStart, onMove, onEnd })

  useEffect(() => {
    cbRef.current = { cursor, onStart, onMove, onEnd }
  })

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || e.pointerId !== drag.pointerId) return
      cbRef.current.onMove(drag.snapshot, e.clientX - drag.startX, e.clientY - drag.startY)
    }
    const onPointerEnd = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag || e.pointerId !== drag.pointerId) return
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      cbRef.current.onEnd?.(drag.snapshot)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerEnd)
    window.addEventListener('pointercancel', onPointerEnd)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerEnd)
      window.removeEventListener('pointercancel', onPointerEnd)
    }
  }, [])

  return (e: React.PointerEvent): boolean => {
    if (dragRef.current) return false // 已有指针在拖（多指触摸时第二指不接管）
    if (e.pointerType === 'mouse' && e.button !== 0) return false
    e.preventDefault()
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      snapshot: cbRef.current.onStart(),
    }
    document.body.style.cursor = cbRef.current.cursor
    document.body.style.userSelect = 'none'
    return true
  }
}

/**
 * 底部抽屉高度拖拽（DrawerShell 内部使用）。
 *
 * 提取自 FileDrawer/GitDrawer 的复制逻辑（2026-08-01 重构）：
 * pointerdown 记录起点 → window pointermove 计算增量（向上拖 = 变高）→
 * pointerup/pointercancel 释放。高度钳制见 `clampDrawerHeight`。
 *
 * 持久化由调用方在 `onCommit` 里做（松手一次写完），`onHeightChange` 只负责
 * 逐帧更新受控高度 —— 拖拽中用 useEffect 监听高度写 storage 会每帧落盘。
 */
export function useDrawerResize(
  height: number,
  onHeightChange: (height: number) => void,
  onCommit?: (height: number) => void,
) {
  const lastRef = useRef<number | null>(null)
  return usePointerDrag({
    cursor: 'ns-resize',
    onStart: () => {
      lastRef.current = null
      return height
    },
    onMove: (startHeight, _dx, dy) => {
      const next = clampDrawerHeight(startHeight - dy) // up = increase
      lastRef.current = next
      onHeightChange(next)
    },
    onEnd: () => {
      if (lastRef.current !== null) onCommit?.(lastRef.current)
    },
  })
}

interface CornerResizeOptions {
  /** 文件管理器宽度（按下那一刻由调用方从 store 取） */
  width: number
  /** 抽屉高度 */
  height: number
  /** 逐帧宽度回调（向左 = 变宽） */
  onWidthChange: (width: number) => void
  /** 逐帧高度回调（向上 = 变高） */
  onHeightChange: (height: number) => void
  /** 松手时回调最终尺寸（调用方在此持久化） */
  onCommit?: (width: number, height: number) => void
}

/**
 * DRAWER 左上角角标：一次拖拽同时改文件管理器宽度与抽屉高度。
 *
 * 方向语义与两个独立拖拽条完全一致 —— 向左 = 变宽（Layout 竖向条
 * `fileManagerWidth + startX - mvX`），向上 = 变高（`useDrawerResize`）。
 * 角标正好落在这两条拖拽条的交点上。
 *
 * 与 `useDrawerResize` 共用 `usePointerDrag`，只是每帧多算一个维度。
 */
export function useCornerResize({
  width,
  height,
  onWidthChange,
  onHeightChange,
  onCommit,
}: CornerResizeOptions) {
  const lastRef = useRef<{ width: number; height: number } | null>(null)
  return usePointerDrag({
    cursor: 'nwse-resize',
    onStart: () => {
      lastRef.current = null
      return { width, height }
    },
    onMove: (start, dx, dy) => {
      const next = {
        width: clampFileManagerWidth(start.width - dx), // left = wider
        height: clampDrawerHeight(start.height - dy), // up = taller
      }
      lastRef.current = next
      onWidthChange(next.width)
      onHeightChange(next.height)
    },
    onEnd: () => {
      const last = lastRef.current
      if (last) onCommit?.(last.width, last.height)
    },
  })
}
