import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAcpChat } from './useAcpChat'
import { AttentionContext } from '../hooks/useAttention'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'
import { useChatStore } from '../stores/chatStore'

// 断连标记（聚焦补拉的触发条件，docs/dev/plans/2026-10-01-acp-refocus-latest-merge.md D1）：
// 真实网络断开（WS onclose 且非主动拆除）才置 needsCatchUp——主动拆除（切会话 /
// 卸载）与陈旧 socket 的迟到 onclose 都不置位，否则每次切会话都会触发一次补拉。
// 帧序驱动手法与 useAcpChat.ghost.test.tsx 相同（MockWebSocket + 手动 onclose）。

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  readyState = MockWebSocket.OPEN
  sent: string[] = []
  url: string
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }
}

const fakeAttention: AttentionContextValue = {
  alerts: new Map(),
  fire: vi.fn(),
  clearAlert: vi.fn(),
  setActive: vi.fn(),
  reasonFor: () => undefined,
}

function Harness({ sessionId }: { sessionId: string }) {
  useAcpChat({ sessionId })
  return null
}

describe('catch-up flag — WS disconnect marks the session stale', () => {
  let root: Root | null = null

  beforeEach(() => {
    MockWebSocket.instances = []
    useChatStore.setState({ states: {} })
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    vi.unstubAllGlobals()
  })

  const mount = () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    root = createRoot(el)
    act(() => {
      root!.render(
        <AttentionContext.Provider value={fakeAttention}>
          <Harness sessionId="s1" />
        </AttentionContext.Provider>,
      )
    })
    return MockWebSocket.instances[0]
  }

  it('真实断连（onclose）置 needsCatchUp，供聚焦补拉', () => {
    const ws = mount()
    expect(useChatStore.getState().states['s1']?.needsCatchUp).toBeFalsy()
    act(() => {
      ws.onclose?.()
    })
    expect(useChatStore.getState().states['s1'].needsCatchUp).toBe(true)
  })

  it('卸载后的迟到 onclose 不置位（陈旧 socket 守卫）', () => {
    const ws = mount()
    act(() => {
      root?.unmount()
    })
    root = null
    act(() => {
      ws.onclose?.()
    })
    expect(useChatStore.getState().states['s1']?.needsCatchUp).toBeFalsy()
  })

  it('onopen 本身不清标记（清标记只发生在补拉合并成功后）', () => {
    vi.useFakeTimers()
    try {
      const ws = mount()
      act(() => {
        ws.onclose?.()
      })
      expect(useChatStore.getState().states['s1'].needsCatchUp).toBe(true)
      // 退避重连（1s）建出新 socket 并握手成功：标记仍在，等 ChatView 聚焦时补拉。
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      const ws2 = MockWebSocket.instances[1]
      expect(ws2).toBeDefined()
      act(() => {
        ws2.onopen?.()
      })
      expect(useChatStore.getState().states['s1'].needsCatchUp).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
