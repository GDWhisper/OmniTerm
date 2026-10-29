import { useEffect, useState } from 'react'

/**
 * 确认层里的复选框。三态由调用方算好传进来，组件只负责渲染与回传：
 *
 * - 普通型（`danger` 缺省）：muted 色，例如「暂时别提醒」；
 * - 危险型（`danger: true`）：**红字**，用于「附加的、不可逆的删除」这类
 *   默认不该替用户决定的操作（`acp 侧记录一并抹掉`）；
 * - 禁用型（`disabled: true`）：能力未确认 / 已知不支持时置灰 + `hint` 说明
 *   原因；禁用时恒为未勾选（不给用户「我勾了但它没生效」的错觉）。
 */
export interface ConfirmCheckbox {
  label: string
  /** 每次重新打开确认层时重置到的初始勾选状态，默认 false。 */
  defaultChecked?: boolean
  /** 红字危险样式（不可逆的附加删除）。 */
  danger?: boolean
  /** 禁用勾选（能力未知/不支持），并在 `hint` 里说明原因。 */
  disabled?: boolean
  /** 勾选框下方的说明小字（禁用原因 / 后果提示）。 */
  hint?: string
}

/**
 * 确认层的勾选状态。Modal 版的 ConfirmDialog 与锚定气泡版的 PopoverConfirm
 * 必须同语义——尤其是「记住上次选择」只由 defaultChecked 驱动：checkbox 是
 * 调用方每次渲染新建的字面量，整对象进依赖会把用户的勾选在父组件重渲染时
 * 冲掉。禁用态恒为未勾选，不给「勾了但后端会跳过」的误导。
 */
export function useConfirmCheckbox(open: boolean, checkbox?: ConfirmCheckbox) {
  const [checked, setChecked] = useState(false)
  useEffect(() => {
    if (open) setChecked(checkbox?.defaultChecked ?? false)
  }, [open, checkbox?.defaultChecked])

  return { checked: checkbox?.disabled ? false : checked, setChecked }
}
