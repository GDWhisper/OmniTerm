import { describe, it, expect } from 'vitest'
import { nextSessionId } from './sessionNav'

const ids = ['a', 'b', 'c']

describe('nextSessionId', () => {
  it('advances and wraps around', () => {
    expect(nextSessionId(ids, 'a', 'next')).toBe('b')
    expect(nextSessionId(ids, 'c', 'next')).toBe('a')
  })
  it('retreats and wraps around', () => {
    expect(nextSessionId(ids, 'a', 'prev')).toBe('c')
    expect(nextSessionId(ids, 'b', 'prev')).toBe('a')
  })
  it('returns null when fewer than 2 sessions', () => {
    expect(nextSessionId(['a'], 'a', 'next')).toBeNull()
    expect(nextSessionId([], null, 'next')).toBeNull()
  })
  it('starts from first when active id unknown', () => {
    expect(nextSessionId(ids, 'zzz', 'next')).toBe('a')
    expect(nextSessionId(ids, null, 'next')).toBe('a')
  })
})
