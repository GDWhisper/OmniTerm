import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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

import { filterDirEntries, useDirBrowser } from './useDirBrowser'
import { api, ApiError } from '../api/client'

// The vi.mock factory's ApiError has signature (message, status, body),
// which differs from the real class — cast to the mock signature.
const MockApiError = ApiError as unknown as new (
  message: string,
  status: number,
  body?: unknown,
) => ApiError

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

// ── Hook behavior ──
// Rendered via a probe component (no @testing-library/react in deps).

type HookResult = ReturnType<typeof useDirBrowser>

function Probe(props: { onResult: (r: HookResult) => void }) {
  props.onResult(useDirBrowser())
  return null
}

describe('useDirBrowser', () => {
  let container: HTMLDivElement
  let root: Root
  let hook: HookResult

  beforeEach(() => {
    vi.clearAllMocks()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(createElement(Probe, { onResult: (r: HookResult) => { hook = r } }))
    })
  })

  afterEach(() => {
    act(() => { root.unmount() })
    document.body.removeChild(container)
  })

  it('loads and filters directory entries; prefix narrows case-insensitively', async () => {
    vi.mocked(api.listDirs).mockResolvedValue({ files } as never)
    await act(async () => { await hook.loadDirs('/home', 'om') })
    expect(api.listDirs).toHaveBeenCalledWith('/home')
    expect(hook.loading).toBe(false)
    expect(hook.error).toBeNull()
    expect(hook.notFound).toBe(false)
    expect(hook.entries.map(f => f.name)).toEqual(['OmniTerm', 'omniterm-dev'])
  })

  it('404 sets notFound with empty entries', async () => {
    vi.mocked(api.listDirs).mockRejectedValue(new MockApiError('not found', 404))
    await act(async () => { await hook.loadDirs('/nope') })
    expect(hook.notFound).toBe(true)
    expect(hook.entries).toEqual([])
    expect(hook.error).toBeNull()
  })

  it('other failures set the error message', async () => {
    vi.mocked(api.listDirs).mockRejectedValue(new MockApiError('boom', 500))
    await act(async () => { await hook.loadDirs('/home') })
    expect(hook.error).toBe('boom')
    expect(hook.notFound).toBe(false)
  })

  it('reset blanks entries/error/notFound back to the pristine state', async () => {
    vi.mocked(api.listDirs).mockRejectedValue(new MockApiError('not found', 404))
    await act(async () => { await hook.loadDirs('/nope') })
    expect(hook.notFound).toBe(true)
    act(() => { hook.reset() })
    expect(hook.entries).toEqual([])
    expect(hook.error).toBeNull()
    expect(hook.notFound).toBe(false)
    expect(hook.loading).toBe(false)
  })
})
