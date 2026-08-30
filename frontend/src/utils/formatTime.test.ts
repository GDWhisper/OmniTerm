import { describe, it, expect } from 'vitest'
import { formatElapsed, formatHoverTime, formatSessionWork } from './formatTime'

// 用本地时区构造 Date（new Date(y, m, d, h, min)），断言在任何时区下都成立。
describe('formatHoverTime', () => {
  const now = new Date(2026, 6, 30, 14, 23) // 2026-07-30 14:23

  it('当天消息只显示 HH:mm', () => {
    const ms = new Date(2026, 6, 30, 9, 5).getTime()
    expect(formatHoverTime(ms, now)).toBe('09:05')
  })

  it('今年内跨天显示 MM-DD HH:mm', () => {
    const ms = new Date(2026, 6, 29, 23, 0).getTime()
    expect(formatHoverTime(ms, now)).toBe('07-29 23:00')
  })

  it('跨年显示 YYYY-MM-DD HH:mm', () => {
    const ms = new Date(2025, 11, 31, 23, 59).getTime()
    expect(formatHoverTime(ms, now)).toBe('2025-12-31 23:59')
  })
})

describe('formatElapsed', () => {
  it('亚秒不落 0s', () => {
    expect(formatElapsed(0)).toBe('<1s')
    expect(formatElapsed(999)).toBe('<1s')
  })

  it('秒级：不足 1 分钟只显示秒', () => {
    expect(formatElapsed(1000)).toBe('1s')
    expect(formatElapsed(59_999)).toBe('59s')
  })

  it('分级：满 1 分钟起不再显示秒', () => {
    expect(formatElapsed(60_000)).toBe('1m')
    expect(formatElapsed(3_599_999)).toBe('59m')
  })

  it('时级：满 1 小时显示 h+m', () => {
    expect(formatElapsed(3_600_000)).toBe('1h0m')
    expect(formatElapsed((2 * 3600 + 42 * 60) * 1000)).toBe('2h42m')
  })

  it('未知时长返回 null，不落 0s', () => {
    expect(formatElapsed(null)).toBeNull()
    expect(formatElapsed(undefined)).toBeNull()
  })
})

describe('formatSessionWork', () => {
  it('0 与未知一样不渲染（会话从无定稿 turn）', () => {
    expect(formatSessionWork(0)).toBeNull()
    expect(formatSessionWork(null)).toBeNull()
    expect(formatSessionWork(undefined)).toBeNull()
  })

  it('亚秒累计仍渲染，与「从未干活」区分', () => {
    expect(formatSessionWork(500)).toBe('<1s')
    expect(formatSessionWork(42_000)).toBe('42s')
  })
})
