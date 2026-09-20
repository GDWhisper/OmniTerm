/**
 * turnClock — 流式气泡的本地估算；模块级有界表 + 消费方定时直写 DOM，
 * 不进入 React state，不入库、不参与同步。定稿工作时长仍以后端 durationMs 为准。
 *
 * 工作 = 墙钟 − 审批挂起（见工作时长计划 E12）。速度只使用本连接观察到的
 * 输出 /（观察窗口工作时长 − 可识别的纯工具时间），按 4 字符 ≈ 1 token 折算。
 * 工具时间取并行执行区间的并集，仍包含在工作时长里。工具执行期间有正文或思考
 * 输出时，整个尚未闭合的工具并集保守地算回生成时间，直到所有工具结束。
 * ACP usage_update 无输出 token 字段，因此速度和工具时间都只是本地估算。
 */

interface LiveTurn {
  startedAt: number
  pausedMs: number
  waitSince: number | null
  /** 用工作时间作坐标，审批自然不进入工具并集，也不会被重复扣除。 */
  observationWorkMs: number
  outputChars: number
  activeTools: Set<string>
  toolSinceWorkMs: number | null
  toolMs: number
  pureToolMs: number
  toolHasOutput: boolean
  estimatesValid: boolean
}

/** 会话与定稿快照触顶时淘汰最旧条目，见 performance-and-safety.md §P1。 */
export const MAX_TRACKED_TURNS = 16
/** 只保留活跃 ID，完成即释放；同时限制单条 UTF-16 长度，避免只限条数不限体积。 */
export const MAX_ACTIVE_TURN_TOOLS = 256
export const MAX_TURN_TOOL_ID_LENGTH = 1024
const CHARS_PER_TOKEN = 4

const turns = new Map<string, LiveTurn>()
const finalBySession = new Map<string, { tps: number | null; toolMs: number | null }>()

/** 两张表共用插入序淘汰策略；替换同会话也更新它的新鲜度。 */
function rememberBounded<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  if (map.size >= MAX_TRACKED_TURNS) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

/** 整个 turn 的工作时长；服务端锚点可能在未来，故夹到零。 */
function workElapsedMs(turn: LiveTurn, now: number): number {
  const waiting = turn.waitSince === null ? 0 : Math.max(0, now - turn.waitSince)
  return Math.max(0, now - turn.startedAt - turn.pausedMs - waiting)
}

function openToolMs(turn: LiveTurn, now: number): number {
  return turn.toolSinceWorkMs === null ? 0 : Math.max(0, workElapsedMs(turn, now) - turn.toolSinceWorkMs)
}

function generationElapsedMs(turn: LiveTurn, now: number): number {
  const pureTools = turn.pureToolMs + (turn.toolHasOutput ? 0 : openToolMs(turn, now))
  return Math.max(0, workElapsedMs(turn, now) - turn.observationWorkMs - pureTools)
}

/** 无输出 / 无有效时长不渲染，非有限输入或溢出绝不返回 Infinity/NaN。 */
export function computeTps(outputChars: number, elapsedMs: number): number | null {
  if (!Number.isFinite(outputChars) || !Number.isFinite(elapsedMs) || outputChars <= 0 || elapsedMs <= 0) return null
  const tps = outputChars / CHARS_PER_TOKEN / (elapsedMs / 1000)
  return Number.isFinite(tps) ? tps : null
}

/** 开新 turn；默认从实际接收时刻观察。显式 startedAt 用于工作锚点或注入测试时间；
 * 接回快照后必须 resumeTurnClock，把本地采样窗口与回溯工作锚点分离。 */
export function beginTurn(sessionId: string, startedAt: number = Date.now()): void {
  finalBySession.delete(sessionId)
  rememberBounded(turns, sessionId, {
    startedAt, pausedMs: 0, waitSince: null, observationWorkMs: 0, outputChars: 0,
    activeTools: new Set<string>(), toolSinceWorkMs: null, toolMs: 0, pureToolMs: 0,
    toolHasOutput: false, estimatesValid: true,
  })
}

/** 快照 / 重连丢失了中间观测：保留工作表与审批态，清空所有本地输出、工具及定稿采样。 */
export function resumeTurnClock(sessionId: string, at: number = Date.now()): void {
  finalBySession.delete(sessionId)
  const turn = turns.get(sessionId)
  if (!turn) return
  turn.observationWorkMs = workElapsedMs(turn, at)
  turn.outputChars = 0
  turn.activeTools.clear()
  turn.toolSinceWorkMs = null
  turn.toolMs = 0
  turn.pureToolMs = 0
  turn.toolHasOutput = false
  turn.estimatesValid = true
}

/** 冻结同一时刻的工具与速度估算，再停表；重复结束不覆盖已经冻结的值。 */
export function endTurn(sessionId: string, at: number = Date.now()): void {
  const turn = turns.get(sessionId)
  if (!turn) return
  const tps = turnTps(sessionId, at)
  const toolMs = turnToolElapsedMs(sessionId, at)
  // 两项同时为 null 只可能是本窗口估算已失效：不留占位条目挤占上限，
  // 让 `finalTps`/`finalToolElapsedMs` 对「无读数」与「无快照」保持同一结果。
  if (tps === null && toolMs === null) finalBySession.delete(sessionId)
  else rememberBounded(finalBySession, sessionId, { tps, toolMs })
  turns.delete(sessionId)
}

/** 审批队列非空即挂起，重复同态幂等；turn 外的审批不跨轮泄漏。 */
export function setTurnWaiting(sessionId: string, waiting: boolean, at: number = Date.now()): void {
  const turn = turns.get(sessionId)
  if (!turn) return
  if (waiting && turn.waitSince === null) turn.waitSince = at
  else if (!waiting && turn.waitSince !== null) {
    turn.pausedMs += Math.max(0, at - turn.waitSince)
    turn.waitSince = null
  }
}

/** 只有显式执行状态才开始计时；缺省是 partial update，保持此前状态。
 * pending/未知状态不证明执行，不扣后续时间。溢出直接令本窗口估算失效并释放 ID，
 * 不能丢一条活跃工具后继续假装并集完整；下一 turn / resume 才重新采样。 */
export function updateTurnTool(sessionId: string, id: string, status?: string, at: number = Date.now()): void {
  const turn = turns.get(sessionId)
  if (!turn || !turn.estimatesValid || status === undefined) return
  if (status === 'in_progress' || status === 'running') {
    if (turn.activeTools.has(id)) return
    if (!id || id.length > MAX_TURN_TOOL_ID_LENGTH || turn.activeTools.size >= MAX_ACTIVE_TURN_TOOLS) {
      // 丢弃一条活跃工具后并集不再完整，本窗口估算整体作废（见 E14）；
      // 读数会静默消失，故留一条 DEV 诊断便于定位是哪条边界被踩到。
      if (import.meta.env.DEV) {
        console.debug('[turnClock] tool tracking overflow, estimates invalidated', {
          sessionId,
          activeToolCount: turn.activeTools.size,
          idLength: id.length,
        })
      }
      turn.estimatesValid = false
      turn.activeTools.clear()
      turn.toolSinceWorkMs = null
      return
    }
    if (turn.activeTools.size === 0) {
      turn.toolSinceWorkMs = workElapsedMs(turn, at)
      turn.toolHasOutput = false
    }
    turn.activeTools.add(id)
  } else if (turn.activeTools.delete(id) && turn.activeTools.size === 0) {
    const elapsed = openToolMs(turn, at)
    turn.toolMs += elapsed
    if (!turn.toolHasOutput) turn.pureToolMs += elapsed
    turn.toolSinceWorkMs = null
    turn.toolHasOutput = false
  }
}

/** 工作仍含工具，不含审批；null = 无在建 turn。 */
export function turnElapsedMs(sessionId: string, now: number = Date.now()): number | null {
  const turn = turns.get(sessionId)
  return turn ? workElapsedMs(turn, now) : null
}

/** 观察窗口内工具并集（扣审批）；null = 无 turn / 采样失效，0 = 尚未观察到执行。 */
export function turnToolElapsedMs(sessionId: string, now: number = Date.now()): number | null {
  const turn = turns.get(sessionId)
  if (!turn || !turn.estimatesValid) return null
  const elapsed = turn.toolMs + openToolMs(turn, now)
  return Number.isFinite(elapsed) ? elapsed : null
}

/** 正文与思考都算输出，turn 外或非法样本不计。只要当前工具并集内出现输出，
 * 整个开放并集（而非从 at 才开始）都算回生成时间，不能从工具通知推断 token 的生成起点。 */
export function addOutputChars(sessionId: string, count: number, at: number = Date.now()): void {
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(at)) return
  const turn = turns.get(sessionId)
  if (!turn || !turn.estimatesValid) return
  turn.outputChars += count
  if (turn.activeTools.size > 0) turn.toolHasOutput = true
}

/** 实时估算 tokens/s；分母仅扣有证据的纯工具时间，不能扣并行生成。 */
export function turnTps(sessionId: string, now: number = Date.now()): number | null {
  const turn = turns.get(sessionId)
  if (!turn || !turn.estimatesValid) return null
  return computeTps(turn.outputChars, generationElapsedMs(turn, now))
}

export function finalTps(sessionId: string): number | null {
  return finalBySession.get(sessionId)?.tps ?? null
}

export function finalToolElapsedMs(sessionId: string): number | null {
  return finalBySession.get(sessionId)?.toolMs ?? null
}

/** 测试隔离：清空活跃表及全部本地定稿快照。 */
export function clearTurnClock(): void {
  turns.clear()
  finalBySession.clear()
}

/** 测试会话上限。 */
export function trackedTurnCount(): number {
  return turns.size
}
