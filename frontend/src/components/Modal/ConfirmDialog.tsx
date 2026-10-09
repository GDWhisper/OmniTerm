import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from './Modal'
import { PixelButton } from '../PixelUI/PixelButton'

/**
 * 确认弹窗里的复选框。三态由调用方算好传进来，组件只负责渲染与回传：
 *
 * - 普通型（`danger` 缺省）：muted 色，例如「暂时别提醒」；
 * - 危险型（`danger: true`）：**红字**，用于「附加的、不可逆的删除」这类
 *   默认不该替用户决定的操作（`acp 侧记录一并抹掉`）；
 * - 禁用型（`disabled: true`）：能力未确认 / 已知不支持时置灰 + `hint` 说明
 *   原因；禁用时恒为未勾选（不给用户「我勾了但它没生效」的错觉）。
 */
export interface ConfirmCheckbox {
  label: string
  /** 每次重新打开弹窗时重置到的初始勾选状态，默认 false。 */
  defaultChecked?: boolean
  /** 红字危险样式（不可逆的附加删除）。 */
  danger?: boolean
  /** 禁用勾选（能力未知/不支持），并在 `hint` 里说明原因。 */
  disabled?: boolean
  /** 勾选框下方的说明小字（禁用原因 / 后果提示）。 */
  hint?: string
}

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
  // 复选框本地受控状态；每次重新打开时重置为调用方给的初始值
  // （「记住用户上次选择」就是靠这个 defaultChecked 传进来的）
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (open) setChecked(checkbox?.defaultChecked ?? false)
    // 依赖只列 `checkbox?.defaultChecked`（不列整个 checkbox 对象）：checkbox 是
    // 调用方每次渲染新建的字面量，整对象进依赖会把用户的勾选在父组件重渲染时
    // 冲掉；初值只由 defaultChecked 决定，这样「记住上次选择」才稳定。
  }, [open, checkbox?.defaultChecked])

  // 禁用态恒为未勾选：能力未确认时不给「勾了但后端会跳过」的误导
  const effectiveChecked = checkbox?.disabled ? false : checked

  const handleConfirm = () => {
    // 复选框模式（checkbox 存在）才走 onConfirmWithChecked；否则维持既有 onConfirm 行为
    if (checkbox && onConfirmWithChecked) onConfirmWithChecked(effectiveChecked)
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
          <label
            className={`flex items-start gap-2 select-none ${checkbox.disabled ? '' : 'cursor-pointer'}`}
            style={{
              color: checkbox.danger ? 'var(--danger)' : 'var(--text-muted)',
              fontSize: 13,
              opacity: checkbox.disabled ? 0.55 : 1,
            }}
          >
            <input
              type="checkbox"
              className="fm-checkbox"
              // flex 子项默认按 min-content 参与收缩：不给 flex-shrink:0 时
              // 长文案会把勾选框压扁（ui-style-guide §3.6 的同类约定）
              style={{ accentColor: checkbox.danger ? 'var(--danger)' : 'var(--accent)', flexShrink: 0, marginTop: 2 }}
              checked={effectiveChecked}
              disabled={checkbox.disabled}
              onChange={(e) => setChecked(e.target.checked)}
            />
            {/* min-w-0：长文案（agent 会话 id 等）不撑破弹窗宽度 */}
            <span style={{ minWidth: 0 }}>{checkbox.label}</span>
          </label>
          {checkbox.hint && (
            <p
              className="mt-1"
              style={{ color: 'var(--text-muted)', fontSize: 11, paddingLeft: 22 }}
            >
              {checkbox.hint}
            </p>
          )}
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
