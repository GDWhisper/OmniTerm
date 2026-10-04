/**
 * turnClock — 流式气泡的本地估算；模块级有界表 + 消费方定时直写 DOM，
 * 不进入 React state，不入库、不参与同步。定稿工作时长仍以后端 durationMs 为准。
 *
 * 工作 = 墙钟 − 审批挂起（见工作时长计划 E12）。速度只使用本连接观察到的
 * 输出 / 解码窗口时长，按 4 字符 ≈ 1 token 折算。工具时间取并行执行区间的并集，
 * 仍包含在工作时长里。**输出活动是生成的证据**：工具并集内的时间只有在
 * 「输出活动窗口」（并集内首次输出 → 末次输出）内才归生成；此外的段——并集起点到
 * 首次输出的首段、末次输出之后的尾段——都是模型在等待工具，归工具时间，两个读数
 * （tps 分母与「工具约 N秒」）同口径扣除（E19 翻盘 E15/E18 的单次封口：封口之后的
 * 静默执行段不再留在分母里）。实时上末次输出之后的段即刻按工具计（读数不随工具
 * 执行下跌）；新的输出到达时该段随末次输出前移被认领为生成——中途修正而不是
 * 留到最后。整段都没有输出的工具窗口全额计为工具时间。
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
  /** 已闭合工具并集的「非生成段」累计（首段 + 尾段）：既是「工具约 N秒」的展示值，
   *  也是 tps 分母的扣除源——两读同一归因。跨重连保留的真实观测。 */
  pureToolMs: number
  /** 本窗口首个输出出现时的工作坐标；null = 还没吐字，没有可测的解码窗口。 */
  firstOutputWorkMs: number | null
  /** 首输出那一刻的已扣纯工具基线：更早的闭合段与同刻开放并集快照都不进新分母。 */
  pureToolMsAtFirst: number
  /** 首输出时刻对当时开放并集的整段快照（工作坐标差值）；开放并集关闭时清零。
   *  它已计入 `pureToolMsAtFirst`，后续开放并集净扣除须减去它避免重复扣。 */
  openBaselineMs: number
  /** 开放并集的首段：并集起点 → 并集内首次输出；`toolHasHead` 为 false 时无意义。 */
  toolHeadMs: number
  toolHasHead: boolean
  /** 本窗口最近一次输出的工作坐标：开放并集尾段的起点（无更新则尾段持续走时）。 */
  lastOutputWorkMs: number | null
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

/** 开放工具并集的完整跨度（首段 / 快照的计算源）。 */
function openToolMs(turn: LiveTurn, now: number): number {
  return turn.toolSinceWorkMs === null ? 0 : Math.max(0, workElapsedMs(turn, now) - turn.toolSinceWorkMs)
}

/** 开放并集的尾段 = 末次输出（或并集起点）→ now。末次输出之后没有新的输出证据，
 *  该段是模型在等工具：实时即按工具计，读数不随工具执行下跌；新输出到达后
 *  末次输出前移，该段被认领为生成（中途修正）。 */
function openTailMs(turn: LiveTurn, now: number): number {
  if (turn.toolSinceWorkMs === null) return 0
  const anchor =
    turn.lastOutputWorkMs !== null && turn.lastOutputWorkMs > turn.toolSinceWorkMs
      ? turn.lastOutputWorkMs
      : turn.toolSinceWorkMs
  return Math.max(0, workElapsedMs(turn, now) - anchor)
}

/** 开放并集当前应归工具的段 = 首段 + 尾段。无输出时首段为 0、尾段即全跨度。 */
function openToolDeductMs(turn: LiveTurn, now: number): number {
  if (turn.toolSinceWorkMs === null) return 0
  return turn.toolHeadMs + openTailMs(turn, now)
}

/** 解码时长 = 自本窗口首个输出起的工作时长 − 该点之后观测到的纯工具时间
 *  （闭合段 + 开放并集净扣除，首字时刻的开放并集快照已入基线不重复扣）。
 *  无输出（`firstOutputWorkMs === null`）→ 0，读数 null：不摊薄也不虚构。 */
function decodeElapsedMs(turn: LiveTurn, now: number): number {
  if (turn.firstOutputWorkMs === null) return 0
  const closed = Math.max(0, turn.pureToolMs - turn.pureToolMsAtFirst)
  const open = Math.max(0, openToolDeductMs(turn, now) - turn.openBaselineMs)
  return Math.max(0, workElapsedMs(turn, now) - turn.firstOutputWorkMs - closed - open)
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
    activeTools: new Set<string>(), toolSinceWorkMs: null, pureToolMs: 0,
    firstOutputWorkMs: null, pureToolMsAtFirst: 0, openBaselineMs: 0,
    toolHeadMs: 0, toolHasHead: false, lastOutputWorkMs: null, estimatesValid: true,
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
  turn.toolHeadMs = 0
  turn.toolHasHead = false
  turn.lastOutputWorkMs = null
  turn.estimatesValid = true
  // 解码窗口随观测窗一起重开：下一次输出重新落锚点；已闭合工具段的基线在该刻重建。
  turn.firstOutputWorkMs = null
  turn.pureToolMsAtFirst = 0
  turn.openBaselineMs = 0
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
      turn.toolHeadMs = 0
      turn.toolHasHead = false
      turn.openBaselineMs = 0
      return
    }
    if (turn.activeTools.size === 0) {
      turn.toolSinceWorkMs = workElapsedMs(turn, at)
      turn.toolHeadMs = 0
      turn.toolHasHead = false
      turn.openBaselineMs = 0
    }
    turn.activeTools.add(id)
  } else if (turn.activeTools.delete(id) && turn.activeTools.size === 0) {
    // 固化本并集的非生成段（首段 + 尾段）：此后任何读数都不再依赖它是否仍开放。
    turn.pureToolMs += turn.toolHeadMs + openTailMs(turn, at)
    turn.toolSinceWorkMs = null
    turn.toolHeadMs = 0
    turn.toolHasHead = false
    turn.openBaselineMs = 0
  }
}

/** 工作仍含工具，不含审批；null = 无在建 turn。 */
export function turnElapsedMs(sessionId: string, now: number = Date.now()): number | null {
  const turn = turns.get(sessionId)
  return turn ? workElapsedMs(turn, now) : null
}

/** 可归因于工具的时长（扣审批，跨重连累计）：已闭合并集的非生成段 + 开放并集
 *  当前的非生成段（首段 + 末次输出之后的尾段）。并集内一旦有新输出，尾段前移——
 *  thinking / 正文流出期间工具不计时（E18：与 tps 分母同一归因口径）。
 *  null = 无 turn / 采样失效，0 = 尚未观察到执行。 */
export function turnToolElapsedMs(sessionId: string, now: number = Date.now()): number | null {
  const turn = turns.get(sessionId)
  if (!turn || !turn.estimatesValid) return null
  const elapsed = turn.pureToolMs + openToolDeductMs(turn, now)
  return Number.isFinite(elapsed) ? elapsed : null
}

/** 正文与思考都算输出，turn 外或非法样本不计。每次输出推进「末次输出」锚点：
 *  开放并集的尾段随之前移（[旧末字, 新输出] 被认领为生成），若输出落在开放并集内，
 *  首次输出还固化「并集起点 → 此刻」的首段。同一事件还把解码窗口零点落在 at
 *  （首字前的等待自此不再进分母）；首段发生在零点之前时随基线一起排除，不会扣两次。 */
export function addOutputChars(sessionId: string, count: number, at: number = Date.now()): void {
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(at)) return
  const turn = turns.get(sessionId)
  if (!turn || !turn.estimatesValid) return
  turn.outputChars += count
  if (turn.firstOutputWorkMs === null) {
    // 首个输出即解码窗口零点：把当前工作坐标落锚，之前的等待不进分母。
    turn.firstOutputWorkMs = workElapsedMs(turn, at)
    // 基线含当前开放并集「到此为止」的整段：它发生在首个输出之前，属工具时间。
    const openSnapshot = turn.activeTools.size > 0 ? openToolMs(turn, at) : 0
    turn.pureToolMsAtFirst = turn.pureToolMs + openSnapshot
    // 该快照也是开放并集净扣除的抵扣项；并集关闭时随固化一起失效（清 0）。
    turn.openBaselineMs = openSnapshot
  }
  if (turn.activeTools.size > 0 && !turn.toolHasHead) {
    // 并集内首次输出：封存首段；此后首段不再增长，生成窗口自此开启。
    turn.toolHeadMs = openToolMs(turn, at)
    turn.toolHasHead = true
  }
  turn.lastOutputWorkMs = workElapsedMs(turn, at)
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
