import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Session } from '../../api/client'
import { IconListChecks, IconPencil } from '../FileManager/icons'

export interface ContextMenuPoint {
  x: number
  y: number
}

export interface SessionContextMenuState extends ContextMenuPoint {
  session: Session
}

/** 菜单宽度（px）：两项 + 图标 + padding 的下限，同时用于视口水平 clamp。 */
const MENU_WIDTH = 160
/** 菜单高度估算（2 项 × ~36px + padding + 边框），用于视口垂直 clamp。 */
const MENU_HEIGHT = 88
const VIEWPORT_MARGIN = 4

/**
 * 会话行上下文菜单（桌面右键 / 移动端长按共用）。状态由 Sidebar 持有并
 * 提升为单实例——菜单项「批量操作」需要进入选择模式并预选当前会话，
 * 属于 Sidebar 级状态。
 *
 * 关闭路径：全屏遮罩点击 / 触摸、Esc、动作执行后；遮罩与菜单自身的
 * `contextmenu` 也阻止默认，避免右键遮罩时弹出浏览器菜单。
 */
export function SessionContextMenu(props: {
  /** null = 不渲染菜单。 */
  menu: SessionContextMenuState | null
  onClose: () => void
  onBatchMode: (session: Session) => void
  onRename: (session: Session) => void
}) {
  const { t } = useTranslation()
  const { menu, onClose } = props

  useEffect(() => {
    if (!menu) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [menu, onClose])

  if (!menu) return null

  const x = Math.max(VIEWPORT_MARGIN, Math.min(menu.x, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN))
  const y = Math.max(VIEWPORT_MARGIN, Math.min(menu.y, window.innerHeight - MENU_HEIGHT - VIEWPORT_MARGIN))

  const items = [
    {
      id: 'batch',
      icon: <IconListChecks width={14} height={14} />,
      label: t('sidebar.batchMode'),
      run: () => props.onBatchMode(menu.session),
    },
    {
      id: 'rename',
      icon: <IconPencil width={14} height={14} />,
      label: t('sidebar.rename'),
      run: () => props.onRename(menu.session),
    },
  ]

  return createPortal(
    <>
      {/* 全屏遮罩：点击任意处关闭 */}
      <div
        style={{ position: 'fixed', inset: 0, zIndex: 199 }}
        onClick={onClose}
        onTouchStart={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div
        className="pixel-float"
        style={{
          position: 'fixed',
          left: x,
          top: y,
          zIndex: 200,
          minWidth: MENU_WIDTH,
          background: 'var(--bg-elevated)',
          padding: '4px 0',
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="context-menu-item"
            onClick={() => {
              item.run()
              onClose()
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </>,
    document.body,
  )
}
