import { describe, it, expect, beforeEach } from 'vitest'
import {
  MAX_TRACKED_SESSIONS,
  clearAllLiveTurnStats,
  clearLiveTurnStats,
  getLiveTurnStats,
  setLiveTurnStats,
  subscribeLiveTurnStats,
} from './turnStats'

// turnStats 是后端 `turn_stats` 推送的纯缓存（前端只显示不计算，见 work-time 计划
// E23）：这里钉住缓存本身的契约——有界淘汰（§P1）、订阅通知、清理语义。
// 读数口径的回归在 `src/acp/turn_accumulator.rs`。

describe('turnStats', () => {
  beforeEach(() => clearAllLiveTurnStats())

  it('set / get 往返，替换同会话即更新新鲜度', () => {
    setLiveTurnStats('s1', { workMs: 1_000, toolMs: null, tps: null })
    expect(getLiveTurnStats('s1')).toEqual({ workMs: 1_000, toolMs: null, tps: null })
    setLiveTurnStats('s1', { workMs: 2_000, toolMs: 500, tps: 42.5 })
    expect(getLiveTurnStats('s1')).toEqual({ workMs: 2_000, toolMs: 500, tps: 42.5 })
    expect(getLiveTurnStats('missing')).toBeNull()
  })

  it('上限外插入淘汰最旧的会话（§P1 有界，不无界累积）', () => {
    for (let i = 0; i <= MAX_TRACKED_SESSIONS; i++) {
      setLiveTurnStats(`s${i}`, { workMs: i, toolMs: null, tps: null })
    }
    expect(getLiveTurnStats('s0')).toBeNull()
    expect(getLiveTurnStats(`s${MAX_TRACKED_SESSIONS}`)).toEqual({
      workMs: MAX_TRACKED_SESSIONS,
      toolMs: null,
      tps: null,
    })
  })

  it('订阅回调收到推送值与清理通知（null），退订后不再触发', () => {
    const seen: Array<{ workMs: number } | null> = []
    const unsubscribe = subscribeLiveTurnStats('s1', (stats) => seen.push(stats))

    setLiveTurnStats('s1', { workMs: 100, toolMs: null, tps: null })
    clearLiveTurnStats('s1')
    expect(seen).toEqual([{ workMs: 100, toolMs: null, tps: null }, null])

    unsubscribe()
    setLiveTurnStats('s1', { workMs: 200, toolMs: null, tps: null })
    expect(seen).toHaveLength(2)
  })

  it('订阅只收本会话的推送，不串号', () => {
    const seen: Array<{ workMs: number } | null> = []
    const unsubscribe = subscribeLiveTurnStats('other', (stats) => seen.push(stats))
    setLiveTurnStats('s1', { workMs: 100, toolMs: null, tps: null })
    expect(seen).toEqual([])
    unsubscribe()
  })
})
