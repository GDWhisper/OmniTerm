import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useAcpConnectionStore } from '../../stores/acpConnectionStore'
import type { Session } from '../../api/client'
import {
  SESSION_ID,
  userMsg,
  setupChatViewStores,
  resetChatViewStores,
  chatScrollEl,
  mockScrollMetrics,
  fireScroll,
} from './ChatView.testUtils'

// 触顶加载更早历史：滞后锁（D6）+ 视口比例触发窗口（D7）。
//
// jsdom 无布局，两个度量都要显式驱动：
//  · scrollTop / clientHeight —— mockScrollMetrics；
//  · scrollHeight —— 随消息条数线性增长（前插一条 = 长高 MESSAGE_H_PX），否则
//    补偿 effect 量到的 delta 恒为 0，测不到「补偿抬高 scrollTop」这条关键路径。

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

/** 每条消息占的高度（模拟真实布局：消息越多内容越长）。 */
const MESSAGE_H_PX = 100

let container: HTMLDivElement
let root: Root
/** 已发出的「加载更早历史」分页请求 URL（before= 分页）。 */
let pageRequests: string[]

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setupChatViewStores()
  useAppStore.setState((s) => ({ sessions: { ...s.sessions, p1: [...s.sessions.p1, secondSession] } }))
  pageRequests = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: RequestInfo | URL) => {
      const u = String(url)
      if (u.includes('before=')) {
        pageRequests.push(u)
        // 返回一页更早的消息，并给出**非空** nextCursor（游标为空即「已到开头」，
        // 后续上拉会被 loadOlderHistory 直接早退，测不到第二页）。
        return Promise.resolve({
          ok: true,
          json: async () => ({
            messages: [
              { id: `old-${pageRequests.length}`, role: 'user', text: 'older', createdAt: 0 },
            ],
            nextCursor: `c${pageRequests.length + 1}`,
          }),
        })
      }
      return Promise.resolve({ ok: false })
    }),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAcpConnectionStore.setState({ connections: {} })
  resetChatViewStores()
  vi.unstubAllGlobals()
})

function renderView() {
  act(() => root.render(<ChatView />))
}

/**
 * 给会话灌入 n 条消息并带上历史游标（游标为空则 loadOlderHistory 直接早退，
 * 测不到触发链路）。返回消息条数。
 */
function seedWithCursor(sessionId: string, n: number) {
  act(() => {
    useChatStore.getState().reset(sessionId)
    const msgs = Array.from({ length: n }, (_, i) => userMsg(`${sessionId}-m${i}`, `msg ${i}`))
    useChatStore.getState().hydrate(sessionId, msgs, 'cursor-0')
    useChatStore.getState().setHydrated(sessionId, true)
  })
}

/**
 * 装上度量：scrollTop / clientHeight 由 mockScrollMetrics 提供，scrollHeight 由
 * 「消息条数 × 每条高度」动态给出（jsdom 无布局；补偿 effect 靠 scrollHeight 的
 * 差值算 delta，静态值会让 delta 恒为 0，测不到「补偿抬高 scrollTop」这条路径）。
 *
 * mockScrollMetrics 的 scrollTop setter 按其**内部** scroll 变量夹紧，故这里给它
 * 一个足够大的初值，避免夹紧把补偿写入的 scrollTop 削掉。
 */
function mockLayout(el: HTMLElement) {
  const m = mockScrollMetrics(el, { scrollTop: 0, clientHeight: 600, scrollHeight: 1e6 })
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => {
      const st = useChatStore.getState()
      const id = useAppStore.getState().activeSessionId
      const count = id ? (st.states[id]?.messages.length ?? 0) : 0
      return count * MESSAGE_H_PX
    },
  })
  return m
}

function scrollTo(top: number) {
  act(() => {
    chatScrollEl(container).scrollTop = top
    fireScroll(container)
  })
}

/**
 * 让在途的 promise 链落定：fetch → json() → store 更新 → React 提交 → layout
 * effect（补偿）跑完。每一层 await 都是一个微任务，故需多轮让出。
 */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
  })
}

describe('ChatView 触顶加载更早历史', () => {
  it('连锁回归：补偿引发的 scroll 事件不再触发第二次加载', async () => {
    seedWithCursor(SESSION_ID, 10)
    renderView()
    const m = mockLayout(chatScrollEl(container))

    // 触顶 → 发出一次分页请求。
    scrollTo(0)
    expect(pageRequests.length).toBe(1)

    // 响应落定：前插一条消息 → 内容变高 100px → 补偿把 scrollTop 抬到 100。
    // 该补偿在真实浏览器里会派发 scroll 事件——正是连锁翻页的起点。
    await flush()
    expect(m.getTop()).toBe(MESSAGE_H_PX)

    // 补偿引发的 scroll 事件：位置仍满足近顶（100 < 900），但不应再发请求。
    act(() => {
      fireScroll(container)
    })
    expect(pageRequests.length).toBe(1)
  })

  it('解锁可用：用户向上滚动后再次触顶可再加载一页', async () => {
    seedWithCursor(SESSION_ID, 10)
    renderView()
    const m = mockLayout(chatScrollEl(container))

    scrollTo(0)
    expect(pageRequests.length).toBe(1)
    await flush()
    expect(m.getTop()).toBe(MESSAGE_H_PX)

    // 用户向上滚动（真实手势）→ 滞后锁解锁。
    scrollTo(MESSAGE_H_PX - 10)
    expect(pageRequests.length).toBe(2)
  })

  it('比例换算：clientHeight=600 → 触发窗口 900px（不是 200px）', () => {
    seedWithCursor(SESSION_ID, 10)
    renderView()
    mockLayout(chatScrollEl(container))

    // 800px 落在 1.5 视口窗口内 → 触发（旧口径 200px 不会触发）。
    scrollTo(800)
    expect(pageRequests.length).toBe(1)
  })

  it('会话切换：锁与快照重置，新会话首次触顶即可加载', async () => {
    seedWithCursor(SESSION_ID, 10)
    seedWithCursor(S2, 10)
    renderView()
    mockLayout(chatScrollEl(container))

    // A 触顶 → 加载并在途（锁上闩）。
    scrollTo(0)
    expect(pageRequests.length).toBe(1)
    await flush()

    // 切到 B：B 有自己的游标，首次触顶即可加载（锁不跨会话继承）。
    act(() => {
      useAppStore.setState({ activeSessionId: S2 })
    })
    scrollTo(0)
    expect(pageRequests.length).toBe(2)
    expect(pageRequests[1]).toContain(`/sessions/${S2}/messages`)  })
})
