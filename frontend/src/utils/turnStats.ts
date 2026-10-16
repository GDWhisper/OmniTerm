/**
 * turnStats — 后端推送的进行中 turn 实时读数（WS `turn_stats` 帧）的本地缓存。
 *
 * 前端**只显示、不计算**：工作时长 / 工具耗时 / 输出速率（tps）的估算唯一真相源
 * 在后端 turn 累积器（`src/acp/turn_accumulator.rs`），由 WS 层以约 1Hz 推送；
 * 定稿读数随 `prompt_done` 下发并落库（`chat_messages.tool_ms` / `tps`），刷新后
 * 由 hydrate 常驻显示。2026-10-15 翻盘：旧实现 `utils/turnClock.ts` 在前端本地
 * 估算（E12–E20 的算法），存在「刷新即失、多标签页读数不一、重连重置观测窗」
 * 三类问题；算法整体迁到后端后前端退化为纯渲染（见 work-time 计划 E23）。
 *
 * 模块级有界表 + 订阅回调：读数到达时消费方（元信息行 / 收纳行）直写 DOM，
 * 不进 React state、不触发消息列表重渲染（同旧 turnClock 的「定时器直写 DOM」
 * 手法，差别只是驱动源从本地 interval 换成 WS 帧，且隐藏标签页不再受定时器
 * 节流影响）。
 */

export interface LiveTurnStats {
  /** 工作时长（ms）= 后端墙钟 − 审批等待。 */
  workMs: number
  /** 工具耗时估算（ms）；null = 跟踪越界失效（不渲染）。0 同样不渲染。 */
  toolMs: number | null
  /** 输出速率估算（tokens/s）；null = 无可测流式窗口（不渲染）。 */
  tps: number | null
}

/** 会话表上限（§P1 有界）：插入序淘汰最旧，与旧 turnClock 同款策略。 */
export const MAX_TRACKED_SESSIONS = 16

const bySession = new Map<string, LiveTurnStats>()
const listeners = new Map<string, Set<(stats: LiveTurnStats | null) => void>>()

/** 记入一帧实时读数（`turn_stats` 帧到达时调用），并同步全部订阅者。 */
export function setLiveTurnStats(sessionId: string, stats: LiveTurnStats): void {
  bySession.delete(sessionId)
  if (bySession.size >= MAX_TRACKED_SESSIONS) {
    const oldest = bySession.keys().next().value
    if (oldest !== undefined) bySession.delete(oldest)
  }
  bySession.set(sessionId, stats)
  const set = listeners.get(sessionId)
  if (set) for (const fn of set) fn(stats)
}

/** turn 结束 / 出错 / 会话重置：清掉读数并通知订阅者整格撤掉（传 null）。 */
export function clearLiveTurnStats(sessionId: string): void {
  bySession.delete(sessionId)
  const set = listeners.get(sessionId)
  if (set) for (const fn of set) fn(null)
}

export function getLiveTurnStats(sessionId: string): LiveTurnStats | null {
  return bySession.get(sessionId) ?? null
}

/** 订阅某会话的读数变化（挂载即回调当前值）。返回退订函数。 */
export function subscribeLiveTurnStats(
  sessionId: string,
  listener: (stats: LiveTurnStats | null) => void,
): () => void {
  let set = listeners.get(sessionId)
  if (!set) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(sessionId)
  }
}

/** 测试隔离：清空读数表与订阅表。 */
export function clearAllLiveTurnStats(): void {
  bySession.clear()
  listeners.clear()
}
