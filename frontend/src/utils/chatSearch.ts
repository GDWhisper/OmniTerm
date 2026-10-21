/**
 * 会话内全文检索的前端调用层（F06，计划
 * `docs/dev/plans/2026-10-21-acp-chat-fulltext-search.md`）。
 *
 * 与 ChatView 里 `/messages` 的取页调用一样走裸 `fetch`（同一批接口、同一个后端
 * 路由族），但把类型、编解码与「命中词高亮切段」收在这里——组件只管交互。
 *
 * 检索口径的**真源在后端**（`src/acp/chat_persistence.rs` 的
 * `search_session_messages`）：LIKE 匹配、多词 AND、通配符转义、双扫描预算都在
 * 那边做，前端不重复实现任何一条（免得两边口径漂移）。
 */

/** 一条命中。`cursor` 是后端给的定位游标（`<created_at>|<id>`），前端不拆它。 */
export interface ChatSearchHit {
  /** 消息行 id（DB 主键）——与前端消息的 `dbId` 同值。 */
  id: string
  /** 角色（user / assistant；system 行不参与检索）。 */
  role: string
  /** 消息时刻（RFC3339, UTC）。 */
  createdAt: string
  /** 命中片段（后端已截断到首个命中词附近）。 */
  snippet: string
  /** 定位游标：请求「定位页」（`?at=`）时原样回传。 */
  cursor: string
}

/** 检索响应。预算相关的字段必须如实展示给用户（静默截断比搜不到更糟）。 */
export interface ChatSearchResponse {
  hits: ChatSearchHit[]
  /** 扫描窗口内命中的行数。 */
  matchCount: number
  /** 命中数超过返回上限——还有更多命中没列出来。 */
  moreMatches: boolean
  /** 实际参与检索的行数（预算触顶时小于会话总量）。 */
  scannedRows: number
  /** 实际参与检索的文本字节数。 */
  scannedBytes: number
  /** 预算触顶：更早的内容没有参与检索。 */
  truncated: boolean
  /** 关键词数超上限被截断。 */
  termsTruncated: boolean
}

/** 空结果（尚未检索 / 请求失败）。 */
export const EMPTY_CHAT_SEARCH: ChatSearchResponse = {
  hits: [],
  matchCount: 0,
  moreMatches: false,
  scannedRows: 0,
  scannedBytes: 0,
  truncated: false,
  termsTruncated: false,
}

/**
 * 检索会话内的消息。返回 `null` 表示请求失败（调用方按「无结果」处理——
 * 检索是旁路能力，失败不该打断聊天）。
 */
export async function searchSessionMessages(
  sessionId: string,
  query: string,
  signal?: AbortSignal,
): Promise<ChatSearchResponse | null> {
  const q = query.trim()
  if (!q) return null
  try {
    const r = await fetch(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/search?q=${encodeURIComponent(q)}`,
      { signal },
    )
    if (!r.ok) return null
    const data = (await r.json()) as Partial<ChatSearchResponse>
    return {
      hits: Array.isArray(data.hits) ? data.hits : [],
      matchCount: typeof data.matchCount === 'number' ? data.matchCount : 0,
      moreMatches: data.moreMatches === true,
      scannedRows: typeof data.scannedRows === 'number' ? data.scannedRows : 0,
      scannedBytes: typeof data.scannedBytes === 'number' ? data.scannedBytes : 0,
      truncated: data.truncated === true,
      termsTruncated: data.termsTruncated === true,
    }
  } catch {
    return null
  }
}

/**
 * 把命中片段按关键词切成「命中 / 非命中」段，供 UI 逐段高亮。
 *
 * 用正则切（而不是 `toLowerCase()` 后按字节找）——大小写折叠可能改变字符串长度
 *（如 'İ'.toLowerCase() 长度为 2），按字节找会错位。关键词来自用户输入，先转义
 * 再拼进正则，避免把正则元字符当语法。
 */
export function splitSnippet(
  snippet: string,
  terms: string[],
): { text: string; hit: boolean }[] {
  const needles = terms.map((t) => t.trim()).filter((t) => t.length > 0)
  if (needles.length === 0) return [{ text: snippet, hit: false }]
  const escaped = needles.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(${escaped.join('|')})`, 'gi')
  const out: { text: string; hit: boolean }[] = []
  let last = 0
  for (const m of snippet.matchAll(re)) {
    const start = m.index ?? 0
    if (start > last) out.push({ text: snippet.slice(last, start), hit: false })
    out.push({ text: m[0], hit: true })
    last = start + m[0].length
  }
  if (last < snippet.length) out.push({ text: snippet.slice(last), hit: false })
  return out.length > 0 ? out : [{ text: snippet, hit: false }]
}
