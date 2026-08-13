import type { ChatMessage, ContentBlock } from '../stores/chatStore'

/**
 * 提取消息正文纯文本（复制正文 / 引用共用，避免两处实现 —— AGENTS §7.1）。
 *
 * 语义（见计划 §2 P0）：
 * - user 消息：`message.text`。
 * - assistant 消息：**所有 `text` 块**按出现顺序以 `\n\n` 拼接，忽略
 *   thought / tool_call / plan / todo / system / image —— 思考过程与工具日志
 *   属块级复制范畴，混进正文会让粘贴结果不可用。
 * - system 消息：返回空串（无正文可复制）。
 *
 * @returns 提取后的正文；assistant 无 text 块时返回 `''`。
 */
export function extractMessageText(message: ChatMessage): string {
  if (message.role === 'user') return message.text ?? ''
  if (message.role !== 'assistant') return ''

  const textParts = (message.blocks ?? []).filter(isTextBlock)
  if (textParts.length === 0) return ''
  return textParts.map((b) => b.text).join('\n\n')
}

function isTextBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> {
  return block.type === 'text'
}
