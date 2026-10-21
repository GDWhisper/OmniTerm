import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import { useToastStore } from '../../stores/toastStore'
import {
  setupChatViewStores,
  resetChatViewStores,
  seedChatMessages,
  installResizeObserverSpy,
} from './ChatView.testUtils'

// F08 会话导出 Markdown 的接线（docs/dev/plans/2026-10-21-acp-session-markdown-export.md）：
// 标题栏入口 → 独立分页拉全量 → 复用单条 messageToMarkdown 拼装 → Blob 下载。
// 序列化规则本身在 utils/sessionMarkdown.test.ts 纯函数级覆盖，这里只验接线。

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
let blobs: Blob[]
let originalCreate: unknown
let originalRevoke: unknown

/** 一页 DB 行（wire 形态，经 toChatMessages 转换）。 */
const dbRow = (id: string, role: 'user' | 'assistant', text: string, at: string) => ({
  id,
  role,
  text,
  createdAt: at,
  blocks: null,
  status: 'complete',
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  installResizeObserverSpy()
  setupChatViewStores()
  // 预置 hydrated：跳过 ChatView 自身的首屏 GET /messages，让本用例里的
  // /messages 请求全部来自导出链路（否则 hydrate 会消费掉第一页 mock）。
  seedChatMessages([])
  useToastStore.setState({ toasts: [] })

  blobs = []
  originalCreate = (URL as unknown as Record<string, unknown>).createObjectURL
  originalRevoke = (URL as unknown as Record<string, unknown>).revokeObjectURL
  ;(URL as unknown as Record<string, unknown>).createObjectURL = (b: Blob) => {
    blobs.push(b)
    return 'blob:mock'
  }
  ;(URL as unknown as Record<string, unknown>).revokeObjectURL = () => {}

  // 不真的触发导航（jsdom 的 anchor click 会报 "Not implemented"）。
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetChatViewStores()
  ;(URL as unknown as Record<string, unknown>).createObjectURL = originalCreate
  ;(URL as unknown as Record<string, unknown>).revokeObjectURL = originalRevoke
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderView() {
  act(() => root.render(<ChatView />))
}

function exportButton(): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('.title-bar-icon-btn')
  if (!btn) throw new Error('未找到导出按钮')
  return btn
}

describe('ChatView 会话导出', () => {
  it('标题栏有导出入口', () => {
    renderView()
    expect(exportButton()).toBeTruthy()
  })

  it('点击后独立分页拉全量并下载含全部消息的 Markdown', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [dbRow('row-2', 'assistant', '第二条', '2026-10-21T09:00:02Z')],
          nextCursor: 'cursor-1',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          messages: [dbRow('row-1', 'user', '第一条', '2026-10-21T09:00:01Z')],
          nextCursor: null,
        }),
      })

    renderView()
    await act(async () => {
      exportButton().click()
    })

    // 两页都拉了（第二页带 before 游标）——不复用 store 已加载的页。
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.filter((u) => u.includes('/messages'))).toHaveLength(2)
    expect(urls[1]).toContain('before=cursor-1')

    expect(blobs).toHaveLength(1)
    const content = await blobs[0].text()
    expect(content).toContain('第一条')
    expect(content).toContain('第二条')
    // 时间正序：先出现的应是较早的那条。
    expect(content.indexOf('第一条')).toBeLessThan(content.indexOf('第二条'))
    expect(content).toContain('# 会话导出：')
  })

  it('导出成功给出条数 toast', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [dbRow('row-1', 'user', '你好', '2026-10-21T09:00:01Z')],
        nextCursor: null,
      }),
    })
    renderView()
    await act(async () => {
      exportButton().click()
    })
    const toasts = useToastStore.getState().toasts
    expect(toasts.some((t) => t.type === 'success')).toBe(true)
  })

  it('拉取失败给出错误 toast，不静默', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    renderView()
    await act(async () => {
      exportButton().click()
    })
    expect(blobs).toHaveLength(0)
    expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true)
  })
})
