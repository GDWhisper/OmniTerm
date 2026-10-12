import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAcpChat } from './useAcpChat'
import { AttentionContext } from '../hooks/useAttention'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'
import { useChatStore } from '../stores/chatStore'
import { clearTurnClock, turnElapsedMs } from '../utils/turnClock'

// 迟到帧收敛回归（oh-my-pi /compact 粘死气泡）：
// 后端「内容帧」与「turn 终态帧」走两条无顺序保证的广播链路。turn 只推一帧正文
// （compact 的典型形态）时，终态帧可能先到——此后迟到的正文帧曾按流式语义新建
// streaming 气泡，而 prompt_done 不会来第二次，气泡永久停留在「工作中」实时计时。
// 修复：会话无活跃 turn 时按「已定稿」模式落地，绝不铸 streaming 气泡。
//
// rAF 用手动队列桩（同 useAcpChat.livebuffer.test.tsx）：jsdom 的真 rAF 派发时机
// 不可控，帧的提交时机必须由用例显式驱动。

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

const chunkFrame = (text: string) => ({ AgentMessageChunk: { content: { Text: { text } } } })

describe('useAcpChat 迟到帧收敛（终态帧先到）', () => {
  let root: Root | null = null
  let rafQueue: FrameRequestCallback[] = []

  beforeEach(() => {
    MockWebSocket.instances = []
    rafQueue = []
    useChatStore.setState({ states: {} })
    clearTurnClock()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    clearTurnClock()
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

  const send = (ws: MockWebSocket, frame: Record<string, unknown>) => {
    act(() => {
      ws.onmessage?.({ data: JSON.stringify(frame) })
    })
  }

  const flushRaf = () => {
    act(() => {
      for (const cb of rafQueue.splice(0)) cb(0)
    })
  }

  it('prompt_done 先到、正文帧迟到：不铸 streaming 气泡，落为已定稿消息', () => {
    const ws = mount()
    act(() => {
      const st = useChatStore.getState()
      st.addUserMessage('s1', '/compact')
      st.beginPrompt('s1')
    })

    // 终态帧先于本 turn 唯一的内容帧抵达（两条广播链路无顺序保证）
    send(ws, { type: 'prompt_done', stop_reason: 'end_turn', row_id: 'row-9' })
    send(ws, { type: 'session_update', seq: 1, data: { update: chunkFrame('Compaction complete.') } })
    flushRaf()

    const st = useChatStore.getState().states['s1']
    expect(st.messages).toHaveLength(2)
    const last = st.messages[1]
    expect(last.role).toBe('assistant')
    expect(last.streaming).toBe(false)
    expect(last.text).toBe('Compaction complete.')
    // 无活跃计时尾随（markDone 已 endTurn）：不会出现「工作中」实时元信息
    expect(turnElapsedMs('s1')).toBeNull()
    expect(st.sending).toBe(false)
  })

  it('正文先到、终态随后、又一帧迟到：全部合并进同一已定稿消息（dbId 保留）', () => {
    const ws = mount()
    act(() => {
      useChatStore.getState().beginPrompt('s1')
    })

    send(ws, { type: 'session_update', seq: 1, data: { update: chunkFrame('part 1') } })
    flushRaf()
    expect(useChatStore.getState().states['s1'].messages[0].streaming).toBe(true)

    send(ws, { type: 'prompt_done', stop_reason: 'end_turn', row_id: 'row-7' })
    send(ws, { type: 'session_update', seq: 2, data: { update: chunkFrame(' part 2') } })
    flushRaf()

    const msgs = useChatStore.getState().states['s1'].messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0].streaming).toBe(false)
    expect(msgs[0].text).toBe('part 1 part 2')
    expect(msgs[0].dbId).toBe('row-7')
  })

  it('活跃 turn 内（sending=true）流式语义不变：气泡保持 streaming', () => {
    const ws = mount()
    act(() => {
      useChatStore.getState().beginPrompt('s1')
    })

    send(ws, { type: 'session_update', seq: 1, data: { update: chunkFrame('streaming now') } })
    flushRaf()

    const st = useChatStore.getState().states['s1']
    expect(st.messages[0].streaming).toBe(true)
    expect(turnElapsedMs('s1')).not.toBeNull()
  })

  it('Superseded 终态：停表定稿且不 fire attention；随后 turn_state(active:true) 重开计时', () => {
    vi.mocked(fakeAttention.fire).mockClear()
    const ws = mount()
    act(() => {
      useChatStore.getState().beginPrompt('s1')
    })

    // 旧 turn 正在流式：若 agent（如 oh-my-pi /compact 后的某类实现）就此沉默，
    // 没有后端顶替定稿时这个气泡会永远停在「工作中」实时计时。
    send(ws, { type: 'session_update', seq: 1, data: { update: chunkFrame('old turn text') } })
    flushRaf()
    expect(useChatStore.getState().states['s1'].messages[0].streaming).toBe(true)
    expect(turnElapsedMs('s1')).not.toBeNull()

    // 用户直接发了下一条 prompt：后端合成 Superseded 终态帧（旧 turn 未回结束信号）
    send(ws, {
      type: 'prompt_done',
      stop_reason: 'Superseded',
      row_id: 'row-1',
      duration: { work_ms: 5000, wait_ms: 0 },
      abnormal: false,
    })

    const st = useChatStore.getState().states['s1']
    expect(st.messages[0].streaming).toBe(false)
    expect(st.messages[0].durationMs).toBe(5000)
    expect(st.messages[0].dbId).toBe('row-1')
    expect(turnElapsedMs('s1')).toBeNull()
    expect(st.sending).toBe(false)
    // 顶替不是「完成」：用户正在输入，不该被 done 提醒叫回。
    expect(fakeAttention.fire).not.toHaveBeenCalled()

    // 新 turn 紧随其后：turn_state(active:true) 重开计时与发送指示器。
    send(ws, { type: 'turn_state', active: true })
    const st2 = useChatStore.getState().states['s1']
    expect(st2.sending).toBe(true)
    expect(turnElapsedMs('s1')).not.toBeNull()
    expect(fakeAttention.fire).not.toHaveBeenCalled()
  })
})
