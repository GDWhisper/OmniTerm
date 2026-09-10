import { describe, it, expect, beforeEach } from 'vitest'
import {
  MAX_TRACKED_TURNS,
  addOutputChars,
  beginTurn,
  clearTurnClock,
  computeTps,
  endTurn,
  finalTps,
  setTurnWaiting,
  trackedTurnCount,
  turnElapsedMs,
  turnTps,
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
})
