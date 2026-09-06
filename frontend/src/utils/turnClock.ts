/**
 * turnClock — 在建 turn 的前端实时计时（流式期间气泡底部「工作中 N秒」的数据源）。
 *
 * 为什么不放 chatStore：计时每秒跳一次，走 store 就是每秒替换 state → 整个消息列表
 * 重渲染（`ChatMessageView` 的 memo 契约靠 message 引用稳定维持）。计时器住在模块级
 * 表里，消费方用定时器直写 DOM，零 React 开销——与 `ThinkingIndicator` 同一手法。
 *
 * 口径（与后端结算对齐的**近似**，定稿后一律以后端值为准）：
 * `elapsed = (now - startedAt) - 审批挂起累计`。审批挂起取前端可见的 `pendingPermissions`
 * 队列，镜像后端 `TurnAccumulator` 的 `begin_wait`/`end_wait`（同一 turn 门控：无在建
 * turn 时 setTurnWaiting 是 no-op；新 turn 起点重置挂起，不因上一 turn 遗留的未决审批
 * 而暂停）。看不见的等待（agent 内部确认门不发 request_permission）两边都算工作时间，
 * 边界一致 —— 见 docs/dev/plans/archive/2026-08-30-acp-work-time.md §多实现行为差异。
 *
 * 本模块的值**不入库、不参与任何持久化/同步**：`prompt_done` 一到，后端结算的
 * `durationMs` 原位取代这里的读数（见 ChatMessage 的 meta 行）。
 */

interface LiveTurn {
  /** turn 起点的本地 epoch。只用差值，绝不当绝对时刻展示。 */
  startedAt: number
  /** 已闭合的审批挂起段之和（ms）。 */
  pausedMs: number
  /** 进行中审批挂起段的起点；不变式：`waitSince !== null` == 正在挂起。 */
  waitSince: number | null
}

/**
 * 同时追踪的会话上限（防无界累积红线，见 docs/dev/performance-and-safety.md §P1）。
 * 正常同一时刻只有一个在建 turn；触顶即 `endTurn` 漏调（异常拆连等），丢最旧条目——
 * 一个早已停表的旧 turn 不如新 turn 可信。
 */
export const MAX_TRACKED_TURNS = 16

const turns = new Map<string, LiveTurn>()

/** 开启（或重置）一个会话的在建计时。`startedAt` 允许由调用方回溯锚点：重连/刷新
 *  接回进行中的 turn 时，本地这一刻并非真实起点，用后端建行时刻补上。 */
export function beginTurn(sessionId: string, startedAt: number = Date.now()): void {
  if (!turns.has(sessionId) && turns.size >= MAX_TRACKED_TURNS) {
    const oldest = turns.keys().next().value
    if (oldest !== undefined) turns.delete(oldest)
  }
  turns.set(sessionId, { startedAt, pausedMs: 0, waitSince: null })
}

/** 结束并清除计时（turn 定稿 / 出错 / 会话结束）。 */
export function endTurn(sessionId: string): void {
  turns.delete(sessionId)
}

/**
 * 置审批挂起态：`waiting` false→true 起算一段，true→false 累加该段。
 * 无在建 turn 时 no-op（与后端 `begin_wait` 的 turn 门控同构，不跨 turn 泄漏一段等待）。
 */
export function setTurnWaiting(sessionId: string, waiting: boolean, at: number = Date.now()): void {
  const turn = turns.get(sessionId)
  if (!turn) return
  if (waiting && turn.waitSince === null) turn.waitSince = at
  else if (!waiting && turn.waitSince !== null) {
    turn.pausedMs += Math.max(0, at - turn.waitSince)
    turn.waitSince = null
  }
}

/** 本 turn 到目前为止的工作时长（ms）；`null` = 无在建 turn（调用方不渲染计时器）。 */
export function turnElapsedMs(sessionId: string, now: number = Date.now()): number | null {
  const turn = turns.get(sessionId)
  if (!turn) return null
  const waiting = turn.waitSince === null ? 0 : now - turn.waitSince
  // 夹到 0：锚点可能来自服务端时钟（hydrate 的 created_at），两端时钟不齐时会是未来时刻。
  return Math.max(0, now - turn.startedAt - turn.pausedMs - waiting)
}

/** 清空全部计时：仅供测试隔离用例间的模块状态。 */
export function clearTurnClock(): void {
  turns.clear()
}

/** 当前追踪的会话数：仅供测试守住 `MAX_TRACKED_TURNS` 这条上限。 */
export function trackedTurnCount(): number {
  return turns.size
}
