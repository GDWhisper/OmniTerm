import { Modal } from './Modal'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  /** Text for the confirm button, defaults to '确认' */
  confirmText?: string
  /** Whether the action is destructive (red button), defaults to false */
  destructive?: boolean
  /** Loading state for the confirm button */
  loading?: boolean
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = '确认',
  destructive = false,
  loading = false,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="max-w-sm">
      <p className="text-sm mb-5" style={{ color: '#94a3b8' }}>{message}</p>
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={loading}
          className="px-4 py-2 text-sm rounded-lg transition-all disabled:opacity-50"
          style={{ border: '1px solid #334155', color: '#94a3b8' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(167,139,250,0.1)'
            e.currentTarget.style.borderColor = '#a78bfa'
            e.currentTarget.style.color = '#e2e8f0'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.borderColor = '#334155'
            e.currentTarget.style.color = '#94a3b8'
          }}
        >
          取消
        </button>
        <button
          onClick={onConfirm}
          disabled={loading}
          className="px-4 py-2 text-sm rounded-lg text-white transition-all disabled:opacity-50"
          style={{
            background: destructive ? '#ef4444' : '#a78bfa',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = destructive ? '#dc2626' : '#8b5cf6'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = destructive ? '#ef4444' : '#a78bfa'
          }}
        >
          {loading ? '处理中...' : confirmText}
        </button>
      </div>
    </Modal>
  )
}
