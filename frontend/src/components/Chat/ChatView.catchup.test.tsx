import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import { useChatStore } from '../../stores/chatStore'
import { useAppStore } from '../../stores/appStore'
import {
  SESSION_ID,
  userMsg,
  setupChatViewStores,
  resetChatViewStores,
  seedChatMessages,
  installResizeObserverSpy,
} from './ChatView.testUtils'

// 聚焦补拉接线（docs/dev/plans/2026-10-01-acp-refocus-latest-merge.md）：
// 断连标记 + 聚焦/可见性恢复 → GET /messages 最新页合并；守卫（hydrated /
// !replaying / in-flight）与失败保留标记。合并规则本身在 chatStore.catchup.test.ts
// 纯函数级覆盖，这里只验「何时发请求、发什么、失败怎样」。

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>

/** 一页 DB 行（wire 形态，经 toChatMessages 转换）。 */
const dbRow = (id: string, role: 'user' | 'assistant', text: string, at: string) => ({
  id,
  role,
  text,
  createdAt: at,
  blocks: null,
  status: 'complete',
})

/** jsdom 的 document.hidden 是 Document.prototype getter，实例上 defineProperty
 *  遮蔽之（与 Terminal.testUtils 同手法）。delete 归还需按「可删实例属性」的
 *  形状寻址——原型 getter 不在该形状内，故显式声明别名而非内联寻址。 */
type DocumentVisibilityStub = { hidden?: unknown; visibilityState?: unknown }

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  })
}

/** 「离开 awayMs 毫秒后回到可见」。真机由 visibilitychange 两段完成；
 *  jsdom 无真实时钟事件流，用假时钟推进 Date.now（fetch promise 微任务不受
 *  假时钟影响，照常 await）。离开时长是 E1 兜底的唯一判据。 */
async function resumeAfterHidden(awayMs: number) {
  vi.useFakeTimers()
  setDocumentHidden(true)
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  vi.advanceTimersByTime(awayMs)
  setDocumentHidden(false)
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  vi.useRealTimers()
  await act(async () => {})
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // ChatView 在 layout effect 里创建 ResizeObserver，jsdom 无此类，必须先装桩。
  installResizeObserverSpy()
  setupChatViewStores()
  // 桌面默认：E1 兜底只对移动端生效，桌面断言不回归 D1「断连才刷」。
  useAppStore.setState({ isMobile: false })
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [] }),
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetChatViewStores()
  useAppStore.setState({ isMobile: false })
  // delete 归还原型 getter（实例属性遮蔽不会随 unmount 消失）。
  delete (document as DocumentVisibilityStub).hidden
  delete (document as DocumentVisibilityStub).visibilityState
  vi.unstubAllGlobals()
})

const renderView = () => {
  act(() => root.render(<ChatView />))
}

/** 与补拉相关的 GET 调用（/messages，不带 before 游标）。 */
const catchUpCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/messages'))

describe('ChatView refocus catch-up', () => {
  it('断连标记 + 挂载 → 拉一次最新页并合并、清标记', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    useChatStore.getState().setNeedsCatchUp(SESSION_ID, true)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          dbRow('row-a', 'assistant', 'offline answer', '2026-10-01T00:00:02Z'),
        ],
      }),
    })

    renderView()
    await act(async () => {})

    expect(catchUpCalls()).toHaveLength(1)
    expect(String(catchUpCalls()[0][0])).not.toContain('before=')
    const msgs = useChatStore.getState().states[SESSION_ID].messages
    expect(msgs.map((m) => m.id)).toEqual(['u1', 'row-a'])
    expect(useChatStore.getState().states[SESSION_ID].needsCatchUp).toBe(false)
  })

  it('无断连标记 → 挂载与聚焦都不发请求', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    renderView()
    await act(async () => {})
    setDocumentHidden(false)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    await act(async () => {})
    expect(catchUpCalls()).toHaveLength(0)
  })

  it('隐藏期间的 visibilitychange 不拉；回到可见才拉', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    useChatStore.getState().setNeedsCatchUp(SESSION_ID, true)
    renderView()
    await act(async () => {})
    // 挂载时已拉过一次并清标记。先隐藏再造一次断连——标记必须埋在 hidden 态：
    // 可见态置标记会被 E2 立即消费（见勘误用例），那个语义由它自己守。
    setDocumentHidden(true)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    act(() => {
      useChatStore.getState().setNeedsCatchUp(SESSION_ID, true)
    })
    await act(async () => {})
    expect(catchUpCalls()).toHaveLength(1)

    setDocumentHidden(false)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {})
    expect(catchUpCalls()).toHaveLength(2)
    expect(useChatStore.getState().states[SESSION_ID].needsCatchUp).toBe(false)
  })

  it('fetch 失败（!ok）保留标记，下次聚焦重试', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    useChatStore.getState().setNeedsCatchUp(SESSION_ID, true)
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) })
    renderView()
    await act(async () => {})
    expect(catchUpCalls()).toHaveLength(1)
    expect(useChatStore.getState().states[SESSION_ID].needsCatchUp).toBe(true)
  })

  it('replaying 中不补拉（手动重放自带全量历史）', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    useChatStore.getState().setNeedsCatchUp(SESSION_ID, true)
    useChatStore.getState().setReplaying(SESSION_ID, true)
    renderView()
    await act(async () => {})
    expect(catchUpCalls()).toHaveLength(0)
    expect(useChatStore.getState().states[SESSION_ID].needsCatchUp).toBe(true)
  })

  it('合并进来的 RAW 行带 dbId 回写收敛（UPDATE 不 INSERT，不产幽灵行）', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    useChatStore.getState().setNeedsCatchUp(SESSION_ID, true)
    // turn 在断连期间结束 ⇒ prompt_done 无人接收 ⇒ 行停在原始帧包裹态。
    const rawBlocks = JSON.stringify({
      v: 1,
      frames: [{ AgentMessageChunk: { content: { Text: { text: 'offline answer' } } } }],
    })
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'row-raw',
            role: 'assistant',
            text: 'offline answer',
            createdAt: '2026-10-01T00:00:02Z',
            blocks: rawBlocks,
            status: 'complete',
          },
        ],
      }),
    })

    renderView()
    await act(async () => {})

    const syncCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/messages/sync'))
    expect(syncCalls).toHaveLength(1)
    const body = JSON.parse(syncCalls[0][1].body as string)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].id).toBe('row-raw')
    // 合并后 store 里是解码出的 cooked 结构（正文块），rawStored 标记供后续收敛。
    const merged = useChatStore.getState().states[SESSION_ID].messages[1]
    expect(merged.rawStored).toBe(true)
    expect(merged.blocks.map((b) => b.type)).toEqual(['text'])
  })
})

/**
 * 2026-10-04 勘误用例：移动端切后台回来的补拉失配。
 * 根因：冻结期内 onclose 不可靠（迟到晚于 visibilitychange / WebKit 不补派），
 * 「onclose → needsCatchUp → 聚焦补拉」这条链在移动端恒失配 → store 陈旧直到
 * 手动刷新。两条兜底：E1 移动端离开够久回来强制置标记补拉；E2 标记在可见态
 * 被迟到置位时由 store 跃变直接驱动补拉。合并规则本身不在此复验。
 */
describe('ChatView resume catch-up fallbacks (2026-10-04 勘误)', () => {
  const offlineRow = {
    id: 'row-a',
    role: 'assistant',
    text: 'offline answer',
    createdAt: '2026-10-04T00:00:02Z',
    blocks: null,
    status: 'complete',
  }

  it('E1：移动端离开够久回来，无断连标记也补拉（冻结期 onclose 丢失）', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    useAppStore.setState({ isMobile: true })
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [offlineRow] }),
    })

    renderView()
    await act(async () => {})
    expect(catchUpCalls()).toHaveLength(0)

    await resumeAfterHidden(4_000)

    expect(catchUpCalls()).toHaveLength(1)
    expect(useChatStore.getState().states[SESSION_ID].needsCatchUp).toBe(false)
    expect(
      useChatStore.getState().states[SESSION_ID].messages.map((m) => m.id),
    ).toEqual(['u1', 'row-a'])
  })

  it('E1：移动端短离开（<阈值）不兜底（无真实断连窗口，省流量）', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    useAppStore.setState({ isMobile: true })

    renderView()
    await act(async () => {})
    await resumeAfterHidden(1_000)

    expect(catchUpCalls()).toHaveLength(0)
    expect(useChatStore.getState().states[SESSION_ID].needsCatchUp).not.toBe(true)
  })

  it('E1：桌面端长离开无标记不补拉（D1 省流量口径不回归）', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    useAppStore.setState({ isMobile: false })

    renderView()
    await act(async () => {})
    await resumeAfterHidden(10 * 60_000)

    expect(catchUpCalls()).toHaveLength(0)
  })

  it('E1：兜底补拉失败保留标记，下次回来重试', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    useAppStore.setState({ isMobile: true })
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) })

    renderView()
    await act(async () => {})
    await resumeAfterHidden(4_000)

    expect(catchUpCalls()).toHaveLength(1)
    expect(useChatStore.getState().states[SESSION_ID].needsCatchUp).toBe(true)
  })

  it('E1：bfcache 恢复（pageshow persisted）同样兜底，不等 visibilitychange', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    useAppStore.setState({ isMobile: true })
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [offlineRow] }),
    })

    renderView()
    await act(async () => {})
    expect(catchUpCalls()).toHaveLength(0)

    // 冻结 4s：置 hidden 埋下 hiddenAt，然后**不**派发第二段 visibilitychange
    // —— iOS 切 app 回来的形态是 JS 醒来直接拿到 persisted pageshow。
    vi.useFakeTimers()
    setDocumentHidden(true)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    vi.advanceTimersByTime(4_000)
    setDocumentHidden(false)
    const ev = new Event('pageshow')
    Object.defineProperty(ev, 'persisted', { value: true })
    act(() => {
      window.dispatchEvent(ev)
    })
    vi.useRealTimers()
    await act(async () => {})

    expect(catchUpCalls()).toHaveLength(1)
    expect(useChatStore.getState().states[SESSION_ID].needsCatchUp).toBe(false)
    expect(
      useChatStore.getState().states[SESSION_ID].messages.map((m) => m.id),
    ).toEqual(['u1', 'row-a'])
  })

  it('E2：标记在可见态迟到置位（恢复后补派的 onclose）→ 立即补拉，不等再次失焦', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    setDocumentHidden(false)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [offlineRow] }),
    })

    renderView()
    await act(async () => {})
    expect(catchUpCalls()).toHaveLength(0)

    // 模拟移动端恢复后浏览器才补派 onclose → useAcpChat 此刻置标记（无任何
    // visibility/focus 事件伴随）。
    act(() => {
      useChatStore.getState().setNeedsCatchUp(SESSION_ID, true)
    })
    await act(async () => {})

    expect(catchUpCalls()).toHaveLength(1)
    expect(useChatStore.getState().states[SESSION_ID].needsCatchUp).toBe(false)
    expect(
      useChatStore.getState().states[SESSION_ID].messages.map((m) => m.id),
    ).toEqual(['u1', 'row-a'])
  })

  it('E2：隐藏态置标记不抢跑（等回到可见走原路径）', async () => {
    seedChatMessages([userMsg('u1', 'q', { createdAt: 1_000 })])
    useAppStore.setState({ isMobile: true })

    renderView()
    await act(async () => {})
    setDocumentHidden(true)
    act(() => {
      useChatStore.getState().setNeedsCatchUp(SESSION_ID, true)
    })
    await act(async () => {})

    expect(catchUpCalls()).toHaveLength(0)
    expect(useChatStore.getState().states[SESSION_ID].needsCatchUp).toBe(true)
  })
})
