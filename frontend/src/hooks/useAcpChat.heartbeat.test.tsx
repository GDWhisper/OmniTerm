import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAcpChat, HEARTBEAT_INTERVAL_MS, HEARTBEAT_MAX_MISSED } from './useAcpChat'
import { AttentionContext } from '../hooks/useAttention'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'
import { useChatStore } from '../stores/chatStore'

// ACP WS 心跳与「隐藏期重连挂起」回归（2026-10-10「长时间离开浏览器后假死」）：
// 空闲连接 ~125s 被隧道重置且形态是 ResetWithoutClosingHandshake，冻结页还不补派
// onclose —— 前端握着死 socket 而不自知，`sendPrompt` 静默 return（用户打字无反应）。
// 心跳让前端主动发现半开并重连；隐藏期则完全不发字节、不排退避（移动后台电量账）。

class MockWebSocket {
  static OPEN = 1
  static CLOSED = 3
  static instances: MockWebSocket[] = []
  readyState = MockWebSocket.OPEN
  closed = false
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
    this.closed = true
    this.readyState = MockWebSocket.CLOSED
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

/** jsdom 的 document.hidden 是 Document.prototype getter，实例上 defineProperty 遮蔽。 */
function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  })
}

const useOnlyTimers = () =>
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })

/** 推进 n 个心跳周期（interval 回调在 act 内跑，store 更新被正确收集）。 */
const tickHeartbeats = (n: number) => {
  act(() => {
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * n)
  })
}

describe('useAcpChat 心跳 / 隐藏期重连', () => {
  let root: Root | null = null

  beforeEach(() => {
    MockWebSocket.instances = []
    useChatStore.setState({ states: {} })
    setDocumentHidden(false)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    setDocumentHidden(false)
    useChatStore.setState({ states: {} })
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
    const ws = MockWebSocket.instances[0]
    act(() => {
      ws.onopen?.()
      useChatStore.getState().setHydrated('s1', true)
    })
    return ws
  }

  const deliver = (ws: MockWebSocket, frame: Record<string, unknown>) => {
    act(() => {
      ws.onmessage?.({ data: JSON.stringify(frame) })
    })
  }

  const pings = (ws: MockWebSocket) => ws.sent.filter((s) => s === '{"type":"ping"}').length

  it('连接后按周期发 ping', () => {
    useOnlyTimers()
    const ws = mount()
    expect(pings(ws)).toBe(0)
    tickHeartbeats(1)
    expect(pings(ws)).toBe(1)
    tickHeartbeats(2)
    expect(pings(ws)).toBe(3)
  })

  it('收到 pong 即复位连续缺失计数（不会误判半开）', () => {
    useOnlyTimers()
    const ws = mount()
    // 两个周期无 pong：还差一次就判半开
    tickHeartbeats(HEARTBEAT_MAX_MISSED - 1)
    expect(ws.closed).toBe(false)
    deliver(ws, { type: 'pong' })
    // 计数已清零：再两个周期仍不应判半开
    tickHeartbeats(HEARTBEAT_MAX_MISSED - 1)
    expect(ws.closed).toBe(false)
    // 连续第三次缺失才判
    tickHeartbeats(1)
    expect(ws.closed).toBe(true)
  })

  it('连续 N 个周期无 pong → 主动关闭半开连接并走退避重连', () => {
    useOnlyTimers()
    const ws = mount()
    tickHeartbeats(HEARTBEAT_MAX_MISSED)
    expect(ws.closed).toBe(true)
    // 关闭后由 onclose 驱动重连（同一套退避机制，不另起一条路径）
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => {
      ws.onclose?.()
    })
    act(() => {
      vi.advanceTimersByTime(1000) // 首次退避 1s
    })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('页面隐藏即停发心跳（不计缺失、不发字节）', () => {
    useOnlyTimers()
    const ws = mount()
    setDocumentHidden(true)
    tickHeartbeats(5)
    expect(pings(ws)).toBe(0)
    expect(ws.closed).toBe(false)
    // 回到可见：心跳恢复，且隐藏期不计入连续缺失（不会一回来就判半开）
    setDocumentHidden(false)
    tickHeartbeats(1)
    expect(pings(ws)).toBe(1)
    expect(ws.closed).toBe(false)
  })

  it('隐藏期断连不排退避定时器，页面回来才补连', () => {
    useOnlyTimers()
    const ws = mount()
    setDocumentHidden(true)
    act(() => {
      ws.onclose?.()
    })
    // 隐藏期：退避定时器一个都不排（移动后台不白跑握手）
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(MockWebSocket.instances).toHaveLength(1)

    setDocumentHidden(false)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('可见期断仍按指数退避自动重连（既有行为不回归）', () => {
    useOnlyTimers()
    const ws = mount()
    act(() => {
      ws.onclose?.()
    })
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('退避窗内被隐藏：到点不握手，转挂起等回来', () => {
    useOnlyTimers()
    const ws = mount()
    act(() => {
      ws.onclose?.() // 可见期断连 → 排了 1s 退避
    })
    setDocumentHidden(true)
    act(() => {
      vi.advanceTimersByTime(1000) // 退避到点，但页面已不可见
    })
    expect(MockWebSocket.instances).toHaveLength(1) // 没有白握这一次手
    setDocumentHidden(false)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(MockWebSocket.instances).toHaveLength(2)
  })})
