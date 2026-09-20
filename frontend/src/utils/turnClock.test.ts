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
    addOutputChars('s1', 40)
    expect(turnTps('s1', 1_000)).toBe(10)
    addOutputChars('s1', 40)
    expect(turnTps('s1', 2_000)).toBe(10)
    // 非正数 / NaN 会污染估算，直接丢弃
    addOutputChars('s1', 0)
    addOutputChars('s1', -5)
    addOutputChars('s1', Number.NaN)
    expect(turnTps('s1', 2_000)).toBe(10)
  })

  it('实时读数同样扣除审批挂起时长（与 turnElapsedMs 同口径）', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 40)
    setTurnWaiting('s1', true, 1_000)
    // 1000→5000 挂起，工作实际只有 1s → 10 t/s
    expect(turnTps('s1', 5_000)).toBe(10)
  })

  it('endTurn 冻结最终值：turnTps/turnElapsedMs 归 null，finalTps 保留', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 80)
    endTurn('s1', 2_000)
    expect(turnTps('s1', 3_000)).toBeNull()
    expect(turnElapsedMs('s1', 3_000)).toBeNull()
    expect(finalTps('s1')).toBe(10) // 80/4/2
  })

  it('重复 endTurn 不覆盖已冻结的快照', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 80)
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
    addOutputChars('s1', 40)
    endTurn('s1', 1_000)
    expect(finalTps('s1')).toBe(10)

    beginTurn('s1', 2_000)
    endTurn('s1', 3_000) // 无输出
    expect(finalTps('s1')).toBeNull()
  })

  it('finalTps 快照同样有界：超过上限丢最旧条目', () => {
    for (let i = 0; i <= MAX_TRACKED_TURNS; i++) {
      beginTurn(`s${i}`, 0)
      addOutputChars(`s${i}`, 40)
      endTurn(`s${i}`, 1_000)
    }
    expect(finalTps('s0')).toBeNull()
    expect(finalTps(`s${MAX_TRACKED_TURNS}`)).toBe(10)
  })

  it('估算失效的 turn 不留空快照占位，不把别的会话的真实快照挤出上限', () => {
    for (let i = 0; i < MAX_TRACKED_TURNS; i++) {
      beginTurn(`s${i}`, 0)
      addOutputChars(`s${i}`, 40)
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

  it('keeps 10s of tools in work but out of the 1s generation denominator', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    expect(turnElapsedMs('s1', 11_000)).toBe(11_000)
    expect(turnToolElapsedMs('s1', 11_000)).toBe(10_000)
    expect(turnTps('s1', 11_000)).toBe(100)
    endTurn('s1', 11_000)
    expect(turnToolElapsedMs('s1', 12_000)).toBeNull()
    expect(finalToolElapsedMs('s1')).toBe(10_000)
    expect(finalTps('s1')).toBe(100)
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
    expect(turnTps('s1', 8_000)).toBe(50)
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
    expect(turnTps('s1', 10_000)).toBe(100)
    endTurn('s1', 10_000)
    expect(finalToolElapsedMs('s1')).toBe(3_000)
    expect(finalTps('s1')).toBe(100)
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
    expect(turnTps('s1', 7_000)).toBe(20)
  })

  it('restores the entire open tool overlap to generation when prose arrives, until all tools close', () => {
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    setTurnWaiting('s1', true, 2_000)
    setTurnWaiting('s1', false, 4_000)
    expect(turnTps('s1', 5_000)).toBe(100)
    addOutputChars('s1', 400, 5_000)
    expect(turnTps('s1', 5_000)).toBeCloseTo(200 / 3)
    updateTurnTool('s1', 'b', 'in_progress', 6_000)
    updateTurnTool('s1', 'a', 'completed', 7_000)
    updateTurnTool('s1', 'b', 'completed', 8_000)
    updateTurnTool('s1', 'c', 'in_progress', 9_000)
    endTurn('s1', 11_000)
    expect(finalToolElapsedMs('s1')).toBe(7_000)
    expect(finalTps('s1')).toBeCloseTo(200 / 7)
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
    resumeTurnClock('s1', 10_000)
    expect(turnTps('s1', 10_000)).toBeNull()
    expect(turnToolElapsedMs('s1', 10_000)).toBe(0)
    setTurnWaiting('s1', false, 11_000)
    addOutputChars('s1', 400, 12_000)
    updateTurnTool('s1', 'a', undefined, 12_000)
    updateTurnTool('s1', 'b', 'in_progress', 12_000)
    expect(turnElapsedMs('s1', 14_000)).toBe(5_000)
    expect(turnToolElapsedMs('s1', 14_000)).toBe(2_000)
    expect(turnTps('s1', 14_000)).toBe(100)
    endTurn('s1', 14_000)
    expect(finalTps('s1')).toBe(100)
    expect(finalToolElapsedMs('s1')).toBe(2_000)
    resumeTurnClock('missing', 14_000)
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
    resumeTurnClock('s1', 3_000)
    addOutputChars('s1', 400, 4_000)
    expect(turnTps('s1', 4_000)).toBe(100)
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
    expect(turnTps('s1', 1_001 + MAX_ACTIVE_TURN_TOOLS)).toBe(100)
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
    expect(finalTps(`s${MAX_TRACKED_TURNS}`)).toBe(100)
    beginTurn(`s${MAX_TRACKED_TURNS}`, 3_000)
    endTurn(`s${MAX_TRACKED_TURNS}`, 4_000)
    expect(finalToolElapsedMs(`s${MAX_TRACKED_TURNS}`)).toBe(0)
    expect(finalTps(`s${MAX_TRACKED_TURNS}`)).toBeNull()
  })
})
