import type { ChatMessage } from '../stores/chatStore'
import { messageToMarkdown, DEFAULT_MARKERS, type MessageMarkdownMarkers } from './messageMarkdown'
import { utf8Bytes } from './textBytes'

/**
 * 会话级 Markdown 导出（计划 `2026-10-21-acp-session-markdown-export.md`）。
 *
 * 复用单条 `messageToMarkdown` 逐条拼接（计划 D1：单一真源，两条导出路径
 * 格式必然一致），本模块只负责**会话级**的三件事：
 *
 * 1. 头部说明（导出时刻 / 图片口径 / thinking 不导出 / 工具内容截断 / 省略量）——
 *    导出件会脱离 OmniTerm 独立流通，缺了这几行用户会在几周后把「缺图」「缺思考」
 *    当成 bug（计划 D6）。
 * 2. 条数 + 字节双上限（计划 D4）：两个独立增长轴（一条 1 字符的 system 行 vs
 *    一条 1MiB 的工具输出），只限条数等于没限。触顶即停并**显式标注省略量**——
 *    静默截断会让用户以为导出的是完整会话。
 * 3. 图片按剩余预算逐图决策（计划 D3）：内联缩略图 data URI，装不下的降级为
 *    占位符（缺失可见，不静默丢图）。
 *
 * 纯函数：不触网、不读 store。消息由调用方提供（`utils/sessionExport.ts` 负责
 * 独立分页拉全量——不复用 store 已 hydrate 的页，见计划 D2）。
 */

/** 导出消息条数上限（§P1：条数是无界增长轴，必须有显式上限 + 超限策略）。 */
export const MAX_EXPORT_MESSAGES = 2000

/** 导出正文体积上限（UTF-8 字节）。 */
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024

/**
 * 导出件的**文案**（头部说明 + 正文标记）。
 *
 * 默认中文（[`DEFAULT_SESSION_LABELS`]）——纯函数模块不依赖 react-i18next，
 * 以便在非组件上下文里复用与单测（口径同 `utils/sessionDisplayName.ts`）；
 * 界面语言版本由 `utils/markdownI18n.ts` 依 i18n key 构造后注入。
 */
export interface SessionMarkdownLabels {
  /** 正文标记文案（工具调用小节 / 截断提示 / 图片占位与 alt）。 */
  markers: MessageMarkdownMarkers
  /** 标题行（参数 = 会话显示名）。 */
  title: (sessionName: string) => string
  /** 导出时刻行（参数 = 已格式化的时刻）。 */
  exportedAt: (time: string) => string
  /** 消息条数行（历史完整；参数 = 纳入条数 / 候选总数）。 */
  messageCount: (included: number, total: number) => string
  /** 消息条数行（历史在拉取阶段即被截断；参数 = 纳入条数）。 */
  messageCountTruncated: (included: number) => string
  /** 说明小节标题。 */
  notesTitle: string
  /** 说明行：图片只有缩略图。 */
  noteImages: string
  /** 说明行：thinking 不导出。 */
  noteThinking: string
  /** 说明行：工具输出截断行数（参数 = 行数）。 */
  noteToolLimit: (maxToolLines: number) => string
  /** 说明行：因体积上限未内联的图片数（参数 = 张数）。 */
  noteImagesOmitted: (count: number) => string
  /** 省略提示（参数 = 省略条数 / 体积估算）。 */
  omitted: (count: number, size: string) => string
}

/** 默认文案（中文）——不传 `labels` 时的既有行为。 */
export const DEFAULT_SESSION_LABELS: SessionMarkdownLabels = {
  markers: DEFAULT_MARKERS,
  title: (sessionName) => `# 会话导出：${sessionName || '未命名会话'}`,
  exportedAt: (time) => `导出时间：${time}`,
  messageCount: (included, total) => `消息条数：${included}（共 ${total} 条）`,
  messageCountTruncated: (included) => `消息条数：${included}（更早的历史未包含，导出不完整）`,
  notesTitle: '> 说明',
  noteImages: '> - 图片以内联缩略图导出（原图未落库，无法还原）',
  noteThinking: '> - 思考过程（thinking）不导出',
  noteToolLimit: (maxToolLines) => `> - 工具调用输出最多保留前 ${maxToolLines} 行`,
  noteImagesOmitted: (count) => `> - ${count} 张图片因体积上限未内联（已标注为占位符）`,
  omitted: (count, size) =>
    `> 已省略较早的 ${count} 条消息（约 ${size}）——受导出条数/体积上限限制。`,
}

export interface SessionMarkdownOptions {
  /** agent 显示名（沿用单条导出口径）。 */
  agentName?: string
  /** 会话显示名（头部与文件名用；取 `utils/sessionDisplayName.ts` 单一真源）。 */
  sessionName?: string
  /** 工具内容最大行数（沿用单条导出口径，默认 40）。 */
  maxToolLines?: number
  /** 消息条数上限，默认 [`MAX_EXPORT_MESSAGES`]。 */
  maxMessages?: number
  /** 正文体积上限（UTF-8 字节，不含头部），默认 [`MAX_EXPORT_BYTES`]。 */
  maxBytes?: number
  /**
   * 拉取阶段就停了（历史更长）——头部必须写明「更早的历史未包含」，
   * 否则「共 N 条」会被读成「这个会话一共 N 条」（静默失真，计划 D2/D6）。
   */
  historyTruncated?: boolean
  /** 文案（头部说明 + 正文标记），默认中文（[`DEFAULT_SESSION_LABELS`]）。 */
  labels?: SessionMarkdownLabels
  /** 导出时刻（测试注入用；默认取当前时刻）。 */
  now?: Date
}

export interface SessionMarkdownResult {
  /** 完整 Markdown（头部 + 正文）。 */
  markdown: string
  /** 纳入导出的消息条数。 */
  includedMessages: number
  /** 因上限被省略的消息条数（省略的是**较早**的部分）。 */
  omittedMessages: number
  /** 因体积预算不足降级为占位符的图片数。 */
  degradedImages: number
  /** 正文 UTF-8 字节数（不含头部）。 */
  bytes: number
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatTimestamp(now: Date): string {
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  )
}

/** 字节数的人类可读形态（KB / MB，保留一位小数）。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 导出件头部。
 *
 * 写明四件用户事后会误判的事：① 导出时刻（会话仍在流式时，导出的是这一刻
 * 已落库的内容）② 图片只有缩略图 ③ thinking 不导出 ④ 工具输出按 N 行截断；
 * 以及上限触顶时的省略量。
 */
function buildHeader(
  opts: {
    sessionName?: string
    now: Date
    included: number
    total: number
    omitted: number
    omittedBytes: number
    degradedImages: number
    maxToolLines: number
    historyTruncated: boolean
  },
  labels: SessionMarkdownLabels,
): string {
  const lines: string[] = []
  lines.push(labels.title(opts.sessionName ?? ''))
  lines.push('')
  lines.push(labels.exportedAt(formatTimestamp(opts.now)))
  // 拉取阶段就停了 → 不能写「共 N 条」（会被读成会话一共 N 条）。
  lines.push(
    opts.historyTruncated
      ? labels.messageCountTruncated(opts.included)
      : labels.messageCount(opts.included, opts.total),
  )
  lines.push('')
  lines.push(labels.notesTitle)
  lines.push(labels.noteImages)
  lines.push(labels.noteThinking)
  lines.push(labels.noteToolLimit(opts.maxToolLines))
  if (opts.degradedImages > 0) {
    lines.push(labels.noteImagesOmitted(opts.degradedImages))
  }
  if (opts.omitted > 0) {
    lines.push('')
    lines.push(labels.omitted(opts.omitted, formatBytes(opts.omittedBytes)))
  }
  return lines.join('\n')
}

/**
 * 会话消息 → Markdown 文本。
 *
 * @param messages **按时间正序**（最早在前）的消息；与导出件的行序一致。
 *   超出上限时保留**最新**的一段（用户当下关心的是最近的对话），省略较早的部分。
 */
export function sessionToMarkdown(
  messages: readonly ChatMessage[],
  options: SessionMarkdownOptions = {},
): SessionMarkdownResult {
  const {
    agentName,
    sessionName,
    maxToolLines = 40,
    maxMessages = MAX_EXPORT_MESSAGES,
    maxBytes = MAX_EXPORT_BYTES,
    historyTruncated = false,
    labels = DEFAULT_SESSION_LABELS,
    now = new Date(),
  } = options

  // 候选集：排除 system（宿主内部事件标签，非对话内容——计划 D7）与流式中的行
  // （库里 status='streaming'，尚未定稿；导出的是「已落库那一刻」的内容）。
  const candidates = messages.filter((m) => m.role !== 'system' && !m.streaming)

  // 选消息：从最新往回选，直到条数/字节上限。
  // 先渲染一次（图片置 omit）拿基础字节——图片另走独立预算池（见下），
  // 故这里量到的是「正文 + 工具摘要」的体积。
  const selected: ChatMessage[] = []
  let baseBytes = 0
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (selected.length >= maxMessages) break
    const message = candidates[i]
    const base = messageToMarkdown(message, {
      agentName,
      maxToolLines,
      now,
      images: 'omit',
      markers: labels.markers,
    })
    if (!base) continue
    const size = utf8Bytes(base)
    // 至少保留一条：单条就超预算时也要给出内容（与后端分页「至少一行」同取舍）。
    if (selected.length > 0 && baseBytes + size > maxBytes) break
    baseBytes += size
    selected.push(message)
  }
  selected.reverse()

  // 渲染：图片预算池 = 上限减去正文占用。按时间正序分配，装不下的图降级为占位符。
  let imageBudget = Math.max(0, maxBytes - baseBytes)
  let degradedImages = 0
  const parts: string[] = []
  for (const message of selected) {
    const md = messageToMarkdown(message, {
      agentName,
      maxToolLines,
      now,
      markers: labels.markers,
      images: (_index, byteLength) => {
        if (byteLength <= imageBudget) {
          imageBudget -= byteLength
          return 'inline'
        }
        degradedImages++
        return 'placeholder'
      },
    })
    if (md) parts.push(md)
  }
  const body = parts.join('\n\n')

  // 被省略的部分：条数精确；字节为**估算**——按 `text` 列长度代理（工具输出在
  // blocks 列里，不在 text 列，故工具重的消息会被低估；正文里标「约」）。
  const selectedSet = new Set(selected)
  const omitted = candidates.filter((m) => !selectedSet.has(m))
  const omittedBytes = omitted.reduce((sum, m) => sum + utf8Bytes(m.text ?? ''), 0)

  const header = buildHeader(
    {
      sessionName,
      now,
      included: selected.length,
      total: candidates.length,
      omitted: omitted.length,
      omittedBytes,
      degradedImages,
      maxToolLines,
      historyTruncated,
    },
    labels,
  )

  return {
    markdown: body ? `${header}\n\n${body}` : header,
    includedMessages: selected.length,
    omittedMessages: omitted.length,
    degradedImages,
    bytes: utf8Bytes(body),
  }
}
