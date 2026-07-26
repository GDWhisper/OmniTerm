import type { Session } from '../api/client'
import type { AttentionReason } from '../hooks/useAttention'

/**
 * 会话组的聚合状态（herdr 借鉴，见 docs/reference/herdr-reference.md）。
 * 优先级：blocked（有会话等待输入/决策/出错）> done（有完成未查看）> working > none。
 */
export type AggregateStatus = 'blocked' | 'done' | 'working' | 'none'

const PRIORITY: Record<AggregateStatus, number> = { blocked: 3, done: 2, working: 1, none: 0 }

export function sessionStatus(
  session: Session,
  reason: AttentionReason | undefined,
): AggregateStatus {
  if (session.agent_state === 'waiting' || reason === 'decision' || reason === 'error') {
    return 'blocked'
  }
  if (reason === 'done') return 'done'
  if (session.agent_state === 'running' || session.is_active) return 'working'
  return 'none'
}

export function aggregateStatus(
  sessions: Session[],
  reasonFor: (sessionKey: string) => AttentionReason | undefined,
): AggregateStatus {
  let result: AggregateStatus = 'none'
  for (const s of sessions) {
    const status = sessionStatus(s, reasonFor(s.id))
    if (PRIORITY[status] > PRIORITY[result]) result = status
    if (result === 'blocked') break
  }
  return result
}
