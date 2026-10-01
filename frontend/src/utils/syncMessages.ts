import type { SyncMessagePayload } from '../stores/chatStore'

/**
 * 前端 → 后端 `/sessions/{id}/messages/sync` 写回的唯一入口。
 *
 * 从 `useAcpChat` 的内部 `postSync` 提取：聚焦补拉合并（ChatView）与 hook 内的
 * turn 定稿回写 / replay 对齐回写 / hydrate RAW 收敛是四类不同触发点，但请求形状、
 * 错误容错（`.catch(() => {})`——写回失败不打断交互，下次 hydrate 仍会收敛）与
 * DEV 日志口径必须同一份（AGENTS §7①；改动请求语义只应改一处）。
 *
 * 语义要点（后端 `chat_persistence::sync_messages`）：载荷带 `id` 只 UPDATE 那一行
 * 的 blocks、匹配不上跳过；无 `id` 走 (session, role, text) 文本匹配，匹配不上
 * INSERT。调用方对「无 id 路径」的任何使用都必须先读 2026-08-18 幽灵行计划——
 * 该路径在文本语义漂移时会产生重复行。
 */
export function postSyncPayload(sessionId: string, payload: SyncMessagePayload[]): void {
  if (payload.length === 0) return
  if (import.meta.env.DEV) {
    console.debug('[ACP sync]', payload.length, 'msgs,', payload.reduce((n, p) => n + p.text.length, 0), 'chars')
  }
  fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: payload }),
  }).catch(() => {})
}
