import type { ChatMessage, ContentBlock } from '../stores/chatStore'

/**
 * 「回到底部」提示条的纯逻辑。
 *
 * 聊天消息只会在末尾追加/增长（`appendChunk` 扩写末条、`upsertToolCall` 更新末条
 * 工具块、新消息 append），因此**只取末条消息**做内容指纹即可判定「下方有没有新
 * 内容」。不掺入 `messages.length`：上拉加载更早历史是**头部前插**，条数会变但末条
 * 不动——若把条数算进指纹，用户在顶部读历史时会误报「有新内容」。
 */

/** 单个 block 的轻量指纹：只用长度/状态等 O(1) 特征，绝不序列化正文（工具块可达数百 KB）。 */
function blockSignature(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
    case 'thought':
      return `${b.type}:${b.text.length}`
    case 'tool_call':
      // 状态与内容长度都要看：工具完成时正文可能不变，仅 status 推进。
      return `tool:${b.toolCallId}:${b.status}:${b.title?.length ?? 0}:${b.content?.length ?? 0}:${b.locations?.length ?? 0}`
    case 'plan':
      return `plan:${b.entries.length}:${b.entries.map((e) => e.status).join('')}`
    case 'todo':
      return `todo:${b.entries.length}`
    case 'system':
      return `sys:${b.label}`
    case 'image':
      return `img:${b.data.length}`
    case 'file':
      return `file:${b.name}:${b.size}`
  }
}

/**
 * 消息列表末条的内容指纹。空列表返回空串。
 * 相等即表示「末尾没有新内容到达」，是提示条显隐判定的唯一真源。
 *
 * 刻意不含 `streaming` 标志：turn 结束时 `markDone` 只把它翻 false，正文并没有
 * 新增——若算进指纹，用户上翻期间 turn 一收尾就会误报「下方有新内容」。
 */
export function chatTailSignature(messages: readonly ChatMessage[]): string {
  const last = messages[messages.length - 1]
  if (!last) return ''
  const blocks = last.blocks.map(blockSignature).join(',')
  return `${last.id}\u0000${last.text.length}\u0000${blocks}`
}

/**
 * 是否应显示「回到底部」提示条。
 *
 * 条件：用户已离开底部（`atBottom === false`）**且**末条内容指纹自离开底部时的已读
 * 基线（`seenSignature`）发生了变化。从未记录基线（`null`）时不显示——例如尚未贴底
 * 过，避免误报。贴底、无内容增长、仅头部前插更早历史都不触发。
 */
export function shouldShowJumpToBottom(
  atBottom: boolean,
  currentSignature: string,
  seenSignature: string | null,
): boolean {
  if (atBottom) return false
  if (seenSignature === null) return false
  return currentSignature !== seenSignature
}
