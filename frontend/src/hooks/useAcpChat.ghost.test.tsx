import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAcpChat, HYDRATE_GATED_FRAMES } from './useAcpChat'
import { AttentionContext } from '../hooks/useAttention'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'
import { useChatStore, type ChatMessage } from '../stores/chatStore'

// 幽灵行修复集成测试（docs/dev/plans/2026-08-18-ghost-message-and-known-issues.md P0）：
// 方案 A —— replay 帧纳入 HYDRATE_GATED_FRAMES，hydrate 先落定 → replay 被 suppress
// （不 commitReplay、不 syncToDb → 不 INSERT 幽灵行）；
// 方案 B —— hydrate 落定后 RAW 残留行以带 dbId 的 cooked 形态回写（UPDATE 不 INSERT）。
// 无 @testing-library/react，用 react-dom 手动渲染 + 可控 MockWebSocket 驱动帧序。

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

// replay 内容帧（AgentMessageChunk → appendText）
const replayChunkFrame = (text: string) => ({
  type: 'session_update',
  data: { update: { AgentMessageChunk: { content: { Text: { text } } } } },
})

describe('ghost-message fix — HYDRATE_GATED_FRAMES gates replay', () => {
  let root: Root | null = null
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    MockWebSocket.instances = []
    useChatStore.setState({ states: {} })
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
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

  const send = (ws: MockWebSocket, frame: Record<string, unknown>) => {
    act(() => {
      ws.onmessage?.({ data: JSON.stringify(frame) })
    })
  }

  it('replay frames are gated together with the message-mutating frames', () => {
    // 防回归：以后有人精简 HYDRATE_GATED_FRAMES 时不得漏掉 replay 帧
    expect(HYDRATE_GATED_FRAMES.has('replay_start')).toBe(true)
    expect(HYDRATE_GATED_FRAMES.has('replay_end')).toBe(true)
  })

  it('replay arriving before hydrate settles is buffered and suppressed — no ghost INSERT', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })

    // 页面刷新 + 恢复会话的竞态窗口：replay 帧先于 GET /messages 落定到达。
    send(ws, { type: 'replay_start' })
    send(ws, replayChunkFrame('ghost reply'))
    send(ws, { type: 'replay_end' })

    // 门控生效：replay 未在 hydrate 前 commitReplay / syncToDb。
    expect(useChatStore.getState().states['s1']?.messages ?? []).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()

    // hydrate 落定（ChatView 的 GET /messages 落定 + setHydrated）。
    act(() => {
      useChatStore.getState().hydrate('s1', [mkMsg({ role: 'assistant', text: 'from db', dbId: 'row-1', id: 'row-1' })], null)
      useChatStore.getState().setHydrated('s1', true)
    })

    // 缓冲回放时 store 已有带 dbId 的权威历史 → suppressReplay → 内容帧丢弃、
    // 不 commitReplay 替换 store、不 syncToDb 全量写回（无 id 文本匹配失败 → 无幽灵行）。
    expect(useChatStore.getState().states['s1'].messages.map((m) => m.text)).toEqual(['from db'])
    expect(useChatStore.getState().states['s1'].messages[0].dbId).toBe('row-1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still replays into an empty session (hydrate had no rows — safety boundary)', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })

    send(ws, { type: 'replay_start' })
    send(ws, replayChunkFrame('only source of truth'))
    send(ws, { type: 'replay_end' })
    // hydrate 空 → 缓冲回放时 store 仍空 → suppressReplay=false → 正常重放写回。
    act(() => {
      useChatStore.getState().setHydrated('s1', true)
    })

    expect(useChatStore.getState().states['s1'].messages.map((m) => m.text)).toEqual(['only source of truth'])
    // 重放重建消息无 dbId → 无 id 文本路径 → 全部 INSERT（无对应行，安全，不产生幽灵行）。
    expect(fetchMock).toHaveBeenCalled()
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].text).toBe('only source of truth')
    expect(body.messages[0]).not.toHaveProperty('id')
  })
})

describe('ghost-message fix — RAW rows converge after hydrate', () => {
  let root: Root | null = null
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    MockWebSocket.instances = []
    useChatStore.setState({ states: {} })
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
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
  }

  it('writes cooked blocks back with the real dbId — message count unchanged', () => {
    mount()
    const rawRow = mkMsg({
      role: 'assistant',
      text: 'partial',
      dbId: 'row-1',
      id: 'row-1',
      rawStored: true,
      blocks: [
        { type: 'text', text: 'partial' },
        { type: 'tool_call', toolCallId: 'tc-1', title: 'read', status: 'completed' },
      ],
    })
    act(() => {
      useChatStore.getState().hydrate('s1', [rawRow], null)
      useChatStore.getState().setHydrated('s1', true)
    })

    // 带 id 的 payload → 后端 UPDATE 该行 blocks、不写 text、不 INSERT。
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/messages/sync')
    const body = JSON.parse(init.body)
    expect(body.messages).toEqual([
      {
        id: 'row-1',
        role: 'assistant',
        text: 'partial',
        blocks: JSON.stringify(rawRow.blocks),
      },
    ])
    // store 消息条数不增加（回写是收敛不是重建）。
    expect(useChatStore.getState().states['s1'].messages).toHaveLength(1)
  })

  it('skips streaming RAW rows (backend accumulator still owns the in-progress turn)', () => {
    mount()
    act(() => {
      useChatStore.getState().hydrate(
        's1',
        [mkMsg({ role: 'assistant', text: 'in flight', dbId: 'row-2', id: 'row-2', rawStored: true, streaming: true })],
        null,
      )
      useChatStore.getState().setHydrated('s1', true)
    })
    // 进行中 turn 由 prompt_done 的 syncTurnToDb 接管，不在此回写。
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips rows without rawStored / dbId / empty cooked blocks', () => {
    mount()
    act(() => {
      useChatStore.getState().hydrate(
        's1',
        [
          mkMsg({ role: 'assistant', text: 'cooked already', dbId: 'row-3', id: 'row-3' }),
          mkMsg({ role: 'user', text: 'hi' }),
          mkMsg({ role: 'assistant', text: 'empty decode', dbId: 'row-4', id: 'row-4', rawStored: true, blocks: [] }),
        ],
        null,
      )
      useChatStore.getState().setHydrated('s1', true)
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
