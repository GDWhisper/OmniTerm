import { useTranslation } from 'react-i18next'
import { Modal } from './Modal'
import { PixelButton } from '../PixelUI/PixelButton'

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
        <PixelButton variant="secondary" onClick={onClose} disabled={loading}>
          {t('modal.cancel')}
        </PixelButton>
        <PixelButton
          variant={destructive ? 'danger' : 'primary'}
          onClick={onConfirm}
          disabled={loading}
        >
          {loading ? t('modal.processing') : resolvedConfirmText}
        </PixelButton>
      </div>
    </Modal>
  )
}
