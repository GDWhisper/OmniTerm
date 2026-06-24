import { useTranslation } from 'react-i18next'
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
  confirmText,
  destructive = false,
  loading = false,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const resolvedConfirmText = confirmText ?? t('modal.confirm')
  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="max-w-sm">
      <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>{message}</p>
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          disabled={loading}
          className="px-4 py-2 text-sm rounded-lg transition-all disabled:opacity-50"
          style={{ border: '1px solid var(--border-strong)', color: 'var(--text-muted)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'var(--accent-10)'
            e.currentTarget.style.borderColor = 'var(--accent)'
            e.currentTarget.style.color = 'var(--text-primary)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent'
            e.currentTarget.style.borderColor = 'var(--border-strong)'
            e.currentTarget.style.color = 'var(--text-muted)'
          }}
        >
          {t('modal.cancel')}
        </button>
        <button
          onClick={onConfirm}
          disabled={loading}
          className="px-4 py-2 text-sm rounded-lg text-white transition-all disabled:opacity-50"
          style={{
            background: destructive ? 'var(--danger)' : 'var(--accent)',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = destructive ? 'var(--danger)' : 'var(--accent-bright)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = destructive ? 'var(--danger)' : 'var(--accent)'
          }}
        >
          {loading ? t('modal.processing') : resolvedConfirmText}
        </button>
      </div>
    </Modal>
  )
}
