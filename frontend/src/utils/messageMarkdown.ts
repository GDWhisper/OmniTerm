import type { ChatMessage, ContentBlock, ToolCallBlock } from '../stores/chatStore'

/**
 * 单条消息 → Markdown（D5「复制为 Markdown」）。
 *
 * 格式（方案 §3 D5）：
 * ```markdown
 * ## Agent: demo-agent
 * ## Turn: 12:34:56
 *
 * 正文第一段…
 *
 * 正文第二段…
 *
 * ### 工具调用
 * - **execute**: `cargo build` → ✓ completed
 *     ```text
 *     <content 前 40 行，超出截断>
 *     ```
 * ```
 *
 * 规则：
 * - text 块按序拼接（`\n\n` 连接）。
 * - tool_call 只列 kind/title/status + content 前 `maxToolLines` 行；kind 缺失或
 *   为模糊 `'other'` 时降级显示 title / 'tool'（§8：不把某实现的字段习惯当事实）。
 * - thought 默认省略（思考过程不属于导出正文）。
 * - diff / 长工具内容一律截断到前 N 行——取原样文本由块级复制（P1）覆盖。
 */

export interface MessageMarkdownOptions {
  /** agent 显示名（来自 capabilities 帧或会话关联 agents.display_name）。 */
  agentName?: string
  /** 单条工具内容最大行数，超出截断并标注。默认 40。 */
  maxToolLines?: number
  /** 测试注入用；默认取当前时刻。 */
  now?: Date
}

const STATUS_ICONS: Record<ToolCallBlock['status'], string> = {
  running: '…',
  completed: '✓',
  failed: '✗',
  updating: '↻',
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatTurnTime(ms: number, now: Date): string {
  const d = new Date(ms)
  const sameDay =
    now.getFullYear() === d.getFullYear() &&
    now.getMonth() === d.getMonth() &&
    now.getDate() === d.getDate()
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (sameDay) return hm
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join('\n') + `\n… (省略 ${lines.length - maxLines} 行)`
}

function renderToolCall(block: ToolCallBlock, maxLines: number): string {
  // kind 可能是模糊 'other' 或缺省 —— 不强行展示误导性标签（§8）
  const kindLabel = block.kind && block.kind !== 'other' ? block.kind : 'tool'
  const title = block.kind && block.kind !== 'other' && block.title ? ` \`${block.title}\`` : ''
  const status = `${STATUS_ICONS[block.status] ?? '?'} ${block.status}`
  let md = `- **${kindLabel}**:${title} → ${status}`
  if (block.content) {
    md += `\n  \`\`\`text\n  ${truncateLines(block.content, maxLines).replace(/\n/g, '\n  ')}\n  \`\`\``
  }
  return md
}

function isTextBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> {
  return block.type === 'text'
}

export function messageToMarkdown(message: ChatMessage, options: MessageMarkdownOptions = {}): string {
  const { agentName, maxToolLines = 40, now = new Date() } = options
  if (message.role === 'system') return ''

  const sections: string[] = []
  const header = [`## Agent: ${agentName || 'agent'}`, `## Turn: ${formatTurnTime(message.createdAt, now)}`]
  sections.push(header.join('\n'))

  const textParts = (message.blocks ?? []).filter(isTextBlock)
  // 无 content 的 tool_call 也保留摘要行（记录发生了哪次调用）
  const toolCalls = (message.blocks ?? []).filter(
    (b): b is ToolCallBlock => b.type === 'tool_call',
  )

  if (textParts.length > 0) {
    sections.push(textParts.map((b) => b.text).join('\n\n'))
  }
  if (toolCalls.length > 0) {
    sections.push(`### 工具调用\n${toolCalls.map((b) => renderToolCall(b, maxToolLines)).join('\n')}`)
  }

  return sections.join('\n\n')
}
