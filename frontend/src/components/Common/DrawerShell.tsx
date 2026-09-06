import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useDrawerResize } from '../../hooks/useDrawerResize'
import { useDrawerCornerResize } from '../../hooks/useDrawerCornerResize'

interface DrawerShellProps {
  /** 抽屉高度 px（受控） */
  height: number
  /** 拖拽高度回调（由调用方持久化） */
  onHeightChange: (height: number) => void
  /** 拖拽松手时回调一次最终高度（调用方在此落盘，避免逐帧写 storage） */
  onHeightCommit?: (height: number) => void
  /** 标题栏文案（.panel-title-bar，调用方负责 i18n） */
  title: string
  children: ReactNode
}

/**
 * 底部抽屉骨架：外层容器 + 木纹标题栏 + 高度拖拽条。
 * FileDrawer / GitDrawer 共享（2026-08-01 从两者复制逻辑提取）。
 * 调用方提供 header 行、内容区与状态栏。
 *
 * 左上角角标（`.drawer-corner-grip`）同时拖文件管理器宽度与抽屉高度：本项目的
 * 抽屉都挂在右侧面板内（FileDrawer/GitDrawer），而宽度拖拽条就贴在该面板左缘，
 * 两者的交点正好是抽屉左上角。移动端无宽度概念，角标不渲染。
 */
export function DrawerShell({ height, onHeightChange, onHeightCommit, title, children }: DrawerShellProps) {
  const { t } = useTranslation()
  const handleDragStart = useDrawerResize(height, onHeightChange, onHeightCommit)
  const corner = useDrawerCornerResize(height, onHeightChange, onHeightCommit)
  return (
    <div
      className={corner.enabled ? 'has-drawer-corner-grip' : undefined}
      style={{
        position: 'relative',
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
          Pointer Events + touch-action: none 见 useDrawerResize / index.css。
          角标不在 bar 内部——见下方 .drawer-corner-grip，独立锚在标题栏左上角 */}
      <div className="drawer-drag-bar" onPointerDown={handleDragStart}>
        <div className="drawer-drag-grip" />
      </div>

      {/* 左上角角标：锚在抽屉容器的绝对定位角落——标题栏内部最左上，
          落在深棕色背景上对比度高（深木纹 + 浅色描边），与高度条
          物理分离（不在 .drawer-drag-bar 内），不再视觉重叠。
          z-index 高于 .drawer-drag-bar 即可拦截左上命中 */}
      {corner.enabled && (
        <div
          className="drawer-corner-grip"
          onPointerDown={corner.onPointerDown}
          title={t('drawer.resizeCorner')}
          aria-label={t('drawer.resizeCorner')}
        >
            {/* 两条平行 / 斜线（//），沿角落延伸、顶到边框，纯视觉指示。
               14×14 viewBox 与 .drawer-corner-grip 同尺寸：path 直接顶到容器边框 */}
            <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
              <path
                d="M1 9 L9 1 M5 13 L13 5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
        </div>
      )}

      {children}
    </div>
  )
}
