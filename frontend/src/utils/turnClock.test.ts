import { describe, it, expect, beforeEach } from 'vitest'
import {
  MAX_TRACKED_TURNS,
  MAX_ACTIVE_TURN_TOOLS,
  MAX_TURN_TOOL_ID_LENGTH,
  addOutputChars,
  beginTurn,
  clearTurnClock,
  computeTps,
  endTurn,
  finalTps,
  finalToolElapsedMs,
  resumeTurnClock,
  setTurnWaiting,
  trackedTurnCount,
  turnElapsedMs,
  turnToolElapsedMs,
  turnTps,
  updateTurnTool,
} from './turnClock'

// 时间全部由调用方注入，不用 fake timers：计时器本身只认传进去的 epoch。
describe('turnClock', () => {
  beforeEach(() => clearTurnClock())

  it('无在建 turn 时读数为 null（调用方据此不渲染计时器）', () => {
    expect(turnElapsedMs('s1', 5_000)).toBeNull()
  })

  it('begin 后读出墙钟差值，end 后回到 null', () => {
    beginTurn('s1', 1_000)
    expect(turnElapsedMs('s1', 4_000)).toBe(3_000)
    endTurn('s1')
    expect(turnElapsedMs('s1', 5_000)).toBeNull()
  })

  it('审批挂起：闭合段与未闭合段都从工作时长里扣除', () => {
    beginTurn('s1', 0)
    setTurnWaiting('s1', true, 1_000)
    // 挂起未闭合：1000→5000 这段不算工作
    expect(turnElapsedMs('s1', 5_000)).toBe(1_000)
    setTurnWaiting('s1', false, 5_000)
    // 已累加 4s 挂起，总墙钟 8s → 工作 4s
    expect(turnElapsedMs('s1', 8_000)).toBe(4_000)
  })

  it('多段挂起累加；重复置同一态幂等（镜像后端 wait_depth 语义）', () => {
    beginTurn('s1', 0)
    setTurnWaiting('s1', true, 1_000)
    setTurnWaiting('s1', true, 2_000)
    setTurnWaiting('s1', false, 3_000)
    setTurnWaiting('s1', false, 4_000)
    setTurnWaiting('s1', true, 5_000)
    setTurnWaiting('s1', false, 7_000)
    // 两段挂起 2s + 2s = 4s
    expect(turnElapsedMs('s1', 10_000)).toBe(6_000)
  })

  it('turn 外的挂起信号是 no-op，不留下半路计时', () => {
    setTurnWaiting('s1', true, 1_000)
    expect(turnElapsedMs('s1', 5_000)).toBeNull()
    beginTurn('s1', 4_000)
    expect(turnElapsedMs('s1', 6_000)).toBe(2_000)
  })

  it('新 turn 起点重置挂起：上一 turn 遗留的未决审批不暂停它', () => {
    beginTurn('s1', 0)
    setTurnWaiting('s1', true, 1_000)
    endTurn('s1')
    beginTurn('s1', 10_000)
    setTurnWaiting('s1', false, 11_000)
    expect(turnElapsedMs('s1', 13_000)).toBe(3_000)
  })

  it('锚点来自服务端时钟且快于本地时夹到 0，不出现负数', () => {
    beginTurn('s1', 10_000)
    expect(turnElapsedMs('s1', 4_000)).toBe(0)
  })

  it('超过上限丢最旧条目：漏调 endTurn 也不会无界累积', () => {
    for (let i = 0; i <= MAX_TRACKED_TURNS; i++) beginTurn(`s${i}`, 1_000)
    expect(trackedTurnCount()).toBe(MAX_TRACKED_TURNS)
    expect(turnElapsedMs('s0', 2_000)).toBeNull()
    expect(turnElapsedMs(`s${MAX_TRACKED_TURNS}`, 2_000)).toBe(1_000)
  })
})

// tps 估算：4 字符 ≈ 1 token（ACP 无输出 token 字段，只能按字符折算，见 turnClock 顶部注释）。
describe('turnClock tps 估算', () => {
  beforeEach(() => clearTurnClock())

  it('computeTps 纯函数：0 输出 / 0 时长都返回 null，不产生 Infinity 或 NaN', () => {
    expect(computeTps(0, 1_000)).toBeNull()
    expect(computeTps(-8, 1_000)).toBeNull()
    expect(computeTps(40, 0)).toBeNull()
    expect(computeTps(40, -100)).toBeNull()
    expect(computeTps(Number.NaN, 1_000)).toBeNull()
    expect(computeTps(Number.POSITIVE_INFINITY, 1_000)).toBeNull()
    expect(computeTps(40, Number.POSITIVE_INFINITY)).toBeNull()
    expect(computeTps(40, Number.NaN)).toBeNull()
    expect(computeTps(Number.MAX_VALUE, Number.MIN_VALUE)).toBeNull()
  })

  it('computeTps：char/4/(ms/1000) 的换算', () => {
    expect(computeTps(40, 1_000)).toBe(10)
    expect(computeTps(80, 2_000)).toBe(10)
    expect(computeTps(20, 1_000)).toBe(5)
  })

  it('无在建 turn 时 turnTps 为 null（调用方不渲染）', () => {
    expect(turnTps('s1', 5_000)).toBeNull()
  })

  it('addOutputChars 累加后给出实时读数；turn 外 / 非正数 no-op', () => {
    addOutputChars('s1', 40) // 无 turn → 丢弃
    beginTurn('s1', 0)
    expect(turnTps('s1', 1_000)).toBeNull() // 还没有任何输出
    addOutputChars('s1', 40, 1_000)
    // 首个输出瞬间解码窗口长度 0 → 无可测速率（首字延迟不计入分母）
    expect(turnTps('s1', 1_000)).toBeNull()
    addOutputChars('s1', 40, 2_000)
    expect(turnTps('s1', 2_000)).toBe(20) // 80/4 摊在 1s 解码窗口
    // 非正数 / NaN 会污染估算，直接丢弃
    addOutputChars('s1', 0)
    addOutputChars('s1', -5)
    addOutputChars('s1', Number.NaN)
    expect(turnTps('s1', 2_000)).toBe(20)
  })

  it('审批挂起期间没有输出即无速率；挂起前后的流式各自成段', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 40, 0)
    addOutputChars('s1', 40, 500) // burst [0,500]：80 字符 ÷ 0.5s
    setTurnWaiting('s1', true, 1_000)
    // 挂起 4s 零输出：burst 已闭合，读数冻结在测得值（等待不摊薄）
    expect(turnTps('s1', 5_000)).toBe(40)
    // 白名单不看工作时钟——审批扣除对 tps 的全部贡献就是「停顿不进分母」
    expect(turnElapsedMs('s1', 5_000)).toBe(1_000)
  })

  it('审批挂起期间速率冻结在最后测得值，解除后新输出另起一段', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    addOutputChars('s1', 400, 2_000) // burst [1s,2s]：800 字符 ÷ 1s
    setTurnWaiting('s1', true, 2_000)
    // 挂 5 分钟：burst 早已闭合，读数一动不动，不随真人思考时间跌落。
    expect(turnTps('s1', 300_000)).toBe(200)
    setTurnWaiting('s1', false, 302_000)
    expect(turnTps('s1', 302_000)).toBe(200)
    // 解除后模型恢复吐字：间隔远超阈值 → 新开一段，两段字符合计 ÷ 合计时长
    addOutputChars('s1', 800, 303_000)
    expect(turnTps('s1', 303_000)).toBe(200) // 新 burst 单 chunk 无可测窗口：仍为旧段读数
    addOutputChars('s1', 800, 304_000)
    expect(turnTps('s1', 304_000)).toBe(300) // 2_400 字符 ÷ 2s（两段各 1s）
  })

  it('审批挂起与工具并集同时冻住，挂起段不计入工具；tps 只看输出流', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 0)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    setTurnWaiting('s1', true, 2_000)
    // 工具并集跨度也冻在挂起那一刻（1s），不随等待增长。
    expect(turnToolElapsedMs('s1', 120_000)).toBe(1_000)
    // 白名单下 tps 不读任何工具/审批状态：唯一的 chunk 没有可测流式窗口 → null。
    expect(turnTps('s1', 120_000)).toBeNull()
    // 挂起期间到达的输出：新起一段（与上一 chunk 间隔远超阈值），单 chunk 仍无可测窗口。
    addOutputChars('s1', 400, 60_000)
    expect(turnTps('s1', 60_000)).toBeNull()
    setTurnWaiting('s1', false, 122_000)
    // 挂起的那 120s 不计入工具并集，分子分母都不含它。
    expect(turnElapsedMs('s1', 122_000)).toBe(2_000)
    expect(turnToolElapsedMs('s1', 122_000)).toBe(1_000)
    expect(turnTps('s1', 122_000)).toBeNull()
  })

  it('首字前的等待不进分母：解码窗口从首个输出起算', () => {
    beginTurn('s1', 0)
    // 模型 8s 后才吐第一个字：这段时间零输出，计入只会摊薄读数（对齐 dsh decode-only）。
    addOutputChars('s1', 1_200, 8_000)
    expect(turnTps('s1', 8_000)).toBeNull() // 单 chunk 无可测窗口
    addOutputChars('s1', 1_200, 9_000)
    // burst [8s,9s] 共 2_400 字符 → 600 token ÷ 1s（8s 首字延迟被排除）
    expect(turnTps('s1', 9_000)).toBe(600)
  })

  it('endTurn 冻结最终值：turnTps/turnElapsedMs 归 null，finalTps 保留', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 80, 0)
    addOutputChars('s1', 80, 1_000) // burst [0,1s]：160 字符 ÷ 1s
    endTurn('s1', 1_000)
    expect(turnTps('s1', 3_000)).toBeNull()
    expect(turnElapsedMs('s1', 3_000)).toBeNull()
    expect(finalTps('s1')).toBe(40) // 160/4/1
  })

  it('重复 endTurn 不覆盖已冻结的快照', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 40, 0)
    updateTurnTool('s1', 'a', 'in_progress', 500)
    addOutputChars('s1', 40, 1_000) // burst [0,1s]：80 字符 ÷ 1s
    updateTurnTool('s1', 'a', 'completed', 1_000)
    endTurn('s1', 1_000)
    // 白名单下 tps 与工具互不相干：80/4/1s；工具并集 [0.5s,1s] 单独记 0.5s
    expect(finalTps('s1')).toBe(20)
    expect(finalToolElapsedMs('s1')).toBe(500)

    endTurn('s1', 9_000) // 无在建 turn：第二次结束是 no-op，不覆盖上面的冻结值
    expect(finalTps('s1')).toBe(20)
    expect(finalToolElapsedMs('s1')).toBe(500)
  })

  it('本轮 0 输出定稿会把上一 turn 的快照清掉，不把旧值错配到新消息', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 40, 0)
    addOutputChars('s1', 40, 1_000)
    endTurn('s1', 1_000)
    expect(finalTps('s1')).toBe(20)

    beginTurn('s1', 2_000)
    endTurn('s1', 3_000) // 无输出
    expect(finalTps('s1')).toBeNull()
  })

  it('finalTps 快照同样有界：超过上限丢最旧条目', () => {
    for (let i = 0; i <= MAX_TRACKED_TURNS; i++) {
      beginTurn(`s${i}`, 0)
      addOutputChars(`s${i}`, 40, 0)
      addOutputChars(`s${i}`, 40, 1_000)
      endTurn(`s${i}`, 1_000)
    }
    expect(finalTps('s0')).toBeNull()
    expect(finalTps(`s${MAX_TRACKED_TURNS}`)).toBe(20)
  })

  it('估算失效的 turn 不留空快照占位，不把别的会话的真实快照挤出上限', () => {
    for (let i = 0; i < MAX_TRACKED_TURNS; i++) {
      beginTurn(`s${i}`, 0)
      addOutputChars(`s${i}`, 40, 0)
      addOutputChars(`s${i}`, 40, 1_000)
      endTurn(`s${i}`, 1_000)
    }
    expect(finalTps('s0')).toBe(20)

    // 工具数溢出 → 工具估算失效；tps 走白名单不受影响，但本 turn 无输出故同为 null
    beginTurn('bad', 0)
    for (let i = 0; i <= MAX_ACTIVE_TURN_TOOLS; i++) updateTurnTool('bad', `t${i}`, 'in_progress', 1_000)
    endTurn('bad', 2_000)
    expect(finalTps('bad')).toBeNull()
    expect(finalToolElapsedMs('bad')).toBeNull()
    expect(finalTps('s0')).toBe(20) // s0 仍是最旧的真实快照，未被占位条目挤掉
  })
})

describe('turnClock observed tool intervals', () => {
  beforeEach(() => clearTurnClock())

  it('excludes a long silent tool execution from the rate, resuming after the tool ends', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000) // 首字
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    // 工具起点后到达的过渡文本（与 in_progress 同批、生成于工具之前）。
    addOutputChars('s1', 400, 1_500)
    // 白名单下静默执行根本不进分母：读数冻结在 [1s,1.5s] 测得值（800 字符 ÷ 0.5s），
    // 不随工具执行下跌（2026-10-04 用户报告的现象结构性消失）。
    expect(turnTps('s1', 30_000)).toBe(400)
    expect(turnToolElapsedMs('s1', 30_000)).toBe(29_000)
    updateTurnTool('s1', 'a', 'completed', 31_000)
    expect(turnToolElapsedMs('s1', 31_000)).toBe(30_000)
    // 工具结束后模型恢复输出：新起一段，两段字符合计 ÷ 合计时长
    addOutputChars('s1', 1_000, 33_000)
    expect(turnTps('s1', 34_000)).toBe(300)
    endTurn('s1', 34_000)
    expect(finalToolElapsedMs('s1')).toBe(30_000)
    expect(finalTps('s1')).toBe(300)
  })

  it('首个输出落在工具并集内：首段与静默执行段都不进解码分母', () => {
    beginTurn('s1', 0)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    // 工具执行 3s 后模型开始说话：窗口零点落在 4s，[1s,4s] 封存为首段
    addOutputChars('s1', 1_200, 4_000)
    expect(turnTps('s1', 4_000)).toBeNull() // 零长度窗口，不把工具时间算成生成
    updateTurnTool('s1', 'a', 'completed', 6_000)
    // 末次输出之后到并集关闭的 [4s,6s] 是静默执行，归工具：窗口内无生成时间 → null
    expect(turnTps('s1', 6_000)).toBeNull()
    // 展示与分母同口径：首段 [1s,4s] + 静默尾段 [4s,6s]
    expect(turnToolElapsedMs('s1', 6_000)).toBe(5_000)
  })

  it('freezes tool timing while prose keeps streaming, resumes it after the last delta', () => {
    beginTurn('s1', 0)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    expect(turnToolElapsedMs('s1', 2_000)).toBe(1_000)
    // 工具执行期间模型开始思考/说话（2026-09-27 用户报告：thinking 期间工具也在计时）：
    // 每次输出都把「末次输出」前移，尾段始终从最新 chunk 起算 → 思考流期间工具表冻结。
    addOutputChars('s1', 400, 2_000)
    expect(turnToolElapsedMs('s1', 2_000)).toBe(1_000)
    addOutputChars('s1', 400, 2_500)
    expect(turnToolElapsedMs('s1', 2_500)).toBe(1_000)
    addOutputChars('s1', 400, 11_500)
    expect(turnToolElapsedMs('s1', 11_500)).toBe(1_000)
    addOutputChars('s1', 400, 12_000)
    expect(turnToolElapsedMs('s1', 12_000)).toBe(1_000)
    // 末次输出之后到并集关闭的 1.5s 没有新的输出证据：静默执行段归工具（E19）
    updateTurnTool('s1', 'a', 'completed', 13_500)
    expect(turnToolElapsedMs('s1', 13_500)).toBe(2_500)
    // tps 白名单：两个 burst 各 800 字符 ÷ 0.5s，中间的 9s 静默不进分母
    // （旧黑名单口径此处为 30：chunk 间隔全算生成）。
    expect(turnTps('s1', 13_500)).toBe(400)
  })

  it('keeps 10s of tools in work and yields no rate while no prose follows the first delta', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    expect(turnElapsedMs('s1', 11_000)).toBe(11_000)
    expect(turnToolElapsedMs('s1', 11_000)).toBe(10_000)
    // 首字之后整个解码窗口都落在工具并集内、且无后续输出：
    // 首字前的 1s 不进分母，该段也不再计入 → 无可测速率，宁可 null 不虚报。
    expect(turnTps('s1', 11_000)).toBeNull()
    endTurn('s1', 11_000)
    expect(turnToolElapsedMs('s1', 12_000)).toBeNull()
    expect(finalToolElapsedMs('s1')).toBe(10_000)
    expect(finalTps('s1')).toBeNull()
  })

  it('counts overlapping parallel tools once and closes the union only after the last tool', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    updateTurnTool('s1', 'b', 'running', 2_000)
    updateTurnTool('s1', 'a', 'in_progress', 3_000)
    updateTurnTool('s1', 'a', 'completed', 4_000)
    updateTurnTool('s1', 'a', 'completed', 5_000)
    expect(turnToolElapsedMs('s1', 6_000)).toBe(5_000)
    updateTurnTool('s1', 'b', 'failed', 7_000)
    expect(turnToolElapsedMs('s1', 8_000)).toBe(6_000)
    // 白名单下 tps 与工具并集完全无涉：本段只有一个 chunk，没有可测流式窗口 → null
    // （旧黑名单口径此处为 100：窗口 [1s,8s] 去掉 6s 工具）。
    expect(turnTps('s1', 8_000)).toBeNull()
  })

  it('subtracts approval overlap once from work and tool union, including open approval at finalization', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    setTurnWaiting('s1', true, 2_000)
    updateTurnTool('s1', 'b', 'in_progress', 3_000)
    updateTurnTool('s1', 'a', 'completed', 4_000)
    setTurnWaiting('s1', false, 5_000)
    setTurnWaiting('s1', true, 7_000)
    expect(turnElapsedMs('s1', 10_000)).toBe(4_000)
    expect(turnToolElapsedMs('s1', 10_000)).toBe(3_000)
    // 首字锚点 1s，解码窗口 [1s,4s] 全部落在工具并集内 → 无可测速率
    expect(turnTps('s1', 10_000)).toBeNull()
    endTurn('s1', 10_000)
    expect(finalToolElapsedMs('s1')).toBe(3_000)
    expect(finalTps('s1')).toBeNull()
  })

  it('requires explicit execution status and preserves it across partial updates', () => {
    updateTurnTool('s1', 'outside', 'in_progress', 0)
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'a', undefined, 1_000)
    updateTurnTool('s1', 'b', 'pending', 1_000)
    updateTurnTool('s1', 'c', 'unknown', 1_000)
    expect(turnToolElapsedMs('s1', 3_000)).toBe(0)
    updateTurnTool('s1', 'a', 'in_progress', 3_000)
    updateTurnTool('s1', 'a', undefined, 4_000)
    expect(turnToolElapsedMs('s1', 5_000)).toBe(2_000)
    updateTurnTool('s1', 'a', 'pending', 5_000)
    updateTurnTool('s1', 'a', undefined, 6_000)
    expect(turnToolElapsedMs('s1', 7_000)).toBe(2_000)
    // 白名单下 tps 不读工具状态：单 chunk 无可测流式窗口 → null
    // （旧黑名单口径此处为 25：窗口 [1s,7s] 去掉 2s 工具）。
    expect(turnTps('s1', 7_000)).toBeNull()
  })

  it('keeps the silent tail as tool time while prose lands inside a tool union', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    setTurnWaiting('s1', true, 2_000)
    setTurnWaiting('s1', false, 4_000)
    // 首字之后的窗口整段落在工具并集内且无后续输出：无可测速率。
    expect(turnTps('s1', 5_000)).toBeNull()
    expect(turnTps('s1', 6_000)).toBeNull()
    // 工具内输出到达（工作坐标 3s）：首段 [1s,3s] 封存，尾段自此起算；
    // 与上一 chunk 间隔 4s 超阈值 → 新起一段。单 chunk 瞬间窗口长度 0 → null。
    addOutputChars('s1', 400, 5_000)
    expect(turnTps('s1', 5_000)).toBeNull()
    // 开放 burst 的窗口含 ≤OUTPUT_GAP_MS 的容差：续看到 6s 时读数 400 字符 ÷ 1s
    expect(turnTps('s1', 6_000)).toBe(100)
    updateTurnTool('s1', 'b', 'in_progress', 6_000)
    updateTurnTool('s1', 'a', 'completed', 7_000)
    updateTurnTool('s1', 'b', 'completed', 8_000)
    updateTurnTool('s1', 'c', 'in_progress', 9_000)
    endTurn('s1', 11_000)
    // 展示口径（E19）：a/b 并集的非生成段 [1s,6s]（工作坐标）+ c 开放并集的 [7s,9s]，共 7s。
    expect(finalToolElapsedMs('s1')).toBe(7_000)
    // 白名单下两个 chunk（1s / 5s）间隔远超阈值、各自单段：无可测流式窗口 → null
    // （旧黑名单口径此处为 200：把 a/b 关闭到 c 开始之间的 1s 算生成）。
    expect(finalTps('s1')).toBeNull()
  })

  it('keeps tool time observed before a reconnect instead of wiping it', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    updateTurnTool('s1', 'a', 'completed', 6_000)
    expect(turnToolElapsedMs('s1', 6_000)).toBe(5_000)
    // 移动端关一次浏览器再回来：观测窗重开，但已闭合的 5s 工具时间是真实观测，不能抹掉。
    resumeTurnClock('s1')
    expect(turnToolElapsedMs('s1', 10_000)).toBe(5_000)
    expect(turnTps('s1', 10_000)).toBeNull()
    addOutputChars('s1', 400, 12_000)
    // 新窗口首个输出：瞬间窗口长度 0 → null，不把重连前的等待算成生成时间。
    expect(turnTps('s1', 12_000)).toBeNull()
    addOutputChars('s1', 400, 13_000)
    // 新窗口 burst [12s,13s] 800 字符 → 200 token ÷ 1s；工具段与 tps 无涉（E20 解耦）
    expect(turnTps('s1', 13_000)).toBe(200)
    expect(turnElapsedMs('s1', 13_000)).toBe(13_000)
    endTurn('s1', 13_000)
    expect(finalToolElapsedMs('s1')).toBe(5_000)
    expect(finalTps('s1')).toBe(200)
  })

  it('has no rate for tool-only or zero-generation turns and ignores non-finite character samples', () => {
    beginTurn('s1', 0)
    updateTurnTool('s1', 'a', 'in_progress', 0)
    addOutputChars('s1', Number.POSITIVE_INFINITY, 500)
    expect(turnTps('s1', 1_000)).toBeNull()
    endTurn('s1', 1_000)
    expect(finalTps('s1')).toBeNull()
    expect(finalToolElapsedMs('s1')).toBe(1_000)
    beginTurn('s1', 2_000)
    addOutputChars('s1', 400, 2_000)
    expect(turnTps('s1', 2_000)).toBeNull()
    expect(finalToolElapsedMs('s1')).toBeNull()
  })

  it('resumes only the local observation window while preserving work and an open approval', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    setTurnWaiting('s1', true, 2_000)
    resumeTurnClock('s1')
    expect(turnTps('s1', 10_000)).toBeNull()
    expect(turnToolElapsedMs('s1', 10_000)).toBe(0)
    setTurnWaiting('s1', false, 11_000)
    addOutputChars('s1', 400, 12_000)
    updateTurnTool('s1', 'a', undefined, 12_000)
    updateTurnTool('s1', 'b', 'in_progress', 12_000)
    expect(turnElapsedMs('s1', 14_000)).toBe(5_000)
    expect(turnToolElapsedMs('s1', 14_000)).toBe(2_000)
    // 首字锚点 3s（工作坐标）；[3s,5s] 整段在新开的工具并集内 → 无解码时长
    expect(turnTps('s1', 14_000)).toBeNull()
    endTurn('s1', 14_000)
    expect(finalTps('s1')).toBeNull()
    expect(finalToolElapsedMs('s1')).toBe(2_000)
    resumeTurnClock('missing')
    expect(turnElapsedMs('missing', 15_000)).toBeNull()
  })

  it('invalidates estimates on active-ID overflow without disturbing work, and resume recovers', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    for (let i = 0; i < MAX_ACTIVE_TURN_TOOLS; i++) {
      updateTurnTool('s1', `tool-${i}`, 'in_progress', 1_000)
    }
    expect(turnToolElapsedMs('s1', 2_000)).toBe(1_000)
    updateTurnTool('s1', 'overflow', 'in_progress', 2_000)
    expect(turnElapsedMs('s1', 3_000)).toBe(3_000)
    expect(turnToolElapsedMs('s1', 3_000)).toBeNull()
    expect(turnTps('s1', 3_000)).toBeNull()
    resumeTurnClock('s1')
    addOutputChars('s1', 400, 4_000)
    // 锚点即首输出：此刻窗口长度 0 → null；下一秒才有可测解码窗口
    expect(turnTps('s1', 4_000)).toBeNull()
    addOutputChars('s1', 400, 5_000)
    expect(turnTps('s1', 5_000)).toBe(200)
  })

  it('bounds ID size and drops the truncated tool estimate while tps stays measurable', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    addOutputChars('s1', 400, 1_500) // burst [1s,1.5s]
    updateTurnTool('s1', 'x'.repeat(MAX_TURN_TOOL_ID_LENGTH + 1), 'in_progress', 1_000)
    endTurn('s1', 2_600)
    // tps 走白名单：800 字符 ÷ 0.5s，不受工具跟踪溃败影响（E20 解耦）
    expect(finalTps('s1')).toBe(400)
    // 超长 ID 被丢出并集 → 工具估算作废，宁缺毋滥
    expect(finalToolElapsedMs('s1')).toBeNull()
  })

  it('releases completed IDs so sequential tools do not exhaust active tracking', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    for (let i = 0; i <= MAX_ACTIVE_TURN_TOOLS; i++) {
      updateTurnTool('s1', `tool-${i}`, 'in_progress', 1_000 + i)
      updateTurnTool('s1', `tool-${i}`, 'completed', 1_001 + i)
    }
    // 白名单下工具段完全不进分母：唯一 burst [1s,2s]，1_600 字符 ÷ 1s
    addOutputChars('s1', 1_200, 2_000)
    expect(turnTps('s1', 3_257)).toBe(400)
  })

  it('bounds tool snapshots with rates and clears both on a new turn', () => {
    for (let i = 0; i <= MAX_TRACKED_TURNS; i++) {
      beginTurn(`s${i}`, 0)
      addOutputChars(`s${i}`, 400, 1_000)
      updateTurnTool(`s${i}`, 'a', 'in_progress', 1_000)
      addOutputChars(`s${i}`, 400, 2_000)
      endTurn(`s${i}`, 2_000)
    }
    expect(finalToolElapsedMs('s0')).toBeNull()
    expect(finalTps('s0')).toBeNull()
    expect(finalToolElapsedMs(`s${MAX_TRACKED_TURNS}`)).toBe(1_000)
    // burst [1s,2s]：800 字符 ÷ 1s
    expect(finalTps(`s${MAX_TRACKED_TURNS}`)).toBe(200)
    beginTurn(`s${MAX_TRACKED_TURNS}`, 3_000)
    endTurn(`s${MAX_TRACKED_TURNS}`, 4_000)
    expect(finalToolElapsedMs(`s${MAX_TRACKED_TURNS}`)).toBe(0)
    expect(finalTps(`s${MAX_TRACKED_TURNS}`)).toBeNull()
  })
})

// tps 白名单口径（E20）：分母只认「连续流式窗口」——工具执行、审批等待、模型
// 停顿与 agent 循环空档一律排除，读数冻结在最后测得值。以下钉住 pi-acp 实测
// 形态（2026-10-06 抓帧回放：三个 4s bash 工具间各有 1.3–2.6s 无任何输出，
// 旧黑名单口径下这些空档全留在分母里，读数从 ~80 摊到 11）。
describe('turnClock tps 白名单（E20）', () => {
  beforeEach(() => clearTurnClock())

  it('工具执行与工具间空档都不进分母：读数冻结在最后测得值', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    addOutputChars('s1', 400, 1_500) // burst [1s,1.5s]：800 字符 ÷ 0.5s
    updateTurnTool('s1', 'a', 'in_progress', 1_500)
    // 工具执行 4s（静默）：分母不涨，读数一动不动
    expect(turnTps('s1', 5_500)).toBe(400)
    updateTurnTool('s1', 'a', 'completed', 5_500)
    // 工具完成后又是 2.5s 无输出（agent 循环空档）：依旧不动
    expect(turnTps('s1', 8_000)).toBe(400)
    // 恢复吐字：新起一段，两段字符合计 ÷ 合计时长
    addOutputChars('s1', 400, 8_500)
    addOutputChars('s1', 400, 9_000)
    expect(turnTps('s1', 9_000)).toBe(400)
  })

  it('间隔阈值内的静默仍计入：开放 burst 的窗口含 ≤1s 容差', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 0)
    addOutputChars('s1', 400, 800) // 同一 burst
    // 距上一 chunk 900ms，未超阈值 → 开放窗口延长到 now
    expect(turnTps('s1', 1_700)).toBe(800 / 4 / 1.7)
    // 超过阈值：闭合在末 chunk，窗口固定 800ms
    expect(turnTps('s1', 2_000)).toBe(800 / 4 / 0.8)
  })

  it('定稿前的孤立尾 chunk 不带字符：宁缺毋滥', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 0)
    addOutputChars('s1', 400, 500) // burst [0,500ms]
    addOutputChars('s1', 4, 5_000) // 定稿前一句 "done"：与前段间隔远超阈值
    endTurn('s1', 6_100)
    // 尾段孤立、burst 已闭合 → 其 4 字符不进分子（不稀释，也不虚构时长）
    expect(finalTps('s1')).toBe(400) // 800 字符 ÷ 0.5s
  })
})
