/**
 * 「删除会话时同时永久删除 agent 侧会话记录」勾选框的用户选择记忆。
 *
 * 存储格式：localStorage key `omniterm_delete_agent_side`，值为 `'true'` / `'false'`。
 *
 * 语义（为什么是「记忆」而不是「默认勾选」）：
 * - 这是**不可逆**的附加删除（agent 侧历史一并抹掉），默认值必须是用户自己的
 *   决定而非产品替他做的决定。首次使用（无记录）取 `false`——不勾选；
 * - 用户一旦明确勾选/取消，此后每次打开删除确认弹窗都沿用该选择，不再反复询问
 *   同一个问题（`fmOutsideSkip` 的同类思路：把「用户已经表达过的偏好」记住）。
 * - 只有在**确认删除**时写入：中途关闭弹窗不算表达偏好（避免误触被永久记住）。
 *
 * localStorage 在隐私模式 / 配额用尽时可能抛异常，所有读写均 try/catch 包裹，
 * 失败时静默降级为「不勾选」这一安全默认。
 */

const STORAGE_KEY = 'omniterm_delete_agent_side'

/** 用户上次的选择；无记录或存储不可用时为 false（不勾选）。 */
export function readDeleteAgentSidePref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** 记住用户本次的选择（幂等）。 */
export function writeDeleteAgentSidePref(checked: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, checked ? 'true' : 'false')
  } catch {
    // 隐私模式等场景写入失败：静默忽略，下次仍取安全默认。
  }
}
