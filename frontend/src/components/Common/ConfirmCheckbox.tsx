import type { ConfirmCheckbox } from '../../hooks/useConfirmCheckbox'

/** 确认层里的复选框行（Modal 版 ConfirmDialog 与锚定气泡版 PopoverConfirm 共用）。 */
export function ConfirmCheckboxRow(props: {
  checkbox: ConfirmCheckbox
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  const { checkbox, checked, onChange } = props
  return (
    <>
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
          checked={checked}
          disabled={checkbox.disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {/* min-w-0：长文案（agent 会话 id 等）不撑破容器宽度 */}
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
    </>
  )
}
