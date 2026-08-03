import { describe, it, expect, vi } from 'vitest'

vi.mock('../api/client', () => ({
  api: { listDirs: vi.fn() },
  ApiError: class ApiError extends Error {
    status: number
    body: unknown
    constructor(message: string, status: number, body?: unknown) {
      super(message)
      this.status = status
      this.body = body
    }
  },
}))

import { filterDirEntries } from './useDirBrowser'

const files = [
  { name: 'OmniTerm', path: '/home/OmniTerm', path_type: 'Dir', size: 0 },
  { name: 'omniterm-dev', path: '/home/omniterm-dev', path_type: 'Dir', size: 0 },
  { name: 'notes.txt', path: '/home/notes.txt', path_type: 'File', size: 10 },
  { name: 'link-dir', path: '/home/link-dir', path_type: 'SymlinkDir', size: 0 },
  { name: 'other', path: '/home/other', path_type: 'Dir', size: 0 },
] as never as Parameters<typeof filterDirEntries>[0]

describe('filterDirEntries', () => {
  it('keeps only directories and symlinked directories', () => {
    expect(filterDirEntries(files).map(f => f.name)).toEqual(['OmniTerm', 'omniterm-dev', 'link-dir', 'other'])
  })

  it('filters case-insensitively by prefix when given', () => {
    expect(filterDirEntries(files, 'om').map(f => f.name)).toEqual(['OmniTerm', 'omniterm-dev'])
  })

  it('returns empty array when nothing matches prefix', () => {
    expect(filterDirEntries(files, 'zzz')).toEqual([])
  })
})
