import type { StoredMessage } from './storedMessages'

/**
 * 会话导出的数据获取与文件下载（计划 `2026-10-21-acp-session-markdown-export.md`）。
 *
 * 与 `utils/sessionMarkdown.ts` 的分工：那边负责**把消息序列化成文本**（纯函数），
 * 这边负责**把消息取全**与**把文本落成文件**（有副作用）。
 *
 * 全量拉取必须独立于 store（计划 D2）：`chatStore` 只有首屏那几页 + 用户上拉
 * 加载过的页，复用它会导出一份「看起来完整、其实缺了前半段」的导出件——
 * 那比不导出更糟。故这里循环 `?before=<cursor>` 把历史翻到底。
 */

/** 单页拉取条数（后端硬上限 `MESSAGES_PAGE_MAX_LIMIT` = 500，超出按 500 截）。 */
export const EXPORT_PAGE_LIMIT = 500

/** 最多拉取页数（§P1：分页循环必须有显式上限，否则异常实现能把后端拖住）。 */
export const MAX_EXPORT_PAGES = 200

/**
 * 单次导出允许拉取的原始载荷上限（字符数，UTF-16 code unit 计）。
 *
 * 为什么需要它：渲染后的导出件有独立的字节上限（8 MiB，见
 * `utils/sessionMarkdown.ts`），但**原始载荷通常远大于渲染结果**——工具输出在
 * 导出件里只留前 40 行，原始 blocks 里却是全文。不设这个上限时，一个
 * 「400MB 工具输出」的长会话会把 200 页 × 2MB 全部拉进浏览器内存（OOM），
 * 而这些数据里绝大部分最终会被渲染上限丢掉。
 *
 * 取 4× 于导出字节上限：原始载荷与渲染结果的比值通常在 2–3 倍（工具调用被
 * 摘要压掉大部分），留一倍余量可让「正常会话」不至于被提前截断。
 *
 * 触顶即停并标记 `truncated`——导出件头部与 toast 都会写明「更早的历史未包含」，
 * **不静默产出残缺文件**（计划 D2/D6）。
 */
export const EXPORT_MAX_PAYLOAD_CHARS = 32 * 1024 * 1024

export interface FetchAllMessagesOptions {
  /** fetch 注入（测试用）。 */
  fetchImpl?: typeof fetch
  /** 页大小，默认 [`EXPORT_PAGE_LIMIT`]（后端会再截一次）。 */
  pageLimit?: number
  /** 最多拉取页数，默认 [`MAX_EXPORT_PAGES`]。 */
  maxPages?: number
  /** 原始载荷上限（字符数），默认 [`EXPORT_MAX_PAYLOAD_CHARS`]。 */
  maxPayloadChars?: number
  /** 每页完成回调（进度提示用）。 */
  onProgress?: (loaded: number) => void
}

export interface FetchAllMessagesResult {
  /** 按时间正序（最早在前）的消息行。 */
  rows: StoredMessage[]
  /** 实际拉取的页数。 */
  pages: number
  /** 是否因页数/载荷上限截断（true = 更早的历史没拉全，导出件不完整）。 */
  truncated: boolean
}

/**
 * 拉取会话的**全部**历史消息（按时间正序）。
 *
 * 分页语义（后端 `chat_persistence::list_messages_page`）：每页**内部按时间正序**
 * （oldest-first），`nextCursor` 指向该页最旧一行的前一行；第一页是最新一页。
 * 故拼装时要把**页序**倒过来再展平——直接展平会得到「新页在前、旧页在后」的
 * 错序（页内正序 × 页序倒置 = 全局倒序）。
 */
export async function fetchAllMessages(
  sessionId: string,
  options: FetchAllMessagesOptions = {},
): Promise<FetchAllMessagesResult> {
  const {
    fetchImpl = fetch,
    pageLimit = EXPORT_PAGE_LIMIT,
    maxPages = MAX_EXPORT_PAGES,
    maxPayloadChars = EXPORT_MAX_PAYLOAD_CHARS,
    onProgress,
  } = options

  const base = `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`
  const pages: StoredMessage[][] = []
  let loaded = 0
  let payloadChars = 0
  let truncated = false
  let cursor: string | null = null

  for (let page = 0; page < maxPages; page++) {
    const url = cursor
      ? `${base}?before=${encodeURIComponent(cursor)}&limit=${pageLimit}`
      : `${base}?limit=${pageLimit}`
    const res = await fetchImpl(url)
    if (!res.ok) {
      throw new Error(`加载历史消息失败（HTTP ${res.status}）`)
    }
    const data = await res.json().catch(() => null)
    const rows: StoredMessage[] = Array.isArray(data?.messages) ? data.messages : []
    pages.push(rows)
    loaded += rows.length
    for (const row of rows) {
      payloadChars += row.text?.length ?? 0
      payloadChars += row.blocks?.length ?? 0
    }
    onProgress?.(loaded)

    const next = typeof data?.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null
    if (!next) break
    cursor = next
    // 还有更早的历史，但页数预算到了 → 导出件不完整，必须如实标记。
    if (page === maxPages - 1) truncated = true
    // 原始载荷预算到了：再往前拉的数据绝大多数会被渲染上限丢掉，却要把浏览器
    // 内存吃满 —— 停在这里并标记不完整（头部与 toast 都会写明）。
    if (payloadChars >= maxPayloadChars) {
      truncated = true
      break
    }
  }

  return { rows: pages.reverse().flat(), pages: pages.length, truncated }
}

/**
 * 导出文件名：`<会话显示名>.md`。
 *
 * 会话名由用户/agent 决定，可能含路径分隔符或控制字符——直接当文件名会被
 * 浏览器截断或写到意外位置，故做保守清洗（计划 D8：名字取
 * `utils/sessionDisplayName.ts` 单一真源，清洗只动文件名形态不改名字本身）。
 */
export function exportFileName(sessionName: string): string {
  const cleaned = sessionName
    .replace(/[\\/:*?"<>|]/g, '_')
    // 控制字符（含 DEL）逐字符剔除：正则写控制字符区间会被 eslint
    // no-control-regex 拦下，而这里只需要「剔掉不可见字符」这一件事。
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .trim()
  return `${cleaned || 'session'}.md`
}

/**
 * 触发浏览器下载（Blob → object URL → `<a download>`）。
 *
 * `URL.revokeObjectURL` 必须调用，否则 blob 一直驻留内存（§P1）。但**不能同步
 * revoke**：部分浏览器在 click 触发的下载真正开始读取 blob 之前就解析 URL，
 * 同步释放会让下载落空。故延后一拍（[`REVOKE_DELAY_MS`]）再释放。
 */
const REVOKE_DELAY_MS = 1000

export function downloadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
}
