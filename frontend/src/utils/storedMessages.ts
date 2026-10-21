import {
  dropInlinedSystemMessages,
  type ChatMessage,
  type ContentBlock,
} from '../stores/chatStore'

/**
 * `GET /sessions/{id}/messages` 响应里的消息行（DB 行的 API 形态）。
 *
 * 单一真源：首屏 hydrate（`components/Chat/ChatView.tsx`）与会话级导出
 * （`hooks/useSessionExport.ts`）读的是同一个端点，字段形态必须一致——两份
 * interface 各写一遍迟早漂移（工程准则 7①）。
 */
export interface StoredMessage {
  id: string
  role: string
  text: string
  createdAt: string
  blocks?: string | null
  status?: string | null
  /** turn 工作时长 / 等审批时长（ms）；null = 无记录（迁移前的历史行）。 */
  durationMs?: number | null
  waitMs?: number | null
  /** 工具耗时（ms）与输出速率（tokens/s）估算；null = 无读数（历史行 / 跟踪失效 /
   *  无可测流式窗口）。 */
  toolMs?: number | null
  tps?: number | null
  /** turn 定稿时刻（RFC3339）；null = 无记录（迁移前的历史行），该段不渲染。 */
  finishedAt?: string | null
}

/**
 * blocks 列的解码器。
 *
 * 为什么是**注入**的：真正的解码器 `decodeStoredBlocks` 住在
 * `hooks/useAcpChat.ts`（原始帧包裹要经重放分类器还原，见该文件
 * `rawFramesToBlocks`），而 `utils/` 不反向依赖 `hooks/`（前端分层：hooks →
 * utils）。故本模块只声明形状，由调用方（组件 / hook）传入真解码器——
 * 强制每个调用点显式给出，不会有人悄悄用了个「近似版」解码。
 */
export type StoredBlocksDecoder = (raw: string, fullText?: string) => ContentBlock[] | null

/** 判定已 parse 的值是否为后端累积器的原始帧包裹形态（`{"v":1,"frames":[...]}`）。 */
export function isFrameWrapperParsed(parsed: unknown): boolean {
  return !!parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['frames'])
}

/**
 * 判定 blocks 字符串是否为后端累积器的原始帧包裹（`{"v":1,"frames":[...]}`）。
 *
 * `decodeStoredBlocks` 会把包裹解码成 cooked blocks，解码后无法反推来源——
 * hydrate 转换（`toChatMessages`）用此判定标记 RAW 残留行，方案 B 据此做带 id
 * 的 cooked 回写（见 2026-08-18 计划 P0）。
 */
export function isRawFrameWrapper(raw: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  return isFrameWrapperParsed(parsed)
}

/**
 * DB 行 → `ChatMessage`。首屏 hydrate、上拉分页与会话级导出共用同一转换，避免
 * 三份平行的 blocks 解码/兜底逻辑跑偏。blocks 解不出结构时回退纯文本（text 列
 * 超长会被后端折叠成头尾 + 「已省略 N 字符」标记，故兜底文本可能不完整，但一定可读）。
 */
export function toChatMessages(
  rows: StoredMessage[],
  decode: StoredBlocksDecoder,
): ChatMessage[] {
  const messages = rows.map((m) => {
    // rawStored：blocks 来源为后端原始帧包裹（{"v":1,"frames":[...]}）且解码出
    // 非空结构。useAcpChat 在 hydrate 落定后据此做带 dbId 的 cooked 回写收敛残留
    // 体积（见 2026-08-18 计划方案 B）。解码失败/为空的 RAW 行不标记——回写纯文本
    // 兜底会覆盖后端原始帧，堵死未来分类器升级后重新解释历史的路径。
    let rawStored = m.blocks ? isRawFrameWrapper(m.blocks) : false
    // text 列传给解码器：RAW 帧窗口行的 blocks 可能缺被驱逐的早期正文，
    // 解码时用全量 text 补前缀（见 useAcpChat.prependEvictedProse）。
    let blocks = m.blocks ? decode(m.blocks, m.text) : null
    if (!blocks || blocks.length === 0) {
      blocks = [{ type: 'text' as const, text: m.text }]
      rawStored = false
    }
    return {
      id: m.id,
      // Hydrated rows carry their real DB id, so a later sync can target them exactly.
      dbId: m.id,
      // system 行（权限超时回收告知等）由后端写入，hydrate 后以 system 消息渲染。
      role: m.role as ChatMessage['role'],
      text: m.text,
      blocks,
      rawStored,
      createdAt: new Date(m.createdAt).getTime(),
      // 进行中 turn 的行以 streaming 还原，供 turn_snapshot / live 帧无缝续接。
      streaming: m.status === 'streaming',
      // 定稿读数读自 DB：turn 定稿时后端已结算（工作时长 / 工具耗时 / 速率 /
      // 定稿时刻），刷新后仍在（前端不自算），历史行各自显示自己那一轮的值。
      durationMs: m.durationMs,
      waitMs: m.waitMs,
      toolMs: m.toolMs,
      tps: m.tps,
      finishedAt: m.finishedAt,
    }
  })

  // mid-turn SYSTEM 告知双轨落盘：assistant 行内联一份有序帧（供正确排序），
  // 独立 system 行一份兜底（帧窗口驱逐后仍可回读）。assistant 行能解出同
  // noticeId 时过滤独立行；解不出（帧被逐出 / 旧数据）则保留独立行——数据不丢，
  // 只是回落到列表位置。收口逻辑与分页/合并共用同一函数。
  return dropInlinedSystemMessages(messages)
}
