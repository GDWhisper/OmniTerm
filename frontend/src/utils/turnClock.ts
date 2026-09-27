/**
 * turnClock — 流式气泡的本地估算；模块级有界表 + 消费方定时直写 DOM，
 * 不进入 React state，不入库、不参与同步。定稿工作时长仍以后端 durationMs 为准。
 *
 * 工作 = 墙钟 − 审批挂起（见工作时长计划 E12）。速度只使用本连接观察到的
 * 输出 / 解码窗口时长，按 4 字符 ≈ 1 token 折算。工具时间取并行执行区间的并集，
 * 仍包含在工作时长里。工具并集内**首次出现输出的那一刻**把「工具起点 → 此刻」
 * 封口为纯工具时间：生成计时钟从此处暂停，直到下次流式吐字；封口之后的区间仍在
 * 工具内，但算生成时间（那段确实是模型在产出）。整段都没有输出的工具窗口则全额
 * 计为工具时间。
 * 解码窗口从本观察窗**首个输出**起算：首字前的等待（prompt 处理 / 长思考，
 * 没有任何输出）不进分母——否则首字延迟越长读数越被摊薄（E17 对齐
 * deepseek-harness 的 decode-only 口径）。首输出瞬间窗口长度为 0 → 读数 null。
 * 重连只重开观测窗（输出归零、开放并集丢弃），已闭合的工具段是真实观测，跨重连保留。
 * ACP usage_update 无输出 token 字段，因此速度和工具时间都只是本地估算。
 */

interface LiveTurn {
  startedAt: number
  pausedMs: number
  waitSince: number | null
  outputChars: number
  activeTools: Set<string>
  toolSinceWorkMs: number | null
  /** 已闭合的工具并集时长（展示值；开放并集的当前跨度另算，见 `turnToolElapsedMs`）。 */
  toolMs: number
  /** 已闭合的工具并集时长里「可算纯工具」的那部分；跨重连保留，配合
   *  `pureToolMsAtFirst` 基线只扣首字之后新闭合的段。 */
  pureToolMs: number
  /** 本窗口首个输出出现时的工作坐标；null = 还没吐字，没有可测的解码窗口。 */
  firstOutputWorkMs: number | null
  /** 首输出那一刻的已扣纯工具基线：更早的闭合段与同刻封口段都不进新分母。 */
  pureToolMsAtFirst: number
  /** 开放并集内已封口为纯工具的那段；0 = 整段仍待定（还没出现过输出）。 */
  toolPureOpenMs: number
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

/** 开放工具并集的完整跨度（展示口径：含封口之后仍在执行的那段）。 */
function openToolMs(turn: LiveTurn, now: number): number {
  return turn.toolSinceWorkMs === null ? 0 : Math.max(0, workElapsedMs(turn, now) - turn.toolSinceWorkMs)
}

/** 开放并集里可算纯工具的那段：没出现过输出 → 整段都是；出现过 → 只到封口处。 */
function pureOpenToolMs(turn: LiveTurn, now: number): number {
  if (turn.toolSinceWorkMs === null) return 0
  return turn.toolHasOutput ? turn.toolPureOpenMs : turn.toolPureOpenMs + openToolMs(turn, now)
}

/** 解码时长 = 自本窗口首个输出起的工作时长 − 该点之后观测到的纯工具时间。
 *  无输出（`firstOutputWorkMs === null`）→ 0，读数 null：不摊薄也不虚构。 */
function decodeElapsedMs(turn: LiveTurn, now: number): number {
  if (turn.firstOutputWorkMs === null) return 0
  const pureAfterFirst = Math.max(0, turn.pureToolMs - turn.pureToolMsAtFirst) + pureOpenToolMs(turn, now)
  return Math.max(0, workElapsedMs(turn, now) - turn.firstOutputWorkMs - pureAfterFirst)
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
    startedAt, pausedMs: 0, waitSince: null, outputChars: 0,
    activeTools: new Set<string>(), toolSinceWorkMs: null, toolMs: 0, pureToolMs: 0,
    firstOutputWorkMs: null, pureToolMsAtFirst: 0, toolPureOpenMs: 0, toolHasOutput: false, estimatesValid: true,
  })
}

/** 快照 / 重连丢失了中间观测：重开本地采样窗（输出归零），保留工作表与审批态。
 *  **已闭合的工具段是真实观测，跨重连保留**——否则移动端关一次浏览器就把整轮工具
 *  时长抹成 0（2026-09-21 用户报告）。只有仍开放的并集不可知：离线那段时间无法归因
 *  给工具还是别的，丢弃而不虚构（E14 口径不变）。 */
export function resumeTurnClock(sessionId: string): void {
  finalBySession.delete(sessionId)
  const turn = turns.get(sessionId)
  if (!turn) return
  turn.outputChars = 0
  turn.activeTools.clear()
  turn.toolSinceWorkMs = null
  turn.toolPureOpenMs = 0
  turn.toolHasOutput = false
  turn.estimatesValid = true
  // 解码窗口随观测窗一起重开：下一次输出重新落锚点；已闭合工具段的基线在该刻重建。
  turn.firstOutputWorkMs = null
  turn.pureToolMsAtFirst = 0
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
      turn.toolPureOpenMs = 0
      return
    }
    if (turn.activeTools.size === 0) {
      turn.toolSinceWorkMs = workElapsedMs(turn, at)
      turn.toolPureOpenMs = 0
      turn.toolHasOutput = false
    }
    turn.activeTools.add(id)
  } else if (turn.activeTools.delete(id) && turn.activeTools.size === 0) {
    turn.toolMs += openToolMs(turn, at)
    turn.pureToolMs += pureOpenToolMs(turn, at)
    turn.toolSinceWorkMs = null
    turn.toolPureOpenMs = 0
    turn.toolHasOutput = false
  }
}

/** 工作仍含工具，不含审批；null = 无在建 turn。 */
export function turnElapsedMs(sessionId: string, now: number = Date.now()): number | null {
  const turn = turns.get(sessionId)
  return turn ? workElapsedMs(turn, now) : null
}

/** 本连接观测到的工具并集时长（扣审批，跨重连累计；仍在执行的并集算到 now）。
 *  null = 无 turn / 采样失效，0 = 尚未观察到执行。 */
export function turnToolElapsedMs(sessionId: string, now: number = Date.now()): number | null {
  const turn = turns.get(sessionId)
  if (!turn || !turn.estimatesValid) return null
  const elapsed = turn.toolMs + openToolMs(turn, now)
  return Number.isFinite(elapsed) ? elapsed : null
}

/** 正文与思考都算输出，turn 外或非法样本不计。工具并集内**首次**出现输出时，把
 * 「工具起点 → at」封口为纯工具时间：生成计时钟在此暂停，at 之后（仍在工具内）重新
 * 走时，直到并集关闭。不能从工具通知推断 token 的生成起点，故封口点取输出实际到达的
 * 时刻，而非工具状态变化时刻。同一事件还把解码窗口零点落在 at（首字前的等待自此
 * 不再进分母）；封口段发生在零点之前，随基线一起排除，不会被扣两次。 */
export function addOutputChars(sessionId: string, count: number, at: number = Date.now()): void {
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(at)) return
  const turn = turns.get(sessionId)
  if (!turn || !turn.estimatesValid) return
  turn.outputChars += count
  if (turn.firstOutputWorkMs === null) {
    // 首个输出即解码窗口零点：把当前工作坐标落锚，之前的等待不进分母。
    turn.firstOutputWorkMs = workElapsedMs(turn, at)
    // 基线含当前开放并集「到此为止」的整段（本事件即刻封口的那段）：
    // 它发生在首个输出之前，属于工具时间而不是生成时间。
    turn.pureToolMsAtFirst = turn.pureToolMs
      + (turn.activeTools.size > 0 ? openToolMs(turn, at) : 0)
  }
  if (turn.activeTools.size > 0 && !turn.toolHasOutput) {
    turn.toolPureOpenMs += openToolMs(turn, at)
    turn.toolHasOutput = true
  }
}

/** 实时估算 tokens/s；分母 = 自本窗口首个输出起的解码时长（见文件头与 `decodeElapsedMs`）：
 *  首字前的等待与首字之后观测到的纯工具并集都不计入，首字延迟不再摊薄读数。 */
export function turnTps(sessionId: string, now: number = Date.now()): number | null {
  const turn = turns.get(sessionId)
  if (!turn || !turn.estimatesValid) return null
  return computeTps(turn.outputChars, decodeElapsedMs(turn, now))
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
