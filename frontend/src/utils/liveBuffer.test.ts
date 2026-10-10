import { describe, it, expect } from 'vitest'
import {
  LiveBuffer,
  LIVE_BUFFER_MAX_ACTIONS,
  LIVE_BUFFER_MAX_BYTES,
} from './liveBuffer'
import type { SessionUpdateAction } from '../stores/chatStore'

// liveBuffer 的限界契约（docs/dev/performance-and-safety.md §P1）：
//   ① 上限维度必须匹配增长维度 —— 条数 + 字节两条，单测各自触发一次；
//   ② 超限策略是「立即 flush」而非静默丢弃（内容不丢，只是提前提交）；
//   ③ 守恒断言：合并后的正文逐字符等于各 chunk 之和（合并不得吞字）。
// 背景：隐藏页 rAF 停摆而 WS 帧照常到达，缓冲只由 rAF flush —— 离开浏览器
// 半小时回来时一次性提交上万条 action，`applyActionsToMessages` 每个 action
// 全量浅拷贝 messages，主线程阻塞数秒（用户体感「假死」）。

const text = (t: string): SessionUpdateAction => ({ kind: 'appendText', text: t })
const thought = (t: string): SessionUpdateAction => ({ kind: 'appendThought', text: t })
const tool = (id: string): SessionUpdateAction => ({
  kind: 'upsertTool',
  toolCallId: id,
  status: 'completed',
})

describe('LiveBuffer 相邻 prose 合并', () => {
  it('合并相邻同类 prose action，且逐字符守恒', () => {
    const buf = new LiveBuffer()
    const chunks = ['hello', ' ', 'world', '!']
    for (const c of chunks) buf.push(text(c))
    expect(buf.length).toBe(1)
    const batch = buf.take()
    expect(batch).toHaveLength(1)
    expect(batch[0]).toEqual({ kind: 'appendText', text: chunks.join('') })
    // 守恒：合并结果 == 各 chunk 之和（不得吞字/改序）
    expect((batch[0] as { text: string }).text).toBe(chunks.reduce((a, b) => a + b, ''))
  })

  it('空 chunk 不改变合并结果', () => {
    const buf = new LiveBuffer()
    buf.push(text('a'))
    buf.push(text(''))
    buf.push(text('b'))
    expect(buf.take()).toEqual([{ kind: 'appendText', text: 'ab' }])
  })

  it('appendThought 与 appendText 互不合并', () => {
    const buf = new LiveBuffer()
    buf.push(thought('think'))
    buf.push(text('say'))
    expect(buf.take()).toEqual([
      { kind: 'appendThought', text: 'think' },
      { kind: 'appendText', text: 'say' },
    ])
  })

  it('中间夹了结构性 action 时不跨它合并', () => {
    const buf = new LiveBuffer()
    buf.push(text('a'))
    buf.push(tool('t1'))
    buf.push(text('b'))
    expect(buf.take()).toHaveLength(3)
    expect(buf.take()).toHaveLength(0)
  })
})

describe('LiveBuffer 限界（P1：上限维度匹配增长维度）', () => {
  it('条数达上限时请求 flush，且此前不请求', () => {
    const buf = new LiveBuffer()
    for (let i = 0; i < LIVE_BUFFER_MAX_ACTIONS - 1; i++) {
      expect(buf.push(tool(`t${i}`))).toBe(false)
    }
    // 第 MAX 条入队即越界 → 调用方应立即 flush
    expect(buf.push(tool('last'))).toBe(true)
    expect(buf.length).toBe(LIVE_BUFFER_MAX_ACTIONS)
  })

  it('条数未超但字节超限时同样请求 flush（只限条数等于没限）', () => {
    const buf = new LiveBuffer()
    // 30KB × 80 = 2.4MB > LIVE_BUFFER_MAX_BYTES，而合并后只有 1 条 action
    const chunk = 'x'.repeat(30 * 1024)
    let flushRequested = false
    for (let i = 0; i < 80; i++) {
      if (buf.push(text(chunk))) flushRequested = true
    }
    expect(buf.length).toBe(1)
    expect(flushRequested).toBe(true)
    expect(buf.byteLength).toBeGreaterThan(LIVE_BUFFER_MAX_BYTES)
  })

  it('单条 action 自身超预算时仍入队并请求 flush（峰值 = 一条，不静默丢弃）', () => {
    const buf = new LiveBuffer()
    const huge = 'y'.repeat(LIVE_BUFFER_MAX_BYTES + 1024)
    expect(buf.push(text(huge))).toBe(true)
    expect(buf.length).toBe(1)
    expect(buf.take()).toEqual([{ kind: 'appendText', text: huge }])
  })

  it('字节按 UTF-8 计而非 UTF-16 码元', () => {
    const buf = new LiveBuffer()
    buf.push(text('你好')) // 2 个码元、6 字节
    expect(buf.byteLength).toBeGreaterThan('你好'.length)
    expect(buf.take()).toHaveLength(1)
  })

  it('take() 复位条数与字节总数（否则上限被历史占用而失效）', () => {
    const buf = new LiveBuffer()
    for (let i = 0; i < 10; i++) buf.push(text('chunk'))
    buf.take()
    expect(buf.length).toBe(0)
    expect(buf.byteLength).toBe(0)
    expect(buf.isEmpty()).toBe(true)
    // 复位后同样的推送量不应再触发越界
    for (let i = 0; i < 10; i++) expect(buf.push(text('chunk'))).toBe(false)
  })

  it('空缓冲 take() 返回空数组', () => {
    expect(new LiveBuffer().take()).toEqual([])
  })
})
