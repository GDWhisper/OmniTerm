import { useEffect, useRef, type ReactNode } from 'react'
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

  return (
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

        {/* Body */}
        <div className="px-5 py-4">
          {children}
        </div>
      </div>
    </div>
  )
}
