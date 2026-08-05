import { describe, it, expect, vi, afterEach } from 'vitest'
import { api } from './client'

/**
 * Capture the URLs passed to global fetch so tests can assert on the
 * constructed query string. Returns a list of `[url, init]` calls.
 */
function mockFetch(): [string, RequestInit | undefined][] {
  const calls: [string, RequestInit | undefined][] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([String(_input), init])
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
    }),
  )
  return calls
}

function lastUrl(calls: [string, RequestInit | undefined][]): string {
  const [url] = calls[calls.length - 1]
  return url
}

describe('api allowEscape passthrough', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deleteFile2: default omits allow_escape, allowEscape:true appends it', async () => {
    const calls = mockFetch()

    await api.deleteFile2({ path: 'a.txt', workspaceId: 'w1' })
    expect(lastUrl(calls)).toBe('/api/v1/files?path=a.txt&workspace_id=w1')
    expect(lastUrl(calls)).not.toContain('allow_escape')

    await api.deleteFile2({ path: 'a.txt', workspaceId: 'w1', allowEscape: true })
    expect(lastUrl(calls)).toBe('/api/v1/files?path=a.txt&workspace_id=w1&allow_escape=true')
  })

  it('writeFile2: default omits allow_escape, allowEscape:true appends it', async () => {
    const calls = mockFetch()

    await api.writeFile2({ path: 'a.txt', workspaceId: 'w1', content: 'hi' })
    expect(lastUrl(calls)).toBe('/api/v1/files/write?path=a.txt&workspace_id=w1')
    expect(lastUrl(calls)).not.toContain('allow_escape')

    await api.writeFile2({ path: 'a.txt', workspaceId: 'w1', content: 'hi', allowEscape: true })
    expect(lastUrl(calls)).toBe('/api/v1/files/write?path=a.txt&workspace_id=w1&allow_escape=true')
  })

  it('mkdir2: default has no query, allowEscape:true appends query param', async () => {
    const calls = mockFetch()

    await api.mkdir2({ path: 'd', name: 'new', workspaceId: 'w1' })
    expect(lastUrl(calls)).toBe('/api/v1/files/mkdir')
    expect(lastUrl(calls)).not.toContain('allow_escape')

    await api.mkdir2({ path: 'd', name: 'new', workspaceId: 'w1', allowEscape: true })
    expect(lastUrl(calls)).toBe('/api/v1/files/mkdir?allow_escape=true')
  })

  it('rename2: default has no query, allowEscape:true appends query param', async () => {
    const calls = mockFetch()

    await api.rename2({ path: 'a.txt', newName: 'b.txt', workspaceId: 'w1' })
    expect(lastUrl(calls)).toBe('/api/v1/files/rename')
    expect(lastUrl(calls)).not.toContain('allow_escape')

    await api.rename2({ path: 'a.txt', newName: 'b.txt', workspaceId: 'w1', allowEscape: true })
    expect(lastUrl(calls)).toBe('/api/v1/files/rename?allow_escape=true')
  })

  it('moveFiles2: default has no query, allowEscape:true appends query param', async () => {
    const calls = mockFetch()

    await api.moveFiles2({ paths: ['a.txt'], destination: 'd', workspaceId: 'w1' })
    expect(lastUrl(calls)).toBe('/api/v1/files/move')
    expect(lastUrl(calls)).not.toContain('allow_escape')

    await api.moveFiles2({ paths: ['a.txt'], destination: 'd', workspaceId: 'w1', allowEscape: true })
    expect(lastUrl(calls)).toBe('/api/v1/files/move?allow_escape=true')
  })

  it('uploadFile2: default omits allow_escape, allowEscape:true appends it', async () => {
    const calls = mockFetch()
    const file = new File(['x'], 'a.txt', { type: 'text/plain' })

    await api.uploadFile2({ path: 'd', workspaceId: 'w1', file })
    expect(lastUrl(calls)).toBe('/api/v1/files?path=d&workspace_id=w1')
    expect(lastUrl(calls)).not.toContain('allow_escape')

    await api.uploadFile2({ path: 'd', workspaceId: 'w1', file, allowEscape: true })
    expect(lastUrl(calls)).toBe('/api/v1/files?path=d&workspace_id=w1&allow_escape=true')
  })

  it('listFiles2 return type exposes workspace_root', async () => {
    const calls = mockFetch()
    const data = await api.listFiles2({ workspaceId: 'w1' })
    // Type-level assertion: workspace_root must be an optional string field.
    const workspaceRoot: string | undefined = data.workspace_root
    expect(workspaceRoot).toBeUndefined()
    expect(lastUrl(calls)).toBe('/api/v1/files?path=&workspace_id=w1')
  })
})
