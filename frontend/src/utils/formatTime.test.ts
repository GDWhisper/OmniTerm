import { describe, it, expect } from 'vitest'
import { formatHoverTime, formatWorkDuration } from './formatTime'

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

describe('formatWorkDuration', () => {
  // 单位字形由 Intl 按 locale 给出，测试显式传 locale 固定断言（运行时缺省跟随界面语言）。
  it('中文口语格式：0 说 0 秒、亚秒不落 0 秒，整分省秒，小时带分', () => {
    expect(formatWorkDuration(0, 'zh-CN')).toBe('0秒')
    expect(formatWorkDuration(999, 'zh-CN')).toBe('<1秒')
    expect(formatWorkDuration(42_000, 'zh-CN')).toBe('42秒')
    expect(formatWorkDuration(162_000, 'zh-CN')).toBe('2分钟42秒')
    expect(formatWorkDuration(180_000, 'zh-CN')).toBe('3分钟')
    expect(formatWorkDuration(3_720_000, 'zh-CN')).toBe('1小时2分钟')
  })

  it('英文走同一套分档规则，只换单位字形', () => {
    expect(formatWorkDuration(999, 'en')).toBe('<1s')
    expect(formatWorkDuration(42_000, 'en')).toBe('42s')
    expect(formatWorkDuration(162_000, 'en')).toBe('2m42s')
    expect(formatWorkDuration(180_000, 'en')).toBe('3m')
    expect(formatWorkDuration(3_720_000, 'en')).toBe('1h2m')
  })

  it('秒级四舍五入到整秒', () => {
    expect(formatWorkDuration(1_400, 'zh-CN')).toBe('1秒')
    expect(formatWorkDuration(1_600, 'zh-CN')).toBe('2秒')
  })

  it('未知时长返回 null（整行不渲染，区别于 0）', () => {
    expect(formatWorkDuration(null, 'zh-CN')).toBeNull()
    expect(formatWorkDuration(undefined, 'zh-CN')).toBeNull()
  })
})
