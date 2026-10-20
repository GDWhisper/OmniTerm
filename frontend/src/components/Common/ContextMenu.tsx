import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuPoint {
  x: number
  y: number
}

export interface ContextMenuItem {
  id: string
  icon?: ReactNode
  label: string
  /** Red styling for irreversible actions (delete/drop/reset). */
  danger?: boolean
  run: () => void
}

/** Menu width floor in px; also drives the horizontal viewport clamp. */
const MENU_MIN_WIDTH = 160
/** Per-item height estimate (padding + 13px reader font) for the vertical clamp.
 *  40px keeps the historical 2-item menu estimate at 88px (SessionContextMenu
 *  tests pin that value). */
const ITEM_HEIGHT = 40
const MENU_PADDING = 8
const VIEWPORT_MARGIN = 4

/**
 * Portal context menu shared by desktop right-click and touch long-press.
 *
 * The caller owns the anchor point and items; this component only handles the
 * single-instance overlay, Esc/outside-click dismissal and viewport clamping
 * (ui-style-guide §6.3, z-index 199/200).
 */
export function ContextMenu(props: {
  point: ContextMenuPoint | null
  items: ContextMenuItem[]
  onClose: () => void
  minWidth?: number
}) {
  const { point, items, onClose } = props
  const minWidth = props.minWidth ?? MENU_MIN_WIDTH

  useEffect(() => {
    if (!point) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [point, onClose])

  if (!point) return null

  const x = Math.max(VIEWPORT_MARGIN, Math.min(point.x, window.innerWidth - minWidth - VIEWPORT_MARGIN))
  const menuHeight = items.length * ITEM_HEIGHT + MENU_PADDING
  const y = Math.max(VIEWPORT_MARGIN, Math.min(point.y, window.innerHeight - menuHeight - VIEWPORT_MARGIN))

  return createPortal(
    <>
      {/* Full-screen transparent overlay: any click/touch dismisses the menu. */}
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
          minWidth,
          background: 'var(--bg-elevated)',
          padding: '4px 0',
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`context-menu-item ${item.danger ? 'context-menu-item-danger' : ''}`}
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
