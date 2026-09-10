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
 *
 * 同一张表也承载 tps 估算：`addOutputChars` 累加本 turn 的 agent 输出字符数，
 * `turnTps` 给出流式实时读数，`endTurn` 把最终值快照进 `finalTpsBySession` 供定稿后展示。
 * ACP 无任何输出 token 字段（`usage_update` 只有上下文配额），故按 4 字符 ≈ 1 token 折算。
 */

interface LiveTurn {
  /** turn 起点的本地 epoch。只用差值，绝不当绝对时刻展示。 */
  startedAt: number
  /** 已闭合的审批挂起段之和（ms）。 */
  pausedMs: number
  /** 进行中审批挂起段的起点；不变式：`waitSince !== null` == 正在挂起。 */
  waitSince: number | null
  /** 本 turn 累计的输出字符数（agent text + thought）。仅用于估算 tps。 */
  outputChars: number
}

/**
 * 同时追踪的会话上限（防无界累积红线，见 docs/dev/performance-and-safety.md §P1）。
 * 正常同一时刻只有一个在建 turn；触顶即 `endTurn` 漏调（异常拆连等），丢最旧条目——
 * 一个早已停表的旧 turn 不如新 turn 可信。定稿 tps 快照同上限。
 */
export const MAX_TRACKED_TURNS = 16

/**
 * tps 估算口径：4 字符 ≈ 1 token。ACP 的 `usage_update` 只给上下文配额
 * （`used`/`size`/`cost`），没有任何输出 token 字段（见 docs/reference/acp-protocol-reference.md §6.7），
 * 故只能按字符数折算——这是**估算**，只渲染、不入库。
 */
const CHARS_PER_TOKEN = 4

const turns = new Map<string, LiveTurn>()

/** 定稿后的 tps 快照（sessionId → tokens/s）：turn 结束后「最终值」的唯一来源。
 *  与 `turns` 一样有界，`beginTurn`/`endTurn` 的淘汰策略对两者一致。 */
const finalTpsBySession = new Map<string, number>()

/** 有界写入：触顶且是新键时丢最旧条目（Map 保序 = 插入序）。 */
function rememberBounded(map: Map<string, number>, key: string, value: number): void {
  if (!map.has(key) && map.size >= MAX_TRACKED_TURNS) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

/** 本 turn 到目前为止的工作时长（ms）；不含审批挂起。调用方保证 turn 非空。 */
function workElapsedMs(turn: LiveTurn, now: number): number {
  const waiting = turn.waitSince === null ? 0 : now - turn.waitSince
  // 夹到 0：锚点可能来自服务端时钟（hydrate 的 created_at），两端时钟不齐时会是未来时刻。
  return Math.max(0, now - turn.startedAt - turn.pausedMs - waiting)
}

/**
 * 由「输出字符数 + 工作时长」算 tps 的纯函数。
 * 边界：无输出（chars ≤ 0）或零/负时长 → `null`（无法给出有意义的速率，调用方不渲染），
 * 绝不返回 `Infinity`/`NaN`。4 字符 ≈ 1 token（见 `CHARS_PER_TOKEN`）。
 */
export function computeTps(outputChars: number, elapsedMs: number): number | null {
  if (!(outputChars > 0) || !(elapsedMs > 0)) return null
  return outputChars / CHARS_PER_TOKEN / (elapsedMs / 1000)
}

/** 开启（或重置）一个会话的在建计时。`startedAt` 允许由调用方回溯锚点：重连/刷新
 *  接回进行中的 turn 时，本地这一刻并非真实起点，用后端建行时刻补上。 */
export function beginTurn(sessionId: string, startedAt: number = Date.now()): void {
  if (!turns.has(sessionId) && turns.size >= MAX_TRACKED_TURNS) {
    const oldest = turns.keys().next().value
    if (oldest !== undefined) turns.delete(oldest)
  }
  turns.set(sessionId, { startedAt, pausedMs: 0, waitSince: null, outputChars: 0 })
}

/**
 * 结束并清除计时（turn 定稿 / 出错 / 会话结束）。
 * 定稿前先把该 turn 的 tps 快照进 `finalTpsBySession`——`turns` 条目随删除消失，
 * 而「结束后仍要显示的最终 tps」需要一个不被清掉的落点（只读展示用，仍不入库）。
 * 0 输出 / 0 时长 → 快照置空（**不是**保留上一 turn 的旧值，否则旧值会错配到新消息行）。
 */
export function endTurn(sessionId: string, at: number = Date.now()): void {
  const turn = turns.get(sessionId)
  if (turn) {
    const tps = computeTps(turn.outputChars, workElapsedMs(turn, at))
    if (tps === null) finalTpsBySession.delete(sessionId)
    else rememberBounded(finalTpsBySession, sessionId, tps)
  }
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
  return workElapsedMs(turn, now)
}

/**
 * 累加本 turn 的输出字符数（agent text + thought 都算输出）。
 * 无在建 turn 时 no-op（与计时/挂起的 turn 门控同构，历史重放不计入）。
 * 只加正数：负值/NaN 会污染估算，直接丢弃。
 */
export function addOutputChars(sessionId: string, count: number): void {
  if (!(count > 0)) return
  const turn = turns.get(sessionId)
  if (!turn) return
  turn.outputChars += count
}

/** 本 turn 到此刻的实时 tps（tokens/s）；`null` = 无在建 turn 或无有效读数（不渲染）。 */
export function turnTps(sessionId: string, now: number = Date.now()): number | null {
  const turn = turns.get(sessionId)
  if (!turn) return null
  return computeTps(turn.outputChars, workElapsedMs(turn, now))
}

/** turn 定稿后保留的最终 tps 快照；`null` = 无（该 turn 无输出 / 无时长，或尚未定稿）。 */
export function finalTps(sessionId: string): number | null {
  return finalTpsBySession.get(sessionId) ?? null
}

/** 清空全部计时与定稿快照：仅供测试隔离用例间的模块状态。 */
export function clearTurnClock(): void {
  turns.clear()
  finalTpsBySession.clear()
}

/** 当前追踪的会话数：仅供测试守住 `MAX_TRACKED_TURNS` 这条上限。 */
export function trackedTurnCount(): number {
  return turns.size
}
