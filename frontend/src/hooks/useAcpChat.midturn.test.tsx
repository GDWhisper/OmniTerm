import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAcpChat, decodeStoredBlocks } from './useAcpChat'
import { AttentionContext } from '../hooks/useAttention'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'
import { useChatStore } from '../stores/chatStore'

// 流式中刷新丢早期正文的修复测试：
// B —— 后端帧窗口从头部驱逐（turn_accumulator.rs MAX_BLOCKS_BYTES），RAW 帧包裹解码时
//      用后端全量 text 列补被驱逐的正文前缀（endsWith 精确后缀守卫，失配宁缺勿错）；
// A —— 收到 turn_snapshot 的连接属中途加入，prompt_done 时跳过 cooked 回写，
//      避免把窗口残片固化进 DB 行（早期正文永久丢失）。

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

// 后端累积器落库/快照的原始帧包裹形态：{"v":1,"frames":[SessionUpdate...]}
const chunkFrame = (text: string) => ({
  AgentMessageChunk: { content: { Text: { text } } },
})
const frameWrapper = (texts: string[]) => JSON.stringify({ v: 1, frames: texts.map(chunkFrame) })

describe('evicted prose prefix recovery (decodeStoredBlocks)', () => {
  it('prepends the evicted prefix when window text is an exact suffix of the full text', () => {
    // 帧窗口只剩 "recent"，早期正文 "early prose " 已被驱逐、只活在 text 列。
    const blocks = decodeStoredBlocks(frameWrapper(['recent']), 'early prose recent')
    expect(blocks).toEqual([
      { type: 'text', text: 'early prose ' },
      { type: 'text', text: 'recent' },
    ])
  })

  it('does not prepend when nothing was evicted (window text equals full text)', () => {
    const blocks = decodeStoredBlocks(frameWrapper(['all of it']), 'all of it')
    expect(blocks).toEqual([{ type: 'text', text: 'all of it' }])
  })

  it('refuses to prepend on suffix mismatch (drift — never emit wrong-order content)', () => {
    // text 语义漂移/尾窗修剪导致窗口正文不是全量 text 的后缀 → 宁缺勿错。
    const blocks = decodeStoredBlocks(frameWrapper(['window body']), 'unrelated full text')
    expect(blocks).toEqual([{ type: 'text', text: 'window body' }])
  })

  it('keeps the user-readable omission marker in the prefix when the text column is folded', () => {
    const marker = '\n…（已省略 12345 字符）…\n'
    const fullText = `head${marker}tail end`
    const blocks = decodeStoredBlocks(frameWrapper(['tail end']), fullText)
    expect(blocks).toEqual([
      { type: 'text', text: `head${marker}` },
      { type: 'text', text: 'tail end' },
    ])
  })

  it('passes cooked arrays through untouched', () => {
    const cooked = [{ type: 'text', text: 'cooked' }]
    expect(decodeStoredBlocks(JSON.stringify(cooked), 'ignored prefix source')).toEqual(cooked)
  })

  it('decodes a host inline SYSTEM frame in place and preserves noticeId', () => {
    const wrapper = JSON.stringify({
      v: 1,
      frames: [
        chunkFrame('before'),
        {
          sessionUpdate: 'session_info_update',
          _meta: {
            omnitermSystem: {
              id: 'n1',
              label: 'system.permTimeout.auto',
              detail: { seconds: 0 },
            },
          },
        },
        chunkFrame('after'),
      ],
    })
    expect(decodeStoredBlocks(wrapper, 'beforeafter')).toEqual([
      { type: 'text', text: 'before' },
      {
        type: 'system',
        label: 'system.permTimeout.auto',
        detail: { seconds: 0 },
        noticeId: 'n1',
      },
      { type: 'text', text: 'after' },
    ])
  })

  it('drops current_mode_update frames instead of decoding a SYSTEM block', () => {
    const wrapper = JSON.stringify({
      v: 1,
      frames: [
        chunkFrame('before'),
        { sessionUpdate: 'current_mode_update', currentModeId: 'plan' },
        chunkFrame('after'),
      ],
    })
    expect(decodeStoredBlocks(wrapper, 'beforeafter')).toEqual([
      { type: 'text', text: 'beforeafter' },
    ])
  })
})

describe('mid-turn join — prompt_done skips cooked write-back', () => {
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
    return MockWebSocket.instances[0]
  }

  const send = (ws: MockWebSocket, frame: Record<string, unknown>) => {
    act(() => {
      ws.onmessage?.({ data: JSON.stringify(frame) })
    })
  }

  // 注：「快照后重开观测窗、重放文本不进 tps 分子」曾在此用本地 turnClock 断言；
  // 该语义 2026-10-15 随计算迁后端整体改写——后端累积器对重放帧结构性不记账
  // （无 begin_turn 门控，见 turn_accumulator::fold），口径回归在
  // `src/acp/turn_accumulator.rs` 的测试模块。

  it('turn_snapshot restores evicted prose and suppresses the cooked write-back', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
      useChatStore.getState().setHydrated('s1', true)
    })

    send(ws, {
      type: 'turn_snapshot',
      row_id: 'row-9',
      text: 'early prose recent',
      blocks: frameWrapper(['recent']),
      seq: 42,
    })

    const msgs = useChatStore.getState().states['s1'].messages
    expect(msgs).toHaveLength(1)
    // 快照 blocks 用全量 text 补齐被驱逐的早期正文。
    expect(msgs[0].blocks).toEqual([
      { type: 'text', text: 'early prose ' },
      { type: 'text', text: 'recent' },
    ])
    expect(msgs[0].id).toBe('row-9')
    expect(msgs[0].streaming).toBe(true)

    // 中途加入：prompt_done 不得把窗口残片 cooked 回写进 DB 行。
    send(ws, { type: 'prompt_done', stop_reason: 'end_turn', row_id: 'row-9' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(useChatStore.getState().states['s1'].messages[0].streaming).toBeFalsy()
  })

  it('a turn run from the start still writes cooked back on prompt_done', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
      useChatStore.getState().setHydrated('s1', true)
      // 生产路径：本端发 prompt 必先 beginPrompt（sending=true = 活跃 turn，
      // 流式语义的前提；无活跃 turn 的帧走「已定稿」收敛，见 lateframe 测试）。
      useChatStore.getState().beginPrompt('s1')
    })

    send(ws, {
      type: 'session_update',
      seq: 1,
      data: { update: chunkFrame('full answer') },
    })
    send(ws, { type: 'prompt_done', stop_reason: 'end_turn', row_id: 'row-7' })

    // 本连接从头持有完整帧流 → 照常回写（带 row_id 的 UPDATE，体积收敛路径不失效）。
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/messages/sync')
    const body = JSON.parse(init.body)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].id).toBe('row-7')
    expect(body.messages[0].text).toBe('full answer')
  })

  it('mid-turn SYSTEM session_update 内联进 assistant 消息（不是独立 SYSTEM 消息）', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
      useChatStore.getState().setHydrated('s1', true)
      useChatStore.getState().beginPrompt('s1')
    })

    send(ws, {
      type: 'session_update',
      seq: 1,
      data: { update: chunkFrame('before') },
    })
    send(ws, {
      type: 'session_update',
      seq: 2,
      data: {
        update: {
          sessionUpdate: 'session_info_update',
          _meta: {
            omnitermSystem: {
              id: 'n1',
              label: 'test.notice',
              detail: { seconds: 0 },
            },
          },
        },
      },
    })
    // prompt_done 会先 flush liveBuffer；告知应与正文同处一条 assistant 消息。
    send(ws, { type: 'prompt_done', stop_reason: 'end_turn', row_id: 'row-8' })

    const msgs = useChatStore.getState().states['s1'].messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].blocks).toEqual([
      { type: 'text', text: 'before' },
      { type: 'system', label: 'test.notice', detail: { seconds: 0 }, noticeId: 'n1' },
    ])
    // cooked 回写同样带内联告知，不允许被覆盖丢失。
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(JSON.parse(body.messages[0].blocks)).toEqual(msgs[0].blocks)
  })

  it('the skip is per-turn: the next turn after a mid-turn join writes back again', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
      useChatStore.getState().setHydrated('s1', true)
    })

    send(ws, {
      type: 'turn_snapshot',
      row_id: 'row-9',
      text: 'recent',
      blocks: frameWrapper(['recent']),
      seq: 42,
    })
    send(ws, { type: 'prompt_done', stop_reason: 'end_turn', row_id: 'row-9' })
    expect(fetchMock).not.toHaveBeenCalled()

    // 下一 turn 从头跑：标记已复位，回写恢复（beginPrompt = 用户又发了一条 prompt）。
    act(() => {
      useChatStore.getState().beginPrompt('s1')
    })
    send(ws, {
      type: 'session_update',
      seq: 1,
      data: { update: chunkFrame('next answer') },
    })
    send(ws, { type: 'prompt_done', stop_reason: 'end_turn', row_id: 'row-10' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].id).toBe('row-10')
  })

  it('ACP current_mode_update（currentModeId）更新模式且不拆 turn', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
      useChatStore.getState().setHydrated('s1', true)
      useChatStore.getState().beginPrompt('s1')
    })

    send(ws, {
      type: 'session_update',
      seq: 1,
      data: { update: chunkFrame('before') },
    })
    // 真实 ACP 线格式：sessionUpdate 判别串 + camelCase currentModeId。
    send(ws, {
      type: 'session_update',
      seq: 2,
      data: { update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } },
    })
    send(ws, {
      type: 'session_update',
      seq: 3,
      data: { update: chunkFrame(' after') },
    })
    send(ws, { type: 'prompt_done', stop_reason: 'end_turn', row_id: 'row-11' })

    const st = useChatStore.getState().states['s1']
    expect(st.mode).toBe('plan')
    // 状态更新不得落成独立 SYSTEM 消息：否则尾部被打断，同一 turn 被拆成两条
    // assistant（前一条的尾随过程块露在折叠容器外）。
    expect(st.messages).toHaveLength(1)
    expect(st.messages[0].role).toBe('assistant')
    expect(st.messages[0].blocks).toEqual([{ type: 'text', text: 'before after' }])
  })

  it('形状不认识的 current_mode_update 直接丢弃，不退化成 SYSTEM 消息', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
      useChatStore.getState().setHydrated('s1', true)
      useChatStore.getState().beginPrompt('s1')
    })

    send(ws, {
      type: 'session_update',
      seq: 1,
      data: { update: chunkFrame('before') },
    })
    send(ws, {
      type: 'session_update',
      seq: 2,
      data: { update: { sessionUpdate: 'current_mode_update' } },
    })
    send(ws, {
      type: 'session_update',
      seq: 3,
      data: { update: chunkFrame(' after') },
    })
    send(ws, { type: 'prompt_done', stop_reason: 'end_turn', row_id: 'row-12' })

    const st = useChatStore.getState().states['s1']
    expect(st.messages).toHaveLength(1)
    expect(st.messages[0].blocks).toEqual([{ type: 'text', text: 'before after' }])
  })

  it('turn_snapshot 收编被 SYSTEM 行切开的 streaming 分身，后续帧继续挂到快照', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
      useChatStore.getState().setHydrated('s1', true)
      useChatStore.getState().beginPrompt('s1')
    })

    send(ws, {
      type: 'session_update',
      seq: 1,
      data: { update: chunkFrame('early') },
    })
    // 独立 SYSTEM 行把尾部从 assistant 上摘掉；随后 prose 只能另起一条 assistant。
    send(ws, { type: 'system_message', label: 'CurrentModeUpdate' })
    send(ws, {
      type: 'session_update',
      seq: 2,
      data: { update: chunkFrame('more') },
    })
    send(ws, { type: 'system_message', label: 'notice2' })

    send(ws, {
      type: 'turn_snapshot',
      row_id: 'row-9',
      text: 'earlymore',
      blocks: frameWrapper(['earlymore']),
      seq: 10,
    })
    send(ws, {
      type: 'session_update',
      seq: 11,
      data: { update: chunkFrame(' tail') },
    })
    send(ws, { type: 'prompt_done', stop_reason: 'end_turn', row_id: 'row-9' })

    const msgs = useChatStore.getState().states['s1'].messages
    // 两条 streaming 分身都被快照收编，只剩 SYSTEM 行 + 一条快照消息。
    expect(msgs.map((m) => m.role)).toEqual(['system', 'system', 'assistant'])
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(msgs[2].id).toBe('row-9')
    // 快照之后的 live 帧仍能挂到快照上（tail 是 streaming assistant）。
    expect(msgs[2].text).toBe('earlymore tail')
    expect(msgs[2].streaming).toBeFalsy()
  })
})
