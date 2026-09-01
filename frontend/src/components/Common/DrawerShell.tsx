import { type ReactNode } from 'react'
import { useDrawerResize } from '../../hooks/useDrawerResize'

interface DrawerShellProps {
  /** 抽屉高度 px（受控） */
  height: number
  /** 拖拽高度回调（由调用方持久化） */
  onHeightChange: (height: number) => void
  /** 标题栏文案（.panel-title-bar，调用方负责 i18n） */
  title: string
  children: ReactNode
}

/**
 * 底部抽屉骨架：外层容器 + 木纹标题栏 + 高度拖拽条。
 * FileDrawer / GitDrawer 共享（2026-08-01 从两者复制逻辑提取）。
 * 调用方提供 header 行、内容区与状态栏。
 */
export function DrawerShell({ height, onHeightChange, title, children }: DrawerShellProps) {
  const handleDragStart = useDrawerResize(height, onHeightChange)
  return (
    <div
      style={{
        height,
        minHeight: 120,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border-strong)',
        flexShrink: 0,
      }}
    >
      <div className="panel-title-bar">
        <span>◆</span>
        <span>{title}</span>
      </div>

      {/* 高度拖拽条：视觉 6px，命中区经负边距扩到 22px（触摸目标），
          Pointer Events + touch-action: none 见 useDrawerResize / index.css */}
      <div className="drawer-drag-bar" onPointerDown={handleDragStart}>
        <div className="drawer-drag-grip" />
      </div>

      {children}
    </div>
  )
}
