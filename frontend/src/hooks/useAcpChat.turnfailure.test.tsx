import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAcpChat } from './useAcpChat'
import { AttentionContext } from '../hooks/useAttention'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'
import { useChatStore, type ChatMessage } from '../stores/chatStore'

// turn 非正常结束的可见性（docs/dev/plans/2026-09-19-acp-failure-visibility.md P0 / D1+D2）：
//   * prompt_done 的 abnormal=true → attention 走 error 语义（不是 done）；
//   * 失败**提示**不在此合成，唯一载体是后端 `system_message` 帧（已落库，hydrate 可补）；
//   * 离线失败（prompt_done 无人接收）→ 刷新页面后 hydrate 读到 DB 行，提示仍可见；
//     但**重连不重跑 hydrate**（hydrated 早已 true），故重连路径下不可见——这是
//     P0-2 的既有残余（广播无补发），本文件只固化现状，不在本次改动范围内。
// 无 @testing-library/react：react-dom 手动渲染 + 可控 MockWebSocket 驱动帧序。

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

const mkMsg = (overrides: Partial<ChatMessage> & { role: ChatMessage['role'] }): ChatMessage => ({
  id: overrides.id ?? `m-${Math.random()}`,
  dbId: overrides.dbId,
  text: overrides.text ?? '',
  blocks: overrides.blocks ?? [{ type: 'text', text: overrides.text ?? '' }],
  createdAt: overrides.createdAt ?? 0,
  streaming: overrides.streaming,
  rawStored: overrides.rawStored,
  role: overrides.role,
})

describe('turn failure — prompt_done abnormal fires attention error', () => {
  let root: Root | null = null
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    MockWebSocket.instances = []
    useChatStore.setState({ states: {} })
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.mocked(fakeAttention.fire).mockClear()
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

  const send = (ws: MockWebSocket, frame: Record<string, unknown>) => {
    act(() => {
      ws.onmessage?.({ data: JSON.stringify(frame) })
    })
  }

  /** hydrate 先落定 → 后续帧即时派发（不被预缓冲）。 */
  const settleHydrate = (messages: ChatMessage[] = []) => {
    act(() => {
      useChatStore.getState().hydrate('s1', messages, null)
      useChatStore.getState().setHydrated('s1', true)
    })
  }

  const firedReasons = () =>
    vi.mocked(fakeAttention.fire).mock.calls.map((c) => c[2])

  const beginTurn = (ws: MockWebSocket) => {
    settleHydrate()
    send(ws, { type: 'turn_state', active: true })
    send(ws, {
      type: 'session_update',
      data: { update: { AgentMessageChunk: { content: { Text: { text: 'partial' } } } } },
    })
  }

  it('abnormal: true → attention fires error, not done', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    beginTurn(ws)
    expect(useChatStore.getState().states['s1'].sending).toBe(true)

    send(ws, { type: 'prompt_done', stop_reason: 'refusal', abnormal: true, row_id: 'row-1' })

    expect(firedReasons()).toContain('error')
    expect(firedReasons()).not.toContain('done')
    // 正常收尾语义不变：sending 复位、本 turn 行回写仍走 syncTurnToDb。
    expect(useChatStore.getState().states['s1'].sending).toBe(false)
    expect(fetchMock).toHaveBeenCalled()
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].id).toBe('row-1')
  })

  it('abnormal absent + non-cancel stop_reason → still fires done (no regression)', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    beginTurn(ws)

    send(ws, { type: 'prompt_done', stop_reason: 'end_turn' })

    expect(firedReasons()).toEqual(['done'])
  })

  it('abnormal: false + unknown `_`-prefixed stop_reason → done, not error', () => {
    // 后端白名单判定是唯一真源：前端不因"值不认识"自行升级为 error。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    beginTurn(ws)

    send(ws, { type: 'prompt_done', stop_reason: '_vendor_thing', abnormal: false })

    expect(firedReasons()).toEqual(['done'])
    expect(firedReasons()).not.toContain('error')
  })

  it('cancel stop_reason → neither done nor error, abnormal must not override cancel', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    beginTurn(ws)

    // cancelled 属非正常结束（D1），后端可能标 abnormal，也可能不标（旧后端无此字段）；
    // 无论哪种，用户主动取消都不该按错误打扰，也不该算"完成"。
    send(ws, { type: 'prompt_done', stop_reason: 'cancelled', abnormal: true, row_id: 'row-2' })
    expect(firedReasons()).toEqual([])

    send(ws, { type: 'turn_state', active: true })
    send(ws, { type: 'prompt_done', stop_reason: 'cancelled', abnormal: false, row_id: 'row-3' })
    expect(firedReasons()).toEqual([])
  })

  it('cancelled: the backend system_message still carries its own notice', () => {
    // 取消不是错误，但要有可见痕迹（D2）：由 system.turnFailed.cancelled 这条 system
    // 消息承担，与这里"不 fire error"是两件独立的事。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate()

    send(ws, {
      type: 'system_message',
      label: 'system.turnFailed.cancelled',
      detail: { stop_reason: 'cancelled' },
    })

    const messages = useChatStore.getState().states['s1'].messages
    expect(messages).toHaveLength(1)
    expect(messages[0].blocks).toEqual([
      { type: 'system', label: 'system.turnFailed.cancelled', detail: { stop_reason: 'cancelled' } },
    ])
  })

  it('queued follow-up still drains on an abnormal end (no attention noise)', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    beginTurn(ws)
    act(() => {
      useChatStore.getState().enqueueMessage('s1', 'and then?')
    })

    send(ws, { type: 'prompt_done', stop_reason: 'refusal', abnormal: true, row_id: 'row-3' })

    expect(firedReasons()).toEqual([])
    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toEqual({ type: 'prompt', text: 'and then?' })
  })
})

describe('turn failure — the visible notice comes from the system_message frame', () => {
  let root: Root | null = null
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    MockWebSocket.instances = []
    useChatStore.setState({ states: {} })
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.mocked(fakeAttention.fire).mockClear()
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

  const send = (ws: MockWebSocket, frame: Record<string, unknown>) => {
    act(() => {
      ws.onmessage?.({ data: JSON.stringify(frame) })
    })
  }

  const settleHydrate = (messages: ChatMessage[] = []) => {
    act(() => {
      useChatStore.getState().hydrate('s1', messages, null)
      useChatStore.getState().setHydrated('s1', true)
    })
  }

  it('system_message frame with a turn-failure label lands a system message in the store', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate()

    send(ws, {
      type: 'system_message',
      label: 'system.turnFailed.refusal',
      detail: { stop_reason: 'refusal' },
    })

    const messages = useChatStore.getState().states['s1'].messages
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('system')
    expect(messages[0].blocks).toEqual([
      { type: 'system', label: 'system.turnFailed.refusal', detail: { stop_reason: 'refusal' } },
    ])
    // 可见痕迹只应有这一条：prompt_done 不自己合成第二条提示。
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(1)
  })

  it('offline abnormal end: the DB row alone carries the notice after a later hydrate (P0-2)', () => {
    // 真实时序：turn 在 WS 离线期间异常结束 → 后端同时写 system 行并广播
    // system_message 帧，离线客户端**两者都没收到**（broadcast 无历史）。
    // 用户**刷新页面** → states 清空、hydrated 回 false → 重新 hydrate 读到 DB 行
    // → 提示可见。注意是"刷新"不是"重连"：hydrated 存在 store 里，而 useAcpChat 的
    // hydratedRef 随 remount 复位，但**重连无 remount**（connect() 就地重建 socket），
    // hydrated 仍为 true → 重连不重跑 hydrate（见 useAcpChat 的 hydrate 门控 effect：
    // `if (!hydrated) return`，重连时恒为 no-op）。重连路径的残余缺口由下一个测试固化。
    act(() => {
      useChatStore.getState().hydrate(
        's1',
        [
          mkMsg({ role: 'user', id: 'u1', text: 'go' }),
          mkMsg({
            role: 'system',
            id: 'row-sys',
            dbId: 'row-sys',
            text: '[system.turnFailed.refusal]',
            blocks: [{ type: 'system', label: 'system.turnFailed.refusal', detail: { stop_reason: 'refusal' } }],
          }),
        ],
        null,
      )
      useChatStore.getState().setHydrated('s1', true)
    })

    const system = useChatStore.getState().states['s1'].messages.filter((m) => m.role === 'system')
    expect(system).toHaveLength(1)
    expect(system[0].blocks).toEqual([
      { type: 'system', label: 'system.turnFailed.refusal', detail: { stop_reason: 'refusal' } },
    ])
  })

  it('reconnect does NOT re-hydrate: a missed system_message frame stays invisible until reload', () => {
    // P0-2 残余（本次不改，仅固化现状供后续收敛）：离线期间本该到达的 system_message
    // 帧无人消费，而重连不重跑 hydrate（hydrated 早已 true），故该提示在本次页面生命周期
    // 内不出现——只有刷新页面才能看到。这是**既有行为**（hydrate 每会话一次 + 普通
    // broadcast 无补发），不只影响 turn 失败提示，见报告"未覆盖"一节。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate()

    // 离线失败窗口内一帧未达 → WS 断开并（指数退避）重连
    act(() => {
      ws.onclose?.()
    })
    expect(MockWebSocket.instances).toHaveLength(1)
    // 重连不会自己重拉 GET /messages
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/messages'))).toHaveLength(0)
    // 离线期间那条 system 提示在 store 里不存在
    expect(useChatStore.getState().states['s1'].messages.filter((m) => m.role === 'system')).toHaveLength(0)
  })

  it('a live frame while online never duplicates a hydrate row — hydrate ran before the failure', () => {
    // 在线失败时序：hydrate 在**失败之前**就已完成（每会话一次），失败时只有 live frame
    // 抵达，DB 行不会被再次拉取 → 恰好一条，无重复。这就是在线场景的真实形态：
    // 「live frame 与 hydrate 行同时存在」的重复在本时间线里不可达，无需去重。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate([mkMsg({ role: 'user', id: 'u1', text: 'go' })])

    send(ws, {
      type: 'system_message',
      label: 'system.turnFailed.refusal',
      detail: { stop_reason: 'refusal' },
    })

    const system = useChatStore.getState().states['s1'].messages.filter((m) => m.role === 'system')
    expect(system).toHaveLength(1)
    expect(system[0].blocks).toEqual([
      { type: 'system', label: 'system.turnFailed.refusal', detail: { stop_reason: 'refusal' } },
    ])
    // 在线期间不会再触发任何 /messages 请求（hydrate 每会话一次）
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/messages'))).toHaveLength(0)
  })
})
