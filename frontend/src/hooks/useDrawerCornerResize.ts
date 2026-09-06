import { useAppStore } from '../stores/appStore'
import { useCornerResize } from './useDrawerResize'

interface DrawerCornerResize {
  /** 角标是否可用：移动端走 MobileLayout，没有可拖的面板宽度（竖向拖拽条同样不渲染） */
  enabled: boolean
  onPointerDown: (e: React.PointerEvent) => void
}

/**
 * DRAWER 左上角角标的 store 胶水层：把「文件管理器宽度」与「抽屉高度」
 * 这两个分居不同组件树的尺寸接到一次拖拽上（纯拖拽数学在 `useCornerResize`）。
 *
 * 宽度：拖拽中直改 `fileManagerEl.style.width`，与 Layout 的竖向拖拽条同策略，
 * 规避逐帧 store 更新引发整棵布局（含终端/聊天）重渲染；松手才写 store +
 * localStorage。高度：逐帧交给调用方更新受控 state，松手由 `onHeightCommit`
 * 落盘。
 */
export function useDrawerCornerResize(
  height: number,
  onHeightChange: (height: number) => void,
  onHeightCommit?: (height: number) => void,
): DrawerCornerResize {
  const isMobile = useAppStore((s) => s.isMobile)
  const fileManagerOpen = useAppStore((s) => s.fileManagerOpen)
  const fileManagerCollapsed = useAppStore((s) => s.fileManagerCollapsed)
  const fileManagerWidth = useAppStore((s) => s.fileManagerWidth)
  const setIsResizing = useAppStore((s) => s.setIsResizing)

  const startDrag = useCornerResize({
    width: fileManagerWidth,
    height,
    onWidthChange: (width) => {
      const el = useAppStore.getState().fileManagerEl
      if (el) el.style.width = `${width}px`
    },
    onHeightChange,
    onCommit: (width, height) => {
      setIsResizing(false)
      useAppStore.getState().setFileManagerWidth(width)
      localStorage.setItem('omniterm_fm_width', String(width))
      onHeightCommit?.(height)
    },
  })

  return {
    enabled: !isMobile && fileManagerOpen && !fileManagerCollapsed,
    onPointerDown: (e: React.PointerEvent) => {
      // 角标是 drag-bar 的子节点，不截断就会同时启动纯高度拖拽会话
      e.stopPropagation()
      // 拖拽期间关掉文件管理器的 width transition，否则宽度补间会滞后于指针
      if (startDrag(e)) setIsResizing(true)
    },
  }
}
