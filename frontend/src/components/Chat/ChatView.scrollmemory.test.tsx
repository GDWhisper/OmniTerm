import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useAcpConnectionStore } from '../../stores/acpConnectionStore'
import { clearAllChatScrollMemory, getChatScrollMemory } from '../../utils/chatScrollMemory'
import type { Session } from '../../api/client'
import {
  SESSION_ID,
  userMsg,
  assistantMsg,
  setupChatViewStores,
  resetChatViewStores,
  seedChatMessages,
  chatScrollEl,
  mockScrollMetrics,
  fireScroll,
} from './ChatView.testUtils'

// ACP 会话浏览位置临时记忆：切走再回来回到离开前的位置（仅用户上翻浏览中）；
// 用户主动置底 / 刷新后从底部开始。jsdom 无布局，滚动度量由 mockScrollMetrics
// 显式驱动；跨会话切换通过改 activeSessionId 触发（ChatView 不重挂载）。

const S2 = 's2'

const secondSession: Session = {
  id: S2,
  project_id: 'p1',
  workspace_path: '/tmp/ws2',
  hook_enabled: false,
  created_at: '2026-01-02T00:00:00Z',
  runtime_kind: 'acp',
  acp_process_alive: true,
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setupChatViewStores()
  // 第二个会话与 s1 同项目，供「切走再回来」用例。
  useAppStore.setState((s) => ({ sessions: { ...s.sessions, p1: [...s.sessions.p1, secondSession] } }))
  seedChatMessages([userMsg('a1', 'question'), assistantMsg('a2', 'answer')], SESSION_ID)
  seedChatMessages([userMsg('b1', 'question 2'), assistantMsg('b2', 'answer 2')], S2)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAcpConnectionStore.setState({ connections: {} })
  resetChatViewStores()
})

function renderView() {
  act(() => root.render(<ChatView />))
}

function switchTo(sessionId: string) {
  act(() => {
    useAppStore.setState({ activeSessionId: sessionId })
  })
}

function jumpButton() {
  return container.querySelector<HTMLButtonElement>('.chat-jump-bottom')
}

function scrollTo(top: number) {
  act(() => {
    chatScrollEl(container).scrollTop = top
    fireScroll(container)
  })
}

describe('ChatView 浏览位置临时记忆', () => {
  it('切走再回来恢复离开前的浏览位置（并显示回底按钮）', () => {
    renderView()
    const m = mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 1400,
      clientHeight: 600,
      scrollHeight: 2000,
    })
    // 用户上翻 → 写穿保存 A 的位置。
    scrollTo(800)
    expect(jumpButton()).toBeTruthy()
    expect(getChatScrollMemory(SESSION_ID)).toBe(800)

    // 切到 B：无记忆 → 贴底。
    switchTo(S2)
    expect(m.getTop()).toBe(1400)
    expect(jumpButton()).toBeNull()

    // 切回 A：恢复到 800，且不钉底。
    switchTo(SESSION_ID)
    expect(m.getTop()).toBe(800)
    expect(jumpButton()).toBeTruthy()
  })

  it('恢复后内容变化不重新钉底', () => {
    renderView()
    const m = mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 1400,
      clientHeight: 600,
      scrollHeight: 2000,
    })
    scrollTo(800)
    switchTo(S2)
    switchTo(SESSION_ID)
    expect(m.getTop()).toBe(800)

    // sending 翻转会让贴底 effect 重跑（滚动内容长高的一类来源）。
    act(() => useChatStore.getState().beginPrompt(SESSION_ID))
    expect(m.getTop()).toBe(800)
    expect(jumpButton()).toBeTruthy()
  })

  it('贴底离开不恢复（A 停在底部 → 切回仍在底部）', () => {
    renderView()
    const m = mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 1400,
      clientHeight: 600,
      scrollHeight: 2000,
    })
    // 初始就在底部：切走再回来应被钉底。
    switchTo(S2)
    switchTo(SESSION_ID)
    expect(m.getTop()).toBe(1400)
    expect(jumpButton()).toBeNull()
  })

  it('滚回底部清记忆：之后再回来不恢复', () => {
    renderView()
    const m = mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 1400,
      clientHeight: 600,
      scrollHeight: 2000,
    })
    scrollTo(800)
    expect(getChatScrollMemory(SESSION_ID)).toBe(800)

    scrollTo(1400)
    expect(getChatScrollMemory(SESSION_ID)).toBeNull()

    switchTo(S2)
    switchTo(SESSION_ID)
    expect(m.getTop()).toBe(1400)
    expect(jumpButton()).toBeNull()
  })

  it('点「回到底部」清记忆：之后再回来不恢复', () => {
    renderView()
    const m = mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 1400,
      clientHeight: 600,
      scrollHeight: 2000,
    })
    scrollTo(800)
    act(() => jumpButton()!.click())
    expect(getChatScrollMemory(SESSION_ID)).toBeNull()

    switchTo(S2)
    switchTo(SESSION_ID)
    expect(m.getTop()).toBe(1400)
    expect(jumpButton()).toBeNull()
  })

  it('加载更早历史在途时切会话：陈旧锚点不作用于新会话', async () => {
    // 给 A 一个历史游标（hydrate 带 cursor）。
    act(() => {
      useChatStore.getState().reset(SESSION_ID)
      useChatStore.getState().hydrate(
        SESSION_ID,
        [userMsg('a1', 'question'), assistantMsg('a2', 'answer')],
        'c1',
      )
      useChatStore.getState().setHydrated(SESSION_ID, true)
    })
    let resolveFetch: ((value: unknown) => void) | null = null
    const fetchMock = vi.fn((url: RequestInfo | URL) => {
      if (String(url).includes('before=')) {
        return new Promise((resolve) => {
          resolveFetch = resolve
        })
      }
      return Promise.resolve({ ok: false })
    })
    vi.stubGlobal('fetch', fetchMock)

    renderView()
    const m = mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 0,
      clientHeight: 600,
      scrollHeight: 2000,
    })
    // 停在顶部触发「加载更早历史」，请求在途。
    scrollTo(0)
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('before='))).toBe(true)

    // 在途时切到 B：B 先贴底，然后用户上翻（autoStick=false —— 否则内容长高
    // 会被贴底 effect 钉回底部，掩盖陈旧锚点是否生效）。
    switchTo(S2)
    expect(m.getTop()).toBe(1400)
    scrollTo(1200)

    // 响应落定（锚点按当时的 2000 记录），随后内容长高 600；再让 B 的消息变化
    // 触发布局 effect 消费锚点。
    await act(async () => {
      resolveFetch?.({
        ok: true,
        json: async () => ({
          messages: [{ id: 'old-1', role: 'user', text: 'older', createdAt: '2026-01-01T00:00:00Z' }],
          nextCursor: null,
        }),
      })
    })
    m.setScrollHeight(2600)
    act(() => useChatStore.getState().appendChunk(S2, 'new chunk'))

    // 修复前：陈旧锚点的 delta=600 会加到 B 的视口上（1200 → 1800）。
    expect(m.getTop()).toBe(1200)
    vi.unstubAllGlobals()
  })

  it('发送后清记忆：之后再回来从底部开始', () => {
    const sendPrompt = vi.fn()
    act(() => {
      useAcpConnectionStore.setState({
        connections: {
          [SESSION_ID]: {
            connectionState: 'connected',
            sendPrompt,
            cancel: vi.fn(),
            restore: vi.fn(),
            respondPermission: vi.fn(),
            setConfigOption: vi.fn(),
          },
        },
      })
    })
    renderView()
    const m = mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 1400,
      clientHeight: 600,
      scrollHeight: 2000,
    })
    scrollTo(800)
    expect(getChatScrollMemory(SESSION_ID)).toBe(800)

    const textarea = container.querySelector('textarea')!
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value',
    )!.set!
    act(() => {
      setValue.call(textarea, 'hello')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(sendPrompt).toHaveBeenCalledTimes(1)
    expect(getChatScrollMemory(SESSION_ID)).toBeNull()

    switchTo(S2)
    switchTo(SESSION_ID)
    expect(m.getTop()).toBe(1400)
    expect(jumpButton()).toBeNull()
  })

  it('模拟刷新（清空模块记忆 + 重挂载）后从底部开始', () => {
    renderView()
    mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 1400,
      clientHeight: 600,
      scrollHeight: 2000,
    })
    scrollTo(800)
    expect(getChatScrollMemory(SESSION_ID)).toBe(800)

    clearAllChatScrollMemory()
    act(() => root.unmount())
    root = createRoot(container)
    renderView()
    // 重挂载产生新的滚动容器，旧的 mock 属性不跟随。
    const fresh = mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 0,
      clientHeight: 600,
      scrollHeight: 2000,
    })
    // 度量在首次布局后才有（jsdom 无布局）：用一次内容变化驱动贴底 effect 重跑，
    // 等价于刷新后消息渲染完成的那一刻。
    act(() => useChatStore.getState().beginPrompt(SESSION_ID))
    expect(fresh.getTop()).toBe(1400)
    expect(jumpButton()).toBeNull()
  })

  it('记忆值超过新内容上限时夹紧到底，随后自然转贴底并清记忆', () => {
    renderView()
    const m = mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 1900,
      clientHeight: 600,
      scrollHeight: 3000,
    })
    // 1900 不是底部（max=2400）：属于用户上翻浏览态。
    scrollTo(1900)
    switchTo(S2)

    // 回来时内容变矮：maxScrollTop 从 1900 降到 1400。
    m.setScrollHeight(2000)
    switchTo(SESSION_ID)
    expect(m.getTop()).toBe(1400)
    expect(getChatScrollMemory(SESSION_ID)).toBe(1400)
    // 夹到底后浏览器派发 scroll → atBottom → 转贴底并清记忆。
    scrollTo(1400)
    expect(jumpButton()).toBeNull()
    expect(getChatScrollMemory(SESSION_ID)).toBeNull()
  })

  it('内容不足一屏：不恢复、维持贴底', () => {
    renderView()
    mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 0,
      clientHeight: 600,
      scrollHeight: 2000,
    })
    scrollTo(800)
    switchTo(S2)

    const short = mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 0,
      clientHeight: 600,
      scrollHeight: 500,
    })
    switchTo(SESSION_ID)
    expect(short.getTop()).toBe(0)
    expect(jumpButton()).toBeNull()
  })

  it('无记忆会话进入时贴底态归一，且后续内容变化仍跟随', () => {
    renderView()
    const m = mockScrollMetrics(chatScrollEl(container), {
      scrollTop: 1400,
      clientHeight: 600,
      scrollHeight: 2000,
    })
    // A 上翻（autoStick=false）。
    scrollTo(800)
    expect(jumpButton()).toBeTruthy()

    // B 无记忆：进入即贴底，不继承 A 的偏移。
    switchTo(S2)
    expect(m.getTop()).toBe(1400)
    expect(jumpButton()).toBeNull()

    // 内容变化仍跟随（autoStick 已复位为 true）。
    act(() => useChatStore.getState().beginPrompt(S2))
    expect(m.getTop()).toBe(1400)
    expect(jumpButton()).toBeNull()
  })
})
