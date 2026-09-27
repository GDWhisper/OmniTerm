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

  it('实时读数同样扣除审批挂起时长（与 turnElapsedMs 同口径）', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 40, 0)
    setTurnWaiting('s1', true, 1_000)
    // 1000→5000 挂起，解码窗口只剩 1s → 10 t/s
    expect(turnTps('s1', 5_000)).toBe(10)
  })

  it('审批挂起期间速度读数一动不动，解除后从冻结点继续走时', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    setTurnWaiting('s1', true, 2_000)
    // 冻结点取挂起那一刻的工作坐标（2s），解码窗口此后不再增长。
    expect(turnTps('s1', 2_000)).toBe(100)
    // 挂 5 分钟：读数必须完全不动，不能随真人思考时间缓慢跌落。
    expect(turnTps('s1', 300_000)).toBe(100)
    setTurnWaiting('s1', false, 302_000)
    // 解除后工作时钟从冻结点续走（302−300=2s），不是从 0 重新起算。
    expect(turnTps('s1', 302_000)).toBe(100)
    // 首字锚点在 1s：1s 等待不进分母，读数按解码窗口 3s 走。
    expect(turnTps('s1', 304_000)).toBe(400 / 4 / 3)
  })

  it('审批挂起与工具并集同时冻住，挂起段不计入工具也不白送生成时间', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 0)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    setTurnWaiting('s1', true, 2_000)
    // 工具并集跨度也冻在挂起那一刻（1s），不随等待增长；该 1s 已从分母扣除，故读数是 100。
    expect(turnToolElapsedMs('s1', 120_000)).toBe(1_000)
    expect(turnTps('s1', 120_000)).toBe(100)
    // 挂起期间到达的输出：封口点取冻结的工作坐标，不把等待算成生成时间。
    addOutputChars('s1', 400, 60_000)
    expect(turnTps('s1', 60_000)).toBe(200)
    setTurnWaiting('s1', false, 122_000)
    // 挂起的那 120s 不计入工具并集，分子分母都不含它。
    expect(turnElapsedMs('s1', 122_000)).toBe(2_000)
    expect(turnToolElapsedMs('s1', 122_000)).toBe(1_000)
    expect(turnTps('s1', 122_000)).toBe(200)
  })

  it('首字前的等待不进分母：解码窗口从首个输出起算', () => {
    beginTurn('s1', 0)
    // 模型 8s 后才吐第一个字：这段时间零输出，计入只会摊薄读数（对齐 dsh decode-only）。
    addOutputChars('s1', 1_200, 8_000)
    expect(turnTps('s1', 8_000)).toBeNull() // 锚点即此刻，窗口长度 0
    addOutputChars('s1', 1_200, 9_000)
    // 1s 解码窗口内 2_400 字符 → 600 token ÷ 1s（8s 首字延迟被排除）
    expect(turnTps('s1', 9_000)).toBe(600)
  })

  it('endTurn 冻结最终值：turnTps/turnElapsedMs 归 null，finalTps 保留', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 80, 0)
    endTurn('s1', 2_000)
    expect(turnTps('s1', 3_000)).toBeNull()
    expect(turnElapsedMs('s1', 3_000)).toBeNull()
    expect(finalTps('s1')).toBe(10) // 80/4/2
  })

  it('重复 endTurn 不覆盖已冻结的快照', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 80, 0)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    updateTurnTool('s1', 'a', 'completed', 2_000)
    endTurn('s1', 2_000)
    // 工作时长 2s、其中纯工具 1s → 80/4/1s = 20 t/s；工具耗时 1s
    expect(finalTps('s1')).toBe(20)
    expect(finalToolElapsedMs('s1')).toBe(1_000)

    endTurn('s1', 9_000) // 无在建 turn：第二次结束是 no-op，不覆盖上面的冻结值
    expect(finalTps('s1')).toBe(20)
    expect(finalToolElapsedMs('s1')).toBe(1_000)
  })

  it('本轮 0 输出定稿会把上一 turn 的快照清掉，不把旧值错配到新消息', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 40, 0)
    endTurn('s1', 1_000)
    expect(finalTps('s1')).toBe(10)

    beginTurn('s1', 2_000)
    endTurn('s1', 3_000) // 无输出
    expect(finalTps('s1')).toBeNull()
  })

  it('finalTps 快照同样有界：超过上限丢最旧条目', () => {
    for (let i = 0; i <= MAX_TRACKED_TURNS; i++) {
      beginTurn(`s${i}`, 0)
      addOutputChars(`s${i}`, 40, 0)
      endTurn(`s${i}`, 1_000)
    }
    expect(finalTps('s0')).toBeNull()
    expect(finalTps(`s${MAX_TRACKED_TURNS}`)).toBe(10)
  })

  it('估算失效的 turn 不留空快照占位，不把别的会话的真实快照挤出上限', () => {
    for (let i = 0; i < MAX_TRACKED_TURNS; i++) {
      beginTurn(`s${i}`, 0)
      addOutputChars(`s${i}`, 40, 0)
      endTurn(`s${i}`, 1_000)
    }
    expect(finalTps('s0')).toBe(10)

    // 工具数溢出 → 本窗口估算整体失效，定稿时两项都无读数
    beginTurn('bad', 0)
    for (let i = 0; i <= MAX_ACTIVE_TURN_TOOLS; i++) updateTurnTool('bad', `t${i}`, 'in_progress', 1_000)
    endTurn('bad', 2_000)
    expect(finalTps('bad')).toBeNull()
    expect(finalToolElapsedMs('bad')).toBeNull()
    expect(finalTps('s0')).toBe(10) // s0 仍是最旧的真实快照，未被占位条目挤掉
  })
})

describe('turnClock observed tool intervals', () => {
  beforeEach(() => clearTurnClock())

  it('首个输出落在工具并集内：封口前的工具段不进解码分母', () => {
    beginTurn('s1', 0)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    // 工具执行 3s 后模型开始说话：锚点落在 4s，[1s,4s] 封口为纯工具
    addOutputChars('s1', 1_200, 4_000)
    expect(turnTps('s1', 4_000)).toBeNull() // 零长度窗口，不把工具时间算成生成
    updateTurnTool('s1', 'a', 'completed', 6_000)
    // 封口后的并集内生成 [4s,6s] 留在分母 → 300 token ÷ 2s
    expect(turnTps('s1', 6_000)).toBe(150)
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
    // 首字锚点 1s；解码窗口 [1s,8s] 去掉 6s 纯工具并集，剩 1s → 100
    expect(turnTps('s1', 8_000)).toBe(100)
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
    // 首字锚点 1s；解码窗口 [1s,7s] 去掉 2s 工具，剩 4s → 25
    expect(turnTps('s1', 7_000)).toBe(25)
  })

  it('pauses the generation clock at the first prose inside a tool union, then resumes', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    setTurnWaiting('s1', true, 2_000)
    setTurnWaiting('s1', false, 4_000)
    // 首字之后的窗口整段落在工具并集内且无后续输出：无解码时长 → null，
    // 速度不随工具执行跌落入分母、也不拿首字前的 1s 虚报。
    expect(turnTps('s1', 5_000)).toBeNull()
    expect(turnTps('s1', 6_000)).toBeNull()
    // 首次输出到达：把「工具起点 → 此刻」封口为纯工具时间（3s 工作坐标内的 2s），
    // 解码零点仍是 1s；封口之后重新走时。此刻窗口仍为 0 → null。
    addOutputChars('s1', 400, 5_000)
    expect(turnTps('s1', 5_000)).toBeNull()
    // 解码窗口 [1s,6s] 去掉封口的 2s，剩 1s → 800/4/1
    expect(turnTps('s1', 6_000)).toBe(200)
    updateTurnTool('s1', 'b', 'in_progress', 6_000)
    updateTurnTool('s1', 'a', 'completed', 7_000)
    updateTurnTool('s1', 'b', 'completed', 8_000)
    updateTurnTool('s1', 'c', 'in_progress', 9_000)
    endTurn('s1', 11_000)
    // 展示口径仍是完整并集（7s），封口只影响分母：解码窗口 9−1=8s 去掉闭合纯工具 2s
    // 与开放并集 2s，剩 4s → 800/4 ÷ 4s。
    expect(finalToolElapsedMs('s1')).toBe(7_000)
    expect(finalTps('s1')).toBe(50)
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
    // 新窗口首个输出即锚点：窗口长度 0 → null，不把重连前的等待算成生成时间。
    expect(turnTps('s1', 12_000)).toBeNull()
    addOutputChars('s1', 400, 14_000)
    // 新窗口 2s 内 800 字符 → 200 token ÷ 2s；旧工具段已由锚点基线排除，不重复扣。
    expect(turnTps('s1', 14_000)).toBe(100)
    expect(turnElapsedMs('s1', 14_000)).toBe(14_000)
    endTurn('s1', 14_000)
    expect(finalToolElapsedMs('s1')).toBe(5_000)
    expect(finalTps('s1')).toBe(100)
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

  it('bounds ID size and never finalizes a truncated tracking window as a valid estimate', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'x'.repeat(MAX_TURN_TOOL_ID_LENGTH + 1), 'in_progress', 1_000)
    endTurn('s1', 2_000)
    expect(finalTps('s1')).toBeNull()
    expect(finalToolElapsedMs('s1')).toBeNull()
  })

  it('releases completed IDs so sequential tools do not exhaust active tracking', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    for (let i = 0; i <= MAX_ACTIVE_TURN_TOOLS; i++) {
      updateTurnTool('s1', `tool-${i}`, 'in_progress', 1_000 + i)
      updateTurnTool('s1', `tool-${i}`, 'completed', 1_001 + i)
    }
    // 估算仍有效：解码窗口 [1s,3.257s] 去掉 257ms 工具段，剩 2s → 1_600/4 ÷ 2s
    addOutputChars('s1', 1_200, 2_257)
    expect(turnTps('s1', 3_257)).toBe(200)
  })

  it('bounds tool snapshots with rates and clears both on a new turn', () => {
    for (let i = 0; i <= MAX_TRACKED_TURNS; i++) {
      beginTurn(`s${i}`, 0)
      addOutputChars(`s${i}`, 400, 1_000)
      updateTurnTool(`s${i}`, 'a', 'in_progress', 1_000)
      endTurn(`s${i}`, 2_000)
    }
    expect(finalToolElapsedMs('s0')).toBeNull()
    expect(finalTps('s0')).toBeNull()
    expect(finalToolElapsedMs(`s${MAX_TRACKED_TURNS}`)).toBe(1_000)
    // 首字之后窗口整段在工具内 → 无解码速率，快照 tps 为 null 但工具读数保留
    expect(finalTps(`s${MAX_TRACKED_TURNS}`)).toBeNull()
    beginTurn(`s${MAX_TRACKED_TURNS}`, 3_000)
    endTurn(`s${MAX_TRACKED_TURNS}`, 4_000)
    expect(finalToolElapsedMs(`s${MAX_TRACKED_TURNS}`)).toBe(0)
    expect(finalTps(`s${MAX_TRACKED_TURNS}`)).toBeNull()
  })
})
