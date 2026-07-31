import { describe, it, expect } from 'vitest'
import { formatHoverTime } from './formatTime'

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
