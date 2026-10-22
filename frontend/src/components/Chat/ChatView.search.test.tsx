import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import { advanceClock } from '../../test/timers'
import {
  userMsg,
  assistantMsg,
  setupChatViewStores,
  resetChatViewStores,
  seedChatMessages,
} from './ChatView.testUtils'
import { useChatStore } from '../../stores/chatStore'

// 会话内搜索（F06，计划 docs/dev/plans/2026-10-21-acp-chat-fulltext-search.md）。
//
// 覆盖三条关键链路：
// - 标题栏入口 → 输入 → 列出命中（检索走后端端点，前端只负责交互）。
// - 命中**未加载**时：拉「定位页」（?at=）把窗口整体替换到目标附近，再滚动 + 闪烁。
// - 命中**已在窗口内**时：直接滚动 + 闪烁，不发定位页请求。

let container: HTMLDivElement
let root: Root

const HITS = [
  {
    id: 'm-old',
    role: 'assistant',
    createdAt: '2026-08-10T00:00:00Z',
    snippet: '…这里有上下文窗口的说明…',
    cursor: '2026-08-10T00:00:00Z|m-old',
  },
]

/** 后端命中行（定位页响应用）：字段与 GET /messages 的 messages 同形。 */
const LOCATION_PAGE = {
  messages: [
    {
      id: 'm-old',
      role: 'assistant',
      text: '这里有上下文窗口的说明',
      createdAt: '2026-08-10T00:00:00Z',
      blocks: null,
      status: 'complete',
    },
  ],
  nextCursor: '2026-08-10T00:00:00Z|m-old-0',
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setupChatViewStores()
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/messages/search')) {
      return {
        ok: true,
        json: async () => ({
          hits: HITS,
          matchCount: 1,
          moreMatches: false,
          scannedRows: 120,
          scannedBytes: 4096,
          truncated: false,
          termsTruncated: false,
        }),
      }
    }
    if (url.includes('?at=')) {
      return { ok: true, json: async () => LOCATION_PAGE }
    }
    // 最新一页（定位页替换窗口后「回到最新消息」用它把窗口换回来）
    return {
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'm-new',
            role: 'assistant',
            text: '最新一条',
            createdAt: '2026-08-11T00:00:00Z',
            blocks: null,
            status: 'complete',
          },
        ],
        nextCursor: null,
      }),
    }
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetChatViewStores()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function renderView() {
  act(() => root.render(<ChatView />))
}

/**
 * 定位闪烁标记：用户消息打在气泡上（.chat-msg-flash，既有机制），助手消息打在
 * 行上（.chat-msg-row-flash）——助手消息没有单一气泡外壳（正文由多个 block 组成）。
 */
function hasFlash(container: HTMLElement, messageId: string): boolean {
  const row = container.querySelector(`[data-chat-msg-id="${messageId}"]`)
  if (!row) return false
  return !!row.querySelector('.chat-msg-flash') || row.classList.contains('chat-msg-row-flash')
}

function searchInput() {
  return container.querySelector<HTMLInputElement>('.chat-search-input')
}

/** React 受控输入框：走原生 value setter + input 事件（无 testing-library）。 */
async function typeQuery(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/**
 * 在聊天面板内派发 Ctrl+F。
 *
 * 搜索**没有独立入口按钮**（用户反馈标题栏图标与像素标题条违和，已移除）——
 * 唯一入口是 Ctrl/Cmd+F，且绑在容器作用域：事件从面板内冒泡才生效（计划 D11）。
 */
async function openSearch() {
  await act(async () => {
    container
      .querySelector<HTMLElement>('.panel-title-bar')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
      )
    await advanceClock(1)
  })
}

describe('ChatView 会话内搜索（F06）', () => {
  it('Ctrl+F（焦点在聊天面板内）打开搜索条，输入关键词后列出命中', async () => {
    seedChatMessages([userMsg('m1', '第一条提问')])
    renderView()
    expect(searchInput()).toBeNull()

    await openSearch()
    expect(searchInput()).toBeTruthy()

    await typeQuery(searchInput()!, '上下文')
    await act(async () => {
      await advanceClock(1000)
    })

    const hits = container.querySelectorAll('.chat-search-hit')
    expect(hits.length).toBe(1)
    expect(hits[0].textContent).toContain('上下文')
    // 命中词高亮
    expect(container.querySelector('.chat-search-mark')?.textContent).toBe('上下文')
    // 检索走后端端点
    const searchCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/messages/search'))
    expect(searchCall).toBeTruthy()
  })

  it('命中未加载 → 拉定位页替换窗口 → 目标气泡滚动并闪烁', async () => {
    seedChatMessages([userMsg('m1', '第一条提问')])
    renderView()
    await openSearch()
    await typeQuery(searchInput()!, '上下文')
    await act(async () => {
      await advanceClock(1000)
    })

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.chat-search-hit')!.click()
      await advanceClock(1)
    })

    // 定位页请求发出，且带后端给的游标
    const atCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('?at='))
    expect(atCall).toBeTruthy()
    expect(String(atCall![0])).toContain(encodeURIComponent(HITS[0].cursor))
    // 窗口被替换成定位页的内容，历史游标指向该页最旧行（D8）
    const st = useChatStore.getState().states['s1']
    expect(st?.messages.map((m) => m.id)).toEqual(['m-old'])
    expect(st?.historyCursor).toBe(LOCATION_PAGE.nextCursor)
    // 目标消息被闪烁标记
    expect(hasFlash(container, 'm-old')).toBe(true)
  })

  it('命中已在窗口内 → 直接滚动闪烁，不发定位页请求', async () => {
    seedChatMessages([assistantMsg('m-in', '窗口内的命中')])
    renderView()
    await openSearch()

    // 命中 id 与窗口内消息一致 → 无需定位页
    const localHit = { ...HITS[0], id: 'm-in' }
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/messages/search')) {
        return {
          ok: true,
          json: async () => ({
            hits: [localHit],
            matchCount: 1,
            moreMatches: false,
            scannedRows: 10,
            scannedBytes: 100,
            truncated: false,
            termsTruncated: false,
          }),
        }
      }
      return { ok: true, json: async () => ({ messages: [] }) }
    })

    await typeQuery(searchInput()!, '命中')
    await act(async () => {
      await advanceClock(1000)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.chat-search-hit')!.click()
      await advanceClock(1)
    })

    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('?at='))).toBe(false)
    expect(hasFlash(container, 'm-in')).toBe(true)
  })

  it('定位页替换窗口后给出「回到最新消息」出口（更新的消息不在窗口内）', async () => {
    seedChatMessages([userMsg('m1', '第一条提问')])
    renderView()
    await openSearch()
    await typeQuery(searchInput()!, '上下文')
    await act(async () => {
      await advanceClock(1000)
    })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.chat-search-hit')!.click()
      await advanceClock(1)
    })

    const back = container.querySelectorAll<HTMLButtonElement>('.panel-title-bar-text-btn')
    expect(back.length).toBe(1)

    await act(async () => {
      back[0].click()
      await advanceClock(1)
    })
    // 窗口换回最新一页，出口随之消失
    const st = useChatStore.getState().states['s1']
    expect(st?.messages.map((m) => m.id)).toEqual(['m-new'])
    expect(container.querySelectorAll('.panel-title-bar-text-btn')).toHaveLength(0)
  })

  it('别的面板在捕获阶段拦截 Ctrl+F 时不接管（文件编辑器不受影响）', async () => {
    seedChatMessages([userMsg('m1', '第一条提问')])
    renderView()
    // 模拟文件编辑器（FileEditor.tsx 的做法）：捕获阶段 stopPropagation
    const other = document.createElement('div')
    other.addEventListener('keydown', (e) => e.stopPropagation(), true)
    document.body.appendChild(other)
    await act(async () => {
      other.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }),
      )
      await advanceClock(1)
    })
    other.remove()
    expect(searchInput()).toBeNull()
  })

  it('切换会话后搜索条收起（不跨会话串结果）', async () => {
    seedChatMessages([userMsg('m1', '第一条提问')])
    renderView()
    await openSearch()
    expect(searchInput()).toBeTruthy()

    // 切到另一个会话（ChatView 跨 acp→acp 不重挂载，靠 activeSessionId 变化收起）
    act(() => {
      useChatStore.getState().hydrate('s2', [assistantMsg('x', '别的会话')], null)
      useChatStore.getState().setHydrated('s2', true)
    })
    const { useAppStore } = await import('../../stores/appStore')
    act(() => {
      useAppStore.setState({ activeSessionId: 's2' })
    })
    await act(async () => {
      await advanceClock(1)
    })

    expect(searchInput()).toBeNull()
  })
})
