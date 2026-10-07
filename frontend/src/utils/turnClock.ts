/**
 * turnClock — 流式气泡的本地估算；模块级有界表 + 消费方定时直写 DOM，
 * 不进入 React state，不入库、不参与同步。定稿工作时长仍以后端 durationMs 为准。
 *
 * 工作 = 墙钟 − 审批挂起（见工作时长计划 E12），含工具执行。工具时间取并行执行
 * 区间的并集，供「工具约 N秒」展示；并集内只有「输出活动窗口」归生成，首段与
 * 静默尾段归工具（口径见 E14/E18/E19）。
 *
 * 速度（tps）走**白名单**：分母只累计「输出活跃时段」——相邻输出 chunk 间隔
 * 不超过 OUTPUT_GAP_MS 的连续流式窗口；工具执行、审批等待、模型停顿与 agent
 * 循环空档一律不计（E20 翻盘 E14–E19 的黑名单扣除：那条路要证明「某段时间不是
 * 生成」，只能靠 agent 下发显式 in_progress/running，对不发状态的实现永远漏——
 * 实测 pi-acp 相邻工具间有数秒无任何输出，黑名单下全部分母里摊薄；白名单只认
 * 「输出正在流」这一件事，跨 agent 一致，也不依赖任何工具事件）。分子同样只取
 * 本观测窗的正文与思考字符（重放与 seq 去重丢弃的帧不计）。已闭合的 burst 保留
 * 其测得时长，故停顿期间读数冻结在最后测得值、不随等待下跌；整轮只有一个 chunk
 * 时没有可测窗口 → null，宁缺毋滥（同 E17）。
 * 重连只重开观测窗（输出与 burst 归零、开放并集丢弃），已闭合的工具段跨重连保留。
 * ACP usage_update 无输出 token 字段，因此速度和工具时间都只是本地估算。
 */

interface LiveTurn {
  startedAt: number
  pausedMs: number
  waitSince: number | null
  /** 当前输出 burst（连续流式段）：首 / 末 chunk 的墙钟时刻与字符数（白名单分母）。 */
  burstFirstAt: number | null
  burstLastAt: number
  burstChars: number
  /** 已闭合 burst 的字符合计时长合计（tps 分子/分母的存量部分）。 */
  streamChars: number
  streamMs: number
  activeTools: Set<string>
  toolSinceWorkMs: number | null
  /** 已闭合工具并集的「非生成段」累计（首段 + 尾段）：「工具约 N秒」的展示值。
   *  跨重连保留的真实观测；tps 分母不再读它（E20 白名单口径）。 */
  pureToolMs: number
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

/** 相邻输出 chunk 间隔超过该值即视为一次「停顿」：模型停止吐字（工具执行 /
 *  审批等待 / 思考间隙 / agent 循环空档），停顿段不计入速度分母。实测 pi-acp
 *  正常流式的 chunk 间隔在数百毫秒内（真实流量最大 ~400ms），1s 留有余量。 */
const OUTPUT_GAP_MS = 1_000

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

/** 输出活跃时长（tps 分母，白名单）= 已闭合 burst 合计 + 当前 burst 至今；
 *  停顿超过 OUTPUT_GAP_MS 则当前 burst 闭合在末 chunk（其测得时长已入合计，
 *  读数冻结不随等待下跌）。零长度 burst（整段只有一个 chunk）既不带时长也不带
 *  字符——没有可测窗口就不虚构（E17 同款取舍）。 */
function streamTotals(turn: LiveTurn, now: number): { chars: number; ms: number } {
  let chars = turn.streamChars
  let ms = turn.streamMs
  if (turn.burstFirstAt !== null) {
    const end = now - turn.burstLastAt > OUTPUT_GAP_MS ? turn.burstLastAt : now
    if (end > turn.burstFirstAt) {
      chars += turn.burstChars
      ms += end - turn.burstFirstAt
    }
  }
  return { chars, ms }
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
    startedAt, pausedMs: 0, waitSince: null,
    burstFirstAt: null, burstLastAt: 0, burstChars: 0, streamChars: 0, streamMs: 0,
    activeTools: new Set<string>(), toolSinceWorkMs: null, pureToolMs: 0,
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
  // 观测窗重开：burst 与累计全部归零（离线帧只以 cooked 快照形态回来，不计入
  // 分子）；已闭合工具段是真实观测，跨重连保留（E15 修复），只有仍开放的并集
  // 不可知：离线那段时间无法归因给工具还是别的，丢弃而不虚构（E14 口径不变）。
  turn.burstFirstAt = null
  turn.burstLastAt = 0
  turn.burstChars = 0
  turn.streamChars = 0
  turn.streamMs = 0
  turn.activeTools.clear()
  turn.toolSinceWorkMs = null
  turn.toolHeadMs = 0
  turn.toolHasHead = false
  turn.lastOutputWorkMs = null
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
 * pending/未知状态不证明执行，不扣后续时间。溢出直接令**工具**估算失效并释放 ID，
 * 不能丢一条活跃工具后继续假装并集完整；下一 turn / resume 才重新采样。
 * tps 走白名单、不读工具状态，故不受失效影响（E20）。 */
export function updateTurnTool(sessionId: string, id: string, status?: string, at: number = Date.now()): void {
  const turn = turns.get(sessionId)
  if (!turn || !turn.estimatesValid || status === undefined) return
  if (status === 'in_progress' || status === 'running') {
    if (turn.activeTools.has(id)) return
    if (!id || id.length > MAX_TURN_TOOL_ID_LENGTH || turn.activeTools.size >= MAX_ACTIVE_TURN_TOOLS) {
      // 丢弃一条活跃工具后并集不再完整，工具估算整体作废（见 E14）；
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
      return
    }
    if (turn.activeTools.size === 0) {
      turn.toolSinceWorkMs = workElapsedMs(turn, at)
      turn.toolHeadMs = 0
      turn.toolHasHead = false
    }
    turn.activeTools.add(id)
  } else if (turn.activeTools.delete(id) && turn.activeTools.size === 0) {
    // 固化本并集的非生成段（首段 + 尾段）：此后任何读数都不再依赖它是否仍开放。
    turn.pureToolMs += turn.toolHeadMs + openTailMs(turn, at)
    turn.toolSinceWorkMs = null
    turn.toolHeadMs = 0
    turn.toolHasHead = false
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

/** 正文与思考都算输出，turn 外或非法样本不计。一次调用兼两份职责：
 *  - tps 白名单记账：间隔 ≤ OUTPUT_GAP_MS 归入当前 burst，超阈值先闭合旧 burst
 *    （零长度不带字符）再新起一段——中间的静默（工具执行 / 审批 / agent 循环）
 *    不进任何一边的分母；
 *  - 推进工具展示的「末次输出」锚点（E18/E19）：开放并集内输出一到，尾段从最新
 *    chunk 起算；并集内首次输出还固化「并集起点 → 此刻」的首段。
 *  tps 不依赖工具状态，故工具跟踪溢出（estimatesValid=false）不影响本记账。 */
export function addOutputChars(sessionId: string, count: number, at: number = Date.now()): void {
  if (!Number.isFinite(count) || count <= 0 || !Number.isFinite(at)) return
  const turn = turns.get(sessionId)
  if (!turn) return
  if (turn.burstFirstAt === null || at - turn.burstLastAt > OUTPUT_GAP_MS) {
    if (turn.burstFirstAt !== null && turn.burstLastAt > turn.burstFirstAt) {
      turn.streamChars += turn.burstChars
      turn.streamMs += turn.burstLastAt - turn.burstFirstAt
    }
    turn.burstFirstAt = at
    turn.burstChars = 0
  }
  turn.burstChars += count
  turn.burstLastAt = at
  turn.lastOutputWorkMs = workElapsedMs(turn, at)
  if (turn.activeTools.size > 0 && !turn.toolHasHead) {
    // 并集内首次输出：封存首段；此后首段不再增长（工具展示口径）。
    turn.toolHeadMs = openToolMs(turn, at)
    turn.toolHasHead = true
  }
}

/** 实时估算 tokens/s；分子 = 本观测窗输出的正文与思考字符，分母 = 输出活跃
 *  时段（`streamTotals`，白名单：只认连续流式窗口，工具执行 / 审批 / 停顿全排除）。 */
export function turnTps(sessionId: string, now: number = Date.now()): number | null {
  const turn = turns.get(sessionId)
  if (!turn) return null
  const { chars, ms } = streamTotals(turn, now)
  return computeTps(chars, ms)
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
