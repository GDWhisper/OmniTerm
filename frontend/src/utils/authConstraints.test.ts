import { describe, it, expect } from 'vitest'
import {
  CONTROL_CHARS_RE,
  isValidUsernameShape,
  MAX_USERNAME_CHARS,
  MIN_PASSWORD_LEN,
} from './authConstraints'

describe('authConstraints（与后端 normalize_username 同契约的单一真源）', () => {
  it('accepts trimmed names at the code-point boundary', () => {
    expect(isValidUsernameShape('  alice  ')).toBe(true)
    expect(isValidUsernameShape('a'.repeat(32))).toBe(true)
    // 32 个 emoji = 64 个 UTF-16 码元但只有 32 个码点（后端 chars().count() 同判）
    expect(isValidUsernameShape('🚀'.repeat(32))).toBe(true)
    expect(isValidUsernameShape('a'.repeat(33))).toBe(false)
    expect(isValidUsernameShape('🚀'.repeat(33))).toBe(false)
  })

  it('rejects empty/blank and control characters', () => {
    expect(isValidUsernameShape('')).toBe(false)
    expect(isValidUsernameShape('   ')).toBe(false)
    expect(isValidUsernameShape('bad\tname')).toBe(false)
    expect(isValidUsernameShape('bad\u0001name')).toBe(false)
    expect(isValidUsernameShape('bad\u007fname')).toBe(false)
  })

  it('pins the shared constants (both components rely on them)', () => {
    expect(MAX_USERNAME_CHARS).toBe(32)
    expect(MIN_PASSWORD_LEN).toBe(4)
    expect(CONTROL_CHARS_RE.test('\u009f')).toBe(true)
  })
})
