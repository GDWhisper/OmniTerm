import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../../api/client'
import { sortFileEntries } from './fileListSort'

function entry(overrides: Partial<FileEntry> & Pick<FileEntry, 'name'>): FileEntry {
  return {
    path_type: 'File',
    mtime: 0,
    size: 0,
    ...overrides,
  }
}

const entries: FileEntry[] = [
  entry({ name: 'zeta.txt', mtime: 2, size: 30 }),
  entry({ name: 'alpha.txt', mtime: 3, size: 10 }),
  entry({ name: 'dir-b', path_type: 'Dir', size: null, mtime: 1 }),
  entry({ name: 'dir-a', path_type: 'Dir', size: null, mtime: 4 }),
  entry({ name: 'same.txt', rel_path: 'b/same.txt', mtime: 5, size: 20 }),
  entry({ name: 'same.txt', rel_path: 'a/same.txt', mtime: 5, size: 20 }),
]

describe('sortFileEntries', () => {
  it('目录优先，名称升序，重复名按 rel_path 稳定区分', () => {
    const names = sortFileEntries(entries, 'name', false).map((e) => e.rel_path ?? e.name)
    expect(names).toEqual([
      'dir-a',
      'dir-b',
      'alpha.txt',
      'a/same.txt',
      'b/same.txt',
      'zeta.txt',
    ])
    const same = sortFileEntries(entries, 'name', false).filter((e) => e.name === 'same.txt')
    expect(same.map((e) => e.rel_path)).toEqual(['a/same.txt', 'b/same.txt'])
  })

  it('mtime / size 降序仍然目录优先', () => {
    const byMtime = sortFileEntries(entries, 'mtime', true)
    expect(byMtime.slice(0, 2).every((e) => e.path_type === 'Dir')).toBe(true)
    expect(byMtime[2].name).toBe('same.txt')

    const bySize = sortFileEntries(entries, 'size', true)
    expect(bySize.slice(0, 2).every((e) => e.path_type === 'Dir')).toBe(true)
    expect(bySize[2].name).toBe('zeta.txt')
  })
})
