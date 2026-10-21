import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { StoredMessage } from './storedMessages'
import { downloadMarkdown, exportFileName, fetchAllMessages } from './sessionExport'

function row(id: string): StoredMessage {
  return { id, role: 'user', text: id, createdAt: `2026-10-21T09:00:0${id}Z` }
}

/** 造一个按页返回的假 fetch：每页 `{ messages, nextCursor }`。 */
function fakeFetch(pages: Array<{ messages: StoredMessage[]; nextCursor?: string | null }>) {
  const urls: string[] = []
  let i = 0
  const impl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    urls.push(String(input))
    const page = pages[i++] ?? { messages: [] }
    return {
      ok: true,
      status: 200,
      json: async () => page,
    } as unknown as Response
  })
  return { impl, urls }
}

describe('fetchAllMessages', () => {
  it('循环翻页并按时间正序拼装（页序倒置 + 页内正序）', async () => {
    const { impl, urls } = fakeFetch([
      { messages: [row('3'), row('4')], nextCursor: 'c1' },
      { messages: [row('1'), row('2')], nextCursor: null },
    ])
    const res = await fetchAllMessages('sid', { fetchImpl: impl })
    expect(res.rows.map((r) => r.id)).toEqual(['1', '2', '3', '4'])
    expect(res.pages).toBe(2)
    expect(res.truncated).toBe(false)
    expect(urls[0]).not.toContain('before=')
    expect(urls[1]).toContain('before=c1')
  })

  it('nextCursor 为空即停（不空转）', async () => {
    const { impl, urls } = fakeFetch([{ messages: [row('1')], nextCursor: null }])
    const res = await fetchAllMessages('sid', { fetchImpl: impl })
    expect(urls).toHaveLength(1)
    expect(res.rows).toHaveLength(1)
  })

  it('页数上限触顶且仍有更早历史 → 标记截断', async () => {
    const { impl } = fakeFetch([
      { messages: [row('2')], nextCursor: 'c1' },
      { messages: [row('1')], nextCursor: 'c2' },
    ])
    const res = await fetchAllMessages('sid', { fetchImpl: impl, maxPages: 2 })
    expect(res.truncated).toBe(true)
    expect(res.pages).toBe(2)
  })

  it('HTTP 失败即抛错（不静默产出残缺导出件）', async () => {
    const impl = vi.fn(
      async (): Promise<Response> =>
        ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response,
    )
    await expect(fetchAllMessages('sid', { fetchImpl: impl })).rejects.toThrow(/500/)
  })

  it('每页完成回调推进度', async () => {
    const { impl } = fakeFetch([
      { messages: [row('2'), row('3')], nextCursor: 'c1' },
      { messages: [row('1')], nextCursor: null },
    ])
    const seen: number[] = []
    await fetchAllMessages('sid', { fetchImpl: impl, onProgress: (n) => seen.push(n) })
    expect(seen).toEqual([2, 3])
  })

  it('原始载荷预算触顶即停拉并标记截断（不把浏览器内存吃满）', async () => {
    const heavy = { ...row('h'), text: 'x'.repeat(100) }
    const { impl, urls } = fakeFetch([
      { messages: [heavy], nextCursor: 'c1' },
      { messages: [heavy], nextCursor: 'c2' },
      { messages: [row('z')], nextCursor: null },
    ])
    const res = await fetchAllMessages('sid', { fetchImpl: impl, maxPayloadChars: 150 })
    expect(res.truncated).toBe(true)
    expect(urls).toHaveLength(2)
  })
})

describe('exportFileName', () => {
  it('会话名 + .md', () => {
    expect(exportFileName('demo')).toBe('demo.md')
  })

  it('路径分隔符等文件名敏感字符被替换', () => {
    expect(exportFileName('a/b\\c:d')).toBe('a_b_c_d.md')
  })

  it('空名兜底', () => {
    expect(exportFileName('   ')).toBe('session.md')
  })
})

describe('downloadMarkdown', () => {
  const created: Blob[] = []
  const revoked: string[] = []
  let originalCreate: unknown
  let originalRevoke: unknown

  beforeEach(() => {
    created.length = 0
    revoked.length = 0
    originalCreate = (URL as unknown as Record<string, unknown>).createObjectURL
    originalRevoke = (URL as unknown as Record<string, unknown>).revokeObjectURL
    // jsdom 不实现 blob URL（实测 createObjectURL 为 undefined），此处补最小桩。
    ;(URL as unknown as Record<string, unknown>).createObjectURL = (b: Blob) => {
      created.push(b)
      return 'blob:mock'
    }
    ;(URL as unknown as Record<string, unknown>).revokeObjectURL = (u: string) => {
      revoked.push(u)
    }
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    ;(URL as unknown as Record<string, unknown>).createObjectURL = originalCreate
    ;(URL as unknown as Record<string, unknown>).revokeObjectURL = originalRevoke
  })

  it('生成 blob 下载并释放 object URL（不驻留内存）', () => {
    // 不真的触发导航（jsdom 的 anchor click 会报 "Not implemented"）。
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    downloadMarkdown('demo.md', '# 内容')

    expect(created).toHaveLength(1)
    expect(click).toHaveBeenCalledTimes(1)
    const captured = click.mock.instances[0] as HTMLAnchorElement
    expect(captured.getAttribute('download')).toBe('demo.md')
    expect(captured.getAttribute('href')).toBe('blob:mock')
    // 释放是延时的一拍（同步释放会打断刚触发的下载）。
    expect(revoked).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    expect(revoked).toEqual(['blob:mock'])
    click.mockRestore()
  })
})
