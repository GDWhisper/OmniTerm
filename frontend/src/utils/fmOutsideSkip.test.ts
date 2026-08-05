import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isOutsideSkipped, markOutsideSkipped } from './fmOutsideSkip'

const KEY = 'omniterm_fm_outside_skip'

/**
 * jsdom provides a real localStorage; reset it before each test so cases
 * never leak state into each other.
 */
beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('isOutsideSkipped', () => {
  it('returns false when workspaceRoot is undefined/null/empty', () => {
    expect(isOutsideSkipped(undefined)).toBe(false)
    expect(isOutsideSkipped(null)).toBe(false)
    expect(isOutsideSkipped('')).toBe(false)
  })

  it('returns false when localStorage is empty', () => {
    expect(isOutsideSkipped('/workspace')).toBe(false)
  })

  it('returns false for a root that has not been marked', () => {
    markOutsideSkipped('/a')
    expect(isOutsideSkipped('/b')).toBe(false)
  })

  it('returns true after markOutsideSkipped for the same root', () => {
    markOutsideSkipped('/workspace')
    expect(isOutsideSkipped('/workspace')).toBe(true)
  })

  it('persists a JSON array under the fixed localStorage key', () => {
    markOutsideSkipped('/workspace')
    const raw = localStorage.getItem(KEY)
    expect(raw).toBe(JSON.stringify(['/workspace']))
    expect(JSON.parse(raw!)).toEqual(['/workspace'])
  })

  it('accumulates multiple roots', () => {
    markOutsideSkipped('/a')
    markOutsideSkipped('/b')
    expect(isOutsideSkipped('/a')).toBe(true)
    expect(isOutsideSkipped('/b')).toBe(true)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['/a', '/b'])
  })

  it('deduplicates a root marked twice', () => {
    markOutsideSkipped('/a')
    markOutsideSkipped('/a')
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['/a'])
  })

  it('returns false on malformed stored data without throwing', () => {
    localStorage.setItem(KEY, '{not json')
    expect(isOutsideSkipped('/a')).toBe(false)
    // Non-array JSON also degrades gracefully
    localStorage.setItem(KEY, JSON.stringify({ root: '/a' }))
    expect(isOutsideSkipped('/a')).toBe(false)
  })

  it('ignores non-string entries inside the stored array', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a', 42, null]))
    expect(isOutsideSkipped('/a')).toBe(true)
    expect(isOutsideSkipped('42')).toBe(false)
  })

  it('does not throw when localStorage access throws (privacy mode)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(isOutsideSkipped('/a')).toBe(false)
  })
})

describe('markOutsideSkipped', () => {
  it('is a no-op for undefined/null/empty root', () => {
    markOutsideSkipped(undefined)
    markOutsideSkipped(null)
    markOutsideSkipped('')
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('preserves existing entries when appending', () => {
    markOutsideSkipped('/a')
    markOutsideSkipped('/b')
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['/a', '/b'])
  })

  it('does not throw when localStorage setItem throws (privacy mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => markOutsideSkipped('/a')).not.toThrow()
  })
})
