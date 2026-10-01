import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import { useChatStore } from '../../stores/chatStore'
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

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // ChatView 在 layout effect 里创建 ResizeObserver，jsdom 无此类，必须先装桩。
  installResizeObserverSpy()
  setupChatViewStores()
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
    // 挂载时已拉过一次并清标记；再造一次断连，然后隐藏→可见。
    useChatStore.getState().setNeedsCatchUp(SESSION_ID, true)
    setDocumentHidden(true)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
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
