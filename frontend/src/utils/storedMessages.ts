/**
 * `GET /sessions/{id}/messages` 响应里的消息行（DB 行的 API 形态）。
 *
 * 单一真源：首屏 hydrate（`components/Chat/ChatView.tsx`）与会话级导出
 * （`utils/sessionExport.ts`）读的是同一个端点，字段形态必须一致——两份
 * interface 各写一遍迟早漂移（工程准则 7①）。
 *
 * 行 → `ChatMessage` 的转换（blocks 解码等）在 ChatView 内（`toChatMessages`）：
 * 它依赖 `hooks/useAcpChat.ts` 的 `decodeStoredBlocks`，而 `utils/` 不反向依赖
 * `hooks/`（前端分层：hooks → utils，见 docs/architecture/frontend.md）。
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
