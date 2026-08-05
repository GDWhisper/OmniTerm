import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from './Modal'
import { PixelButton } from '../PixelUI/PixelButton'

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
   * 「暂时别提醒」之类）。配合 `checkboxLabel` 使用。
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
  /** 在 message 下方显示复选框的文案；不传则不显示复选框 */
  checkboxLabel?: string
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
  checkboxLabel,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const resolvedConfirmText = confirmText ?? t('modal.confirm')
  // 复选框本地受控状态；每次重新打开时重置为未勾选
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (open) setChecked(false)
  }, [open])

  const handleConfirm = () => {
    // 复选框模式（checkboxLabel 存在）才走 onConfirmWithChecked；否则维持既有 onConfirm 行为
    if (checkboxLabel && onConfirmWithChecked) onConfirmWithChecked(checked)
    else onConfirm?.()
  }

  return (
    <Modal open={open} onClose={onClose} title={title} maxWidth="max-w-sm">
      <p
        className={checkboxLabel ? 'text-sm mb-3' : 'text-sm mb-5'}
        style={{ color: 'var(--text-muted)', whiteSpace: 'pre-line' }}
      >{message}</p>
      {checkboxLabel && (
        <label
          className="flex items-center gap-2 mb-5 cursor-pointer select-none"
          style={{ color: 'var(--text-muted)', fontSize: 13 }}
        >
          <input
            type="checkbox"
            className="fm-checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>{checkboxLabel}</span>
        </label>
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
