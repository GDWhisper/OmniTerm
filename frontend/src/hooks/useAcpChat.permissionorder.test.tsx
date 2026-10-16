import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAcpChat, MAX_RESOLVED_PERMISSION_TOMBSTONES } from './useAcpChat'
import { AttentionContext } from '../hooks/useAttention'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'
import { useChatStore } from '../stores/chatStore'

// 幽灵权限横幅回归（auto+「总是」档 + resolve 帧先到）：
// permission_request 与 permission_resolved 经后端两条独立广播通道 + 两个转发
// 任务送达（src/ws/acp.rs 的 spawn_permission_task / spawn_permission_resolved_task），
// 顺序无任何保证；「总是」档请求到达即自动应答（10-09 勘误），把倒置窗口常态化。
// 旧行为下 resolved 先到会对未知 id 无操作，随后迟到的 request 帧铸出永久 banner
//——用户看到「后端已自动放行、agent 已继续跑，横幅却还挂着」。
// 修复：connection 级 tombstone（resolve 优先），迟到请求直接丢弃。
//
// 帧序驱动手法与 useAcpChat.lateframe.test.tsx 相同（MockWebSocket + 手动 onmessage）。

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

const permRequest = { options: [{ optionId: 'o1', kind: 'allow_once', name: 'Allow' }] }

const pendingIds = () =>
  (useChatStore.getState().states['s1']?.pendingPermissions ?? []).map((p) => p.id)

describe('useAcpChat 权限帧顺序倒置（resolve 先到）', () => {
  let root: Root | null = null

  beforeEach(() => {
    MockWebSocket.instances = []
    useChatStore.setState({ states: {} })
    fakeAttention.fire = vi.fn()
    fakeAttention.clearAlert = vi.fn()
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
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
    act(() => {
      useChatStore.getState().setHydrated('s1', true)
    })
    return MockWebSocket.instances[0]
  }

  const send = (ws: MockWebSocket, frame: Record<string, unknown>) => {
    act(() => {
      ws.onmessage?.({ data: JSON.stringify(frame) })
    })
  }

  it('resolved 先到、同 id 请求帧迟到：不产生横幅，也不点亮 decision 提醒', () => {
    const ws = mount()
    send(ws, { type: 'permission_resolved', id: 'p1' })
    send(ws, { type: 'permission_request', id: 'p1', request: permRequest })
    expect(pendingIds()).toEqual([])
    expect(fakeAttention.fire).not.toHaveBeenCalled()
  })

  it('正常顺序（request → resolved）不受影响：横幅先挂出、随后被清除', () => {
    const ws = mount()
    send(ws, { type: 'permission_request', id: 'p2', request: permRequest })
    expect(pendingIds()).toEqual(['p2'])
    send(ws, { type: 'permission_resolved', id: 'p2' })
    expect(pendingIds()).toEqual([])
  })

  it('重连后 tombstone 复位：新连接里同 id 的重放请求正常挂出', () => {
    vi.useFakeTimers()
    try {
      const ws = mount()
      send(ws, { type: 'permission_resolved', id: 'p3' })
      act(() => {
        ws.onclose?.()
      })
      // 退避重连（1s）建出新 socket；tombstone 是连接级状态，重连即清空。
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      const ws2 = MockWebSocket.instances[1]
      expect(ws2).toBeDefined()
      send(ws2, { type: 'permission_request', id: 'p3', request: permRequest })
      expect(pendingIds()).toEqual(['p3'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('tombstone 有界：超过上限按到达序淘汰最旧项，抑制只作用于未淘汰的 id', () => {
    const ws = mount()
    const cap = MAX_RESOLVED_PERMISSION_TOMBSTONES
    for (let i = 0; i <= cap; i++) {
      send(ws, { type: 'permission_resolved', id: `t${i}` })
    }
    // 最旧的 t0 已被淘汰：迟到请求照常挂出（淘汰窗口远大于两帧在途窗口，代价可忽略）。
    send(ws, { type: 'permission_request', id: 't0', request: permRequest })
    expect(pendingIds()).toEqual(['t0'])
    // 最新的 t{cap} 仍在集合内：迟到请求被抑制。
    send(ws, { type: 'permission_request', id: `t${cap}`, request: permRequest })
    expect(pendingIds()).toEqual(['t0'])
  })
})
