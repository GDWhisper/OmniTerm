import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../../stores/appStore'
import { READER_FONT } from '../../utils/fonts'

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  /** Max width class, defaults to 'max-w-md' */
  maxWidth?: string
}

export function Modal({ open, onClose, title, children, maxWidth = 'max-w-md' }: ModalProps) {
  const uiZoom = useAppStore((s) => s.uiZoom)
  const zoomRatio = uiZoom / 100
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [open, onClose])

  if (!open) return null

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === backdropRef.current) onClose()
  }

  // Portal to document.body: the mobile strip (300%-wide pane carousel) uses
  // will-change/transform, which makes `position: fixed` resolve against the
  // strip instead of the viewport — modal would overflow the screen and clip
  // its action buttons (mobile regression, see docs/dev/debug-guide.md). Portaling keeps the
  // backdrop viewport-anchored on both desktop and mobile.
  return createPortal(
    <div
      ref={backdropRef}
      onClick={handleBackdropClick}
      className="fixed inset-0 z-50 flex items-center justify-center animate-fade-in"
      style={{ background: 'var(--modal-backdrop)' }}
    >
      <div
        className={`corner-nails pixel-float ${maxWidth} w-full mx-4 animate-scale-in`}
        style={{
          background: 'var(--bg-elevated)',
          borderRadius: 2,
          fontFamily: READER_FONT,
          zoom: zoomRatio,
        }}
      >
        <span className="nail-bl" />
        <span className="nail-br" />
        {/* Header — 与其他面板一致的木条标题（ui-style-guide §4） */}
        <div className="panel-title-bar">
          <span>◆</span>
          <h3 style={{ margin: 0, font: 'inherit' }}>{title}</h3>
          <span className="title-bar-spacer" />
          <button className="title-bar-collapse" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Body — `overflow-wrap: anywhere` 兜底无空格超长 token（文件路径、
            分支名、URL）：默认 `normal` 下它们不参与换行，会突破 max-w-*
            边框画到弹窗外面（layout-visual 模式 7）。放在 Modal 而非各弹窗，
            避免每个新弹窗重犯一次。 */}
        <div className="px-5 py-4" style={{ overflowWrap: 'anywhere' }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
