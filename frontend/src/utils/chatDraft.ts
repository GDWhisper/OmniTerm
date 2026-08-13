/**
 * 会话草稿存取（D7）。从 ChatInput 私有实现提取，供「引用到输入框」动作与
 * ChatInput 两处消费。基于 sessionStorage，按 sessionId 隔离。
 */

const DRAFT_PREFIX = 'omniterm_chat_draft:'
const draftKey = (sessionId: string) => `${DRAFT_PREFIX}${sessionId}`

/** Best-effort 读取：返回当前草稿文本，无草稿/存储不可用时返回空串。 */
export function getDraft(sessionId: string): string {
  try {
    return sessionStorage.getItem(draftKey(sessionId)) ?? ''
  } catch {
    return ''
  }
}

/** Best-effort 写入：存储失败（quota / private mode）时静默忽略。 */
export function saveDraft(sessionId: string, text: string) {
  try {
    sessionStorage.setItem(draftKey(sessionId), text)
  } catch {
    // Ignore storage errors (quota, private mode, etc.)
  }
}

/** Best-effort 删除。 */
export function deleteDraft(sessionId: string) {
  try {
    sessionStorage.removeItem(draftKey(sessionId))
  } catch {
    // Ignore storage errors
  }
}
