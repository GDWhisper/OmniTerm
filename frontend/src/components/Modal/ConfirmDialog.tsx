import { useTranslation } from 'react-i18next'
import { Modal } from './Modal'
import { PixelButton } from '../PixelUI/PixelButton'
import { ConfirmCheckboxRow } from '../Common/ConfirmCheckbox'
import { useConfirmCheckbox, type ConfirmCheckbox } from '../../hooks/useConfirmCheckbox'

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  /**
   * 确认回调（无复选框场景）。传了 `onConfirmWithChecked` 时以它为准，
   * 此回调仅用于兼容既有调用点。
   */
  onConfirm?: () => void
  /**
   * 带复选框的确认回调：参数为复选框勾选状态（true = 用户勾选了
   * 「暂时别提醒」/「同时删除…」之类）。配合 `checkbox` 使用；
   * 禁用态恒为 false。
   */
  onConfirmWithChecked?: (checked: boolean) => void
  title: string
  message: string
  /** Text for the confirm button, defaults to '确认' */
  confirmText?: string
  /** Whether the action is destructive (red button), defaults to false */
  destructive?: boolean
  /** Loading state for the confirm button */
  loading?: boolean
  /** 在 message 下方显示复选框；不传则不显示 */
  checkbox?: ConfirmCheckbox
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  onConfirmWithChecked,
  title,
  message,
  confirmText,
  destructive = false,
  loading = false,
  checkbox,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const resolvedConfirmText = confirmText ?? t('modal.confirm')
  const { checked, setChecked } = useConfirmCheckbox(open, checkbox)

  const handleConfirm = () => {
    // 复选框模式（checkbox 存在）才走 onConfirmWithChecked；否则维持既有 onConfirm 行为
    if (checkbox && onConfirmWithChecked) onConfirmWithChecked(checked)
    else onConfirm?.()
  }

  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="max-w-sm">
      <p
        className={checkbox ? 'text-sm mb-3' : 'text-sm mb-5'}
        style={{ color: 'var(--text-muted)', whiteSpace: 'pre-line' }}
      >{message}</p>
      {checkbox && (
        <div className="mb-5">
          <ConfirmCheckboxRow checkbox={checkbox} checked={checked} onChange={setChecked} />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <PixelButton variant="secondary" onClick={onClose} disabled={loading}>
          {t('modal.cancel')}
        </PixelButton>
        <PixelButton
          variant={destructive ? 'danger' : 'primary'}
          onClick={handleConfirm}
          disabled={loading}
        >
          {loading ? t('modal.processing') : resolvedConfirmText}
        </PixelButton>
      </div>
    </Modal>
  )
}
