import { describe, it, expect } from 'vitest'
import {
  PERM_TIMEOUT_NEVER_SECS,
  permTimeoutDuration,
  permTimeoutNoticeLabel,
  permTimeoutSeconds,
} from './permTimeout'

// 时长口径的回归（2026-10-01 起 detail 走秒制）：30 秒档若按分钟折算会渲染成
// 「0 分钟」，90 秒会成「1.5 分钟」——两条都必须报秒；历史行（只有 minutes）按 ×60 回退。

describe('permTimeoutSeconds', () => {
  it('prefers the seconds field', () => {
    expect(permTimeoutSeconds({ seconds: 30 })).toBe(30)
    expect(permTimeoutSeconds({ seconds: 1800, minutes: 45 })).toBe(1800)
  })

  it('falls back to legacy minutes payloads', () => {
    expect(permTimeoutSeconds({ minutes: 30 })).toBe(1800)
    expect(permTimeoutSeconds({ minutes: 1 })).toBe(60)
  })

  it('returns null when no duration is available', () => {
    expect(permTimeoutSeconds(undefined)).toBeNull()
    expect(permTimeoutSeconds(null)).toBeNull()
    expect(permTimeoutSeconds({})).toBeNull()
    expect(permTimeoutSeconds({ seconds: NaN, minutes: NaN })).toBeNull()
    // 「总是」档是合法值 0，不是缺失。
    expect(permTimeoutSeconds({ seconds: PERM_TIMEOUT_NEVER_SECS })).toBe(0)
  })
})

describe('permTimeoutDuration', () => {
  it('spells whole minutes in minutes and sub-minute notches in seconds', () => {
    expect(permTimeoutDuration(60)).toEqual({ key: 'system.permTimeout.durationMin', value: 1 })
    expect(permTimeoutDuration(1800)).toEqual({ key: 'system.permTimeout.durationMin', value: 30 })
    expect(permTimeoutDuration(30)).toEqual({ key: 'system.permTimeout.durationSec', value: 30 })
    // 90 秒不折成 1.5 分钟：档位本身是 30 秒粒度。
    expect(permTimeoutDuration(90)).toEqual({ key: 'system.permTimeout.durationSec', value: 90 })
  })

  it('has no duration for the never notch', () => {
    expect(permTimeoutDuration(PERM_TIMEOUT_NEVER_SECS)).toBeNull()
  })
})

describe('permTimeoutNoticeLabel', () => {
  it('switches the auto notice to the no-wait copy for the never notch', () => {
    expect(permTimeoutNoticeLabel('system.permTimeout.auto', 0)).toBe('system.permTimeout.autoAlways')
    // 非「总是」档 / abort 载荷沿用原 label。
    expect(permTimeoutNoticeLabel('system.permTimeout.auto', 30)).toBe('system.permTimeout.auto')
    expect(permTimeoutNoticeLabel('system.permTimeout.abort', 0)).toBe('system.permTimeout.abort')
    // 未知 label（历史中文行）原样透出，不做映射。
    expect(permTimeoutNoticeLabel('权限请求超时', 0)).toBe('权限请求超时')
  })
})
