import { describe, it, expect } from 'vitest'
import { getParentPath, isPathOutsideWorkspace } from './path'

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

describe('isPathOutsideWorkspace', () => {
  it('treats undefined/null/empty workspaceRoot as outside (safe default)', () => {
    expect(isPathOutsideWorkspace('/any/path', undefined)).toBe(true)
    expect(isPathOutsideWorkspace('/any/path', null)).toBe(true)
    expect(isPathOutsideWorkspace('/any/path', '')).toBe(true)
  })

  it('returns false for a file inside the workspace', () => {
    expect(isPathOutsideWorkspace('/home/user/proj/src/main.rs', '/home/user/proj')).toBe(false)
    expect(isPathOutsideWorkspace('/home/user/proj', '/home/user/proj')).toBe(false)
  })

  it('does not match a sibling prefix as inside (boundary check)', () => {
    // /home/a 不得误匹配 /home/ab
    expect(isPathOutsideWorkspace('/home/ab/file.txt', '/home/a')).toBe(true)
    expect(isPathOutsideWorkspace('/home/a/file.txt', '/home/a')).toBe(false)
  })

  it('normalizes trailing slashes on workspaceRoot', () => {
    expect(isPathOutsideWorkspace('/home/user/proj/file.txt', '/home/user/proj/')).toBe(false)
    expect(isPathOutsideWorkspace('/home/user/proj2/file.txt', '/home/user/proj/')).toBe(true)
  })

  it('treats filesystem root as containing everything', () => {
    expect(isPathOutsideWorkspace('/etc/hosts', '/')).toBe(false)
    expect(isPathOutsideWorkspace('/', '/')).toBe(false)
  })

  it('treats a file above the workspace root as outside', () => {
    expect(isPathOutsideWorkspace('/home/user/other.txt', '/home/user/proj')).toBe(true)
    expect(isPathOutsideWorkspace('/tmp/x', '/home/user/proj')).toBe(true)
  })
})
