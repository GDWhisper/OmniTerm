import type { ChatMessage, ContentBlock, ImageBlock, ToolCallBlock } from '../stores/chatStore'
import { utf8Bytes } from './textBytes'

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
 * - **图片默认不渲染**（`images: 'omit'`）：剪贴板不该被 base64 撑爆
 *   （计划 `2026-10-21-acp-session-markdown-export.md` D5）。会话级导出传
 *   `images: 'inline'`（内联缩略图 data URI）或按剩余预算逐图决策的解析器
 *   （见 `utils/sessionMarkdown.ts`），两条路径共用本文件这一处渲染规则。
 *
 * 文案口径：标记（截断提示 / 图片占位 / 图片 alt）走 `markers` 参数，**默认
 * 中文**（既有单条复制行为逐字不变）；需要跟随界面语言的调用方经
 * `utils/markdownI18n.ts` 注入当前语言的版本——导出件与复制内容因此说同一种话。
 */

/** 图片渲染决策。 */
export type ImageRenderDecision = 'omit' | 'inline' | 'placeholder'

/**
 * 图片渲染决策来源：常量，或按「序号 + 内联渲染字节数」逐图决策的解析器。
 *
 * 解析器存在的意义：会话级导出要按**剩余字节预算**逐图决定「内联 data URI」
 * 还是「降级为占位符」（计划 D3）——这个判断需要导出器掌握全局预算，
 * 单条消息自己算不了，故由外部注入。序号为消息内序号（1 起）。
 */
export type ImageRenderResolver =
  | ImageRenderDecision
  | ((index: number, byteLength: number) => ImageRenderDecision)

/**
 * 导出件的**标记文案**（截断提示 / 图片占位 / 图片 alt）。
 *
 * 默认中文（[`DEFAULT_MARKERS`]）；界面语言版本由 `utils/markdownI18n.ts` 依据
 * i18n key 构造。序列化规则只有这一处，**文案**才需要分语言——两者不要混为一谈。
 */
export interface MessageMarkdownMarkers {
  /** 工具调用小节标题（如 `### 工具调用`）。 */
  toolCallsTitle: string
  /** 工具内容截断标记（参数 = 省略行数）。 */
  toolTruncated: (omittedLines: number) => string
  /** 图片未导出占位符（参数 = 图片序号，1 起）。 */
  imageOmitted: (index: number) => string
  /** 图片 alt 文本（参数 = 图片序号，1 起）。 */
  imageAlt: (index: number) => string
}

/** 默认标记文案（中文）——不传 `markers` 时的既有行为，逐字不变。 */
export const DEFAULT_MARKERS: MessageMarkdownMarkers = {
  toolCallsTitle: '### 工具调用',
  toolTruncated: (omittedLines) => `… (省略 ${omittedLines} 行)`,
  imageOmitted: (index) => `[图片 ${index}：未导出（超出体积上限）]`,
  imageAlt: (index) => `图片 ${index}`,
}

export interface MessageMarkdownOptions {
  /** agent 显示名（来自 capabilities 帧或会话关联 agents.display_name）。 */
  agentName?: string
  /** 单条工具内容最大行数，超出截断并标注。默认 40。 */
  maxToolLines?: number
  /** 测试注入用；默认取当前时刻。 */
  now?: Date
  /**
   * 图片渲染策略，默认 `'omit'`（图片块不渲染——既有单条复制行为逐字不变）。
   * `'inline'` 内联缩略图 data URI；`'placeholder'` 只留占位符行。
   */
  images?: ImageRenderResolver
  /** 标记文案，默认中文（[`DEFAULT_MARKERS`]）。 */
  markers?: MessageMarkdownMarkers
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

function truncateLines(text: string, maxLines: number, markers: MessageMarkdownMarkers): string {
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join('\n') + `\n${markers.toolTruncated(lines.length - maxLines)}`
}

function renderToolCall(block: ToolCallBlock, maxLines: number, markers: MessageMarkdownMarkers): string {
  // kind 可能是模糊 'other' 或缺省 —— 不强行展示误导性标签（§8）
  const kindLabel = block.kind && block.kind !== 'other' ? block.kind : 'tool'
  const title = block.kind && block.kind !== 'other' && block.title ? ` \`${block.title}\`` : ''
  const status = `${STATUS_ICONS[block.status] ?? '?'} ${block.status}`
  let md = `- **${kindLabel}**:${title} → ${status}`
  if (block.content) {
    md += `\n  \`\`\`text\n  ${truncateLines(block.content, maxLines, markers).replace(/\n/g, '\n  ')}\n  \`\`\``
  }
  return md
}

function isTextBlock(block: ContentBlock): block is Extract<ContentBlock, { type: 'text' }> {
  return block.type === 'text'
}

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === 'image'
}

/**
 * 图片内联 Markdown：`![<alt>](data:<mime>;base64,<data>)`。
 *
 * 取 `thumb ?? data`：落库时原图被换成缩略图（`chatStore.toPersistedBlocks`
 * 把 `data` 覆写成 `thumb.data`），故**已落库行里的 `data` 本身就是缩略图**；
 * live 未落库时 `data` 才是原图——thumb 优先可保证任何来源都取缩略图。
 */
function inlineImage(index: number, block: ImageBlock, markers: MessageMarkdownMarkers): string {
  const source = block.thumb ?? { data: block.data, mimeType: block.mimeType }
  return `![${markers.imageAlt(index)}](data:${source.mimeType};base64,${source.data})`
}

function renderImages(
  images: ImageBlock[],
  resolver: ImageRenderResolver,
  markers: MessageMarkdownMarkers,
): string {
  const decide = typeof resolver === 'function' ? resolver : () => resolver
  const parts: string[] = []
  images.forEach((block, i) => {
    const index = i + 1
    const md = inlineImage(index, block, markers)
    // 解析器拿到的是「内联渲染」的字节数——它据此判断装不装得下；
    // 决策为 placeholder 时实际占用的是占位符的字节数（由调用方自行核算）。
    const decision = decide(index, utf8Bytes(md))
    if (decision === 'omit') return
    parts.push(decision === 'placeholder' ? `> ${markers.imageOmitted(index)}` : md)
  })
  return parts.join('\n\n')
}

export function messageToMarkdown(message: ChatMessage, options: MessageMarkdownOptions = {}): string {
  const {
    agentName,
    maxToolLines = 40,
    now = new Date(),
    images = 'omit',
    markers = DEFAULT_MARKERS,
  } = options
  if (message.role === 'system') return ''

  const sections: string[] = []
  const header = [`## Agent: ${agentName || 'agent'}`, `## Turn: ${formatTurnTime(message.createdAt, now)}`]
  sections.push(header.join('\n'))

  const textParts = (message.blocks ?? []).filter(isTextBlock)
  // 无 content 的 tool_call 也保留摘要行（记录发生了哪次调用）
  const toolCalls = (message.blocks ?? []).filter(
    (b): b is ToolCallBlock => b.type === 'tool_call',
  )
  const imageBlocks = (message.blocks ?? []).filter(isImageBlock)

  if (textParts.length > 0) {
    sections.push(textParts.map((b) => b.text).join('\n\n'))
  }
  if (toolCalls.length > 0) {
    sections.push(
      `${markers.toolCallsTitle}\n${toolCalls.map((b) => renderToolCall(b, maxToolLines, markers)).join('\n')}`,
    )
  }
  if (imageBlocks.length > 0) {
    const rendered = renderImages(imageBlocks, images, markers)
    if (rendered) sections.push(rendered)
  }

  return sections.join('\n\n')
}
