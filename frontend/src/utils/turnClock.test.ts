import { describe, it, expect, beforeEach } from 'vitest'
import {
  MAX_TRACKED_TURNS,
  beginTurn,
  clearTurnClock,
  endTurn,
  setTurnWaiting,
  trackedTurnCount,
  turnElapsedMs,
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
