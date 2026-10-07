import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import { useChatStore } from '../../stores/chatStore'
import {
  SESSION_ID,
  setupChatViewStores,
  resetChatViewStores,
  installResizeObserverSpy,
} from './ChatView.testUtils'

// usage 快照 hydrate（刷新 / 换设备恢复用量徽章）：GET /messages 的 usage 字段
// 注入 chatStore；agentLive 与否都注入（活会话消除空窗，live/replay usage 帧
// 随后覆盖——帧在 preHydrateBuffer 内按序回放）。落库侧见 src/acp/usage.rs 与
// fake_agent_tests::usage_update_notification_is_persisted。

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // ChatView 在 layout effect 里创建 ResizeObserver，jsdom 无此类，必须先装桩。
  installResizeObserverSpy()
  setupChatViewStores()
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetChatViewStores()
  vi.unstubAllGlobals()
})

/** 挂载并等 hydrate effect 的 fetch promise 落定。 */
async function mountWithBody(body: unknown) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => body })
  await act(async () => {
    root.render(<ChatView />)
  })
  await act(async () => {})
}

describe('ChatView usage snapshot hydrate', () => {
  it('injects the DB usage snapshot into the store and renders the badge', async () => {
    await mountWithBody({
      messages: [],
      usage: { used: 1234, size: 200000, cost: { amount: 1.5, currency: 'USD' } },
      agentLive: false,
    })

    const usage = useChatStore.getState().states[SESSION_ID].usage
    expect(usage).toEqual({ used: 1234, size: 200000, cost: { amount: 1.5, currency: 'USD' } })
    // UsageIndicator：1234 / 200000 ≈ 1%，桌面端同时显示费用。
    expect(container.textContent).toContain('1%')
    expect(container.textContent).toContain('$1.5000')
  })

  it('does not inject when the response has no usage (agent never sent one)', async () => {
    await mountWithBody({ messages: [], usage: null, agentLive: true })

    expect(useChatStore.getState().states[SESSION_ID].usage ?? null).toBeNull()
    // 不渲染用量内容（hover 明细的 token 文本是 usage 徽章专属；连接状态徽章
    // 共用 .title-bar-badge 类名，不能用它判缺席）。
    expect(container.textContent).not.toContain('200k')
  })
})
