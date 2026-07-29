import { describe, it, expect } from 'vitest'
import { getParentPath } from './path'

describe('getParentPath', () => {
  it('returns empty for root and empty input', () => {
    expect(getParentPath('')).toBe('')
    expect(getParentPath('/')).toBe('')
    expect(getParentPath('/a')).toBe('')
  })

  it('handles unix paths', () => {
    expect(getParentPath('/a/b')).toBe('/a')
    expect(getParentPath('/a/b/')).toBe('/a')
    expect(getParentPath('a/b')).toBe('a')
  })

  it('handles windows drive paths', () => {
    // Parent of a first-level dir is the rooted drive, not drive-relative 'G:'
    expect(getParentPath('G:/Codes')).toBe('G:/')
    expect(getParentPath('g:/Codes/ot')).toBe('g:/Codes')
    // Drive root has no parent
    expect(getParentPath('G:/')).toBe('')
    expect(getParentPath('G:')).toBe('')
  })
})
