import type { Session } from '../api/client'
import type { AttentionReason } from '../hooks/useAttention'

/**
 * 会话组的聚合状态（herdr 借鉴，见 docs/reference/herdr-reference.md）。
 * 优先级：blocked（有会话等待输入/决策/出错）> done（有完成未查看）> working > none。
 */
export type AggregateStatus = 'blocked' | 'done' | 'working' | 'none'

/**
 * ACP 会话的派生活动状态（来自 chatStore：pendingPermission → waiting、sending → running）。
 * tmux 会话的对应物是后端屏幕检测的 agent_state；两条链路在此归一，保证 UI 表现一致。
 */
export type AcpActivity = 'running' | 'waiting'

const PRIORITY: Record<AggregateStatus, number> = { blocked: 3, done: 2, working: 1, none: 0 }

export function sessionStatus(
  session: Session,
  reason: AttentionReason | undefined,
  acpActivity?: AcpActivity,
): AggregateStatus {
  const state = session.runtime_kind === 'acp' ? acpActivity : session.agent_state
  if (state === 'waiting' || reason === 'decision' || reason === 'error') {
    return 'blocked'
  }
  if (reason === 'done') return 'done'
  if (state === 'running' || session.is_active) return 'working'
  return 'none'
}

export function aggregateStatus(
  sessions: Session[],
  reasonFor: (sessionKey: string) => AttentionReason | undefined,
  acpActivityFor?: (sessionId: string) => AcpActivity | undefined,
): AggregateStatus {
  let result: AggregateStatus = 'none'
  for (const s of sessions) {
    const status = sessionStatus(s, reasonFor(s.id), acpActivityFor?.(s.id))
    if (PRIORITY[status] > PRIORITY[result]) result = status
    if (result === 'blocked') break
  }
  return result
}
