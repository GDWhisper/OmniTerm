import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAcpChat } from './useAcpChat'
import { AttentionContext } from '../hooks/useAttention'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'
import { useChatStore, type ChatMessage } from '../stores/chatStore'

// 手动恢复重放按 id 收敛（docs/dev/plans/2026-09-19-acp-failure-visibility.md D4 / P1）：
// 手动 restore 时 suppressReplay 恒为 false → replay_end 必走 commitReplay（store 从
// 空白重建，hydrate 行的 dbId 全丢）→ 全量 syncToDb 发无 id 载荷 → 后端文本匹配因
// 语义漂移失配 → INSERT 重复 assistant 行。本文件固化「带 dbId 的对齐写回」接线。
//
// 无 @testing-library/react，用 react-dom 手动渲染 + 可控 MockWebSocket 驱动帧序
// （与 useAcpChat.ghost.test.tsx / useAcpChat.turnfailure.test.tsx 同一套骨架）。
//
// **手动恢复必须走真实入口 `restore()`**：`isManualRestore` 只由该回调置位（它发送
// `load_session`），WS 帧不携带这个语义。直接派发 `replay_start` 帧会走「连接即重放」
// 路径，`manualReplayBaseline` 恒为空 → 本文件想测的对齐分支根本不会执行。

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

// 把 hook 的 restore 提到 Harness 外部：组件内不得写模块级变量（react-hooks/globals），
// 且测试要调的是**真实用户入口** restore()——ChatView 的恢复按钮正是调它。
// 类型用 ReturnType 推导而非改 useAcpChat 的导出面——测试只为拿一个回调句柄。
const hookBox: { current: ReturnType<typeof useAcpChat> | null } = { current: null }

function Harness({ sessionId }: { sessionId: string }) {
  hookBox.current = useAcpChat({ sessionId })
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

// 重放内容帧：AgentMessageChunk → appendText（同一消息内的多帧合并成一条 assistant）。
const replayChunkFrame = (text: string) => ({
  type: 'session_update',
  data: { update: { AgentMessageChunk: { content: { Text: { text } } } } },
})

const userReplayFrame = (text: string) => ({
  type: 'session_update',
  data: { update: { UserMessageChunk: { content: { Text: { text } } } } },
})

describe('manual restore — replay sync aligns to existing rows (no duplicate INSERT)', () => {
  let root: Root | null = null
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    MockWebSocket.instances = []
    hookBox.current = null
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

  /** 用户点「恢复」：走 hook 的 restore()（置 isManualRestore + 发送 load_session）。 */
  const restore = (ws: MockWebSocket) => {
    act(() => {
      hookBox.current!.restore()
    })
    expect(ws.sent.some((s) => s.includes('load_session'))).toBe(true)
  }

  /** hydrate 落定（ChatView 的 GET /messages 落定 + setHydrated），放行帧派发。 */
  const settleHydrate = (messages: ChatMessage[] = []) => {
    act(() => {
      useChatStore.getState().hydrate('s1', messages, null)
      useChatStore.getState().setHydrated('s1', true)
    })
  }

  /** 取最后一次 /messages/sync 的请求体。 */
  const lastSyncBody = () => {
    const calls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/messages/sync'))
    expect(calls.length, '应当发生过 /messages/sync POST').toBeGreaterThan(0)
    return JSON.parse(calls[calls.length - 1][1].body)
  }

  const syncCallCount = () =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes('/messages/sync')).length

  it('replayed messages target the existing row ids — no duplicate assistant row', () => {
    // 核心回归（验收项「手动恢复不再产生重复行」）：手动恢复 + hydrate 已带 dbId 的
    // 权威行。断言 fetch 载荷带 id——前端测试没有真 DB，但后端 id 路径只 UPDATE blocks
    // 不 INSERT（见 chat_persistence.rs sync_messages 文档块），带 id 即不产生重复行。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate([
      mkMsg({ role: 'user', text: 'fix the build', dbId: 'row-u1', id: 'row-u1' }),
      mkMsg({ role: 'assistant', text: 'checking the log', dbId: 'row-a1', id: 'row-a1' }),
    ])

    restore(ws)
    send(ws, { type: 'replay_start' })
    send(ws, userReplayFrame('fix the build'))
    // 重放文本 = 完整历史（含工具描述段），基线行 text 是其前缀或相等。
    send(ws, replayChunkFrame('checking the log\nand patching src/a.ts'))
    send(ws, { type: 'replay_end' })

    const body = lastSyncBody()
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual([
      'fix the build',
      'checking the log\nand patching src/a.ts',
    ])
    // 两条都带真实 dbId → 后端走 id 路径 UPDATE，不 INSERT。
    expect(body.messages.map((m: { id?: string }) => m.id)).toEqual(['row-u1', 'row-a1'])
    // 消息条数不增加（对齐写回是收敛，不是重建）。
    expect(useChatStore.getState().states['s1'].messages).toHaveLength(2)
  })

  it('preserves the replayed blocks on the targeted row (cooked write-back)', () => {
    // 重放重建出的 cooked blocks 正是这次写回的价值：把 hydrate 快照缺的
    // thought/tool 块补回同一行（id 路径只更新 blocks，不动 text）。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate([
      mkMsg({
        role: 'assistant',
        text: 'reading the file',
        dbId: 'row-a1',
        id: 'row-a1',
        blocks: [{ type: 'text', text: 'reading the file' }],
      }),
    ])

    restore(ws)
    send(ws, { type: 'replay_start' })
    send(ws, replayChunkFrame('reading the file'))
    send(ws, {
      type: 'session_update',
      data: {
        update: { ToolCall: { toolCallId: 'tc-1', title: 'Edit src/a.ts', status: 'completed', kind: 'edit' } },
      },
    })
    send(ws, { type: 'replay_end' })

    const body = lastSyncBody()
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].id).toBe('row-a1')
    expect(JSON.parse(body.messages[0].blocks).map((b: { type: string }) => b.type)).toEqual([
      'text',
      'tool_call',
    ])
  })

  it('an empty baseline (store was empty at replay_start) falls back to the id-less full sync', () => {
    // 降级路径：hydrate 无行（新会话 / 未拉到历史）→ 无基线可对齐 → 走今天的
    // syncToDb 全量无 id 写回。后端无 id 路径按文本匹配、匹配不上就 INSERT，对那些
    // 「库里本来没有」的消息正是所需行为（2026-08-18 计划已把该路径的安全性固化）。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate([])

    restore(ws)
    send(ws, { type: 'replay_start' })
    send(ws, replayChunkFrame('first reply ever'))
    send(ws, { type: 'replay_end' })

    const body = lastSyncBody()
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(['first reply ever'])
    expect(body.messages[0]).not.toHaveProperty('id')
  })

  it('a drifted turn degrades to INSERT without taking the neighbouring rows down', () => {
    // 降级是单条粒度：第 2 条文本漂移失配 → 该条无 id（退化成 INSERT），
    // 第 1/3 条照常带 id UPDATE。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate([
      mkMsg({ role: 'user', text: 'q1', dbId: 'row-u1', id: 'row-u1' }),
      mkMsg({ role: 'assistant', text: 'DB says something else', dbId: 'row-a1', id: 'row-a1' }),
      mkMsg({ role: 'user', text: 'q2', dbId: 'row-u2', id: 'row-u2' }),
    ])

    restore(ws)
    send(ws, { type: 'replay_start' })
    send(ws, userReplayFrame('q1'))
    send(ws, replayChunkFrame('replayed text'))
    send(ws, userReplayFrame('q2'))
    send(ws, { type: 'replay_end' })

    const body = lastSyncBody()
    expect(body.messages.map((m: { id?: string }) => m.id)).toEqual(['row-u1', undefined, 'row-u2'])
  })

  it('a replay shorter than the baseline still aligns (suffix-shaped replay)', () => {
    // 形态：agent 只重放较近的几轮，重放消息对应的是基线里更靠后的行。
    // 只读扫描必须推过前面角色相同但文本不匹配的行，否则整份载荷退化成全量 INSERT。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate([
      mkMsg({ role: 'user', text: 'oldest question', dbId: 'u1', id: 'u1' }),
      mkMsg({ role: 'assistant', text: 'oldest answer', dbId: 'a1', id: 'a1' }),
      mkMsg({ role: 'user', text: 'recent question', dbId: 'u2', id: 'u2' }),
      mkMsg({ role: 'assistant', text: 'recent answer', dbId: 'a2', id: 'a2' }),
    ])

    restore(ws)
    send(ws, { type: 'replay_start' })
    send(ws, userReplayFrame('recent question'))
    send(ws, replayChunkFrame('recent answer'))
    send(ws, { type: 'replay_end' })

    expect(lastSyncBody().messages.map((m: { id?: string }) => m.id)).toEqual(['u2', 'a2'])
  })

  it('a non-manual replay (no hydrate rows) still uses the plain full sync', () => {
    // 连接即重放（用户没点恢复，因此没有 restore() → isManualRestore=false）+ hydrate
    // 无行：suppressReplay=false，但仍走**今天的**全量无 id 写回——不取基线。
    // 与 2026-08-18 方案 A 的既有边界一致：hydrate 为空时重放正常写回、全部 INSERT
    // 但无对应行，不产生幽灵行。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate([])

    send(ws, { type: 'replay_start' })
    send(ws, replayChunkFrame('agent replay'))
    send(ws, { type: 'replay_end' })

    const body = lastSyncBody()
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(['agent replay'])
    expect(body.messages[0]).not.toHaveProperty('id')
  })

  it('a non-manual replay with hydrate rows is suppressed and never syncs (方案 A)', () => {
    // 连接即重放且 hydrate 已有权威行 → suppressReplay=true → 内容帧丢弃、不
    // commitReplay 不 syncToDb（2026-08-18 计划 P0 方案 A 的行为，不得回归）。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate([mkMsg({ role: 'assistant', text: 'from db', dbId: 'row-1', id: 'row-1' })])

    send(ws, { type: 'replay_start' })
    send(ws, replayChunkFrame('agent replay'))
    send(ws, { type: 'replay_end' })

    expect(useChatStore.getState().states['s1'].messages.map((m) => m.text)).toEqual(['from db'])
    expect(syncCallCount()).toBe(0)
  })

  it('an agent that replays nothing keeps the empty-replay branch (system notice on manual restore)', () => {
    // 多实现兼容：session/load 是否重放历史是 agent 可选行为（§不纳入范围/风险与降级）。
    // 空重放分支不得改动：保留现有消息 + 手动恢复时提示 chat.replay.empty，且不写回。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate([mkMsg({ role: 'assistant', text: 'kept local', dbId: 'row-1', id: 'row-1' })])

    restore(ws)
    send(ws, { type: 'replay_start' })
    // 不推任何内容帧，只推一个状态同步帧（setMode 不进 messages）。
    send(ws, { type: 'session_update', data: { update: { CurrentModeUpdate: { mode: 'plan' } } } })
    send(ws, { type: 'replay_end' })

    const msgs = useChatStore.getState().states['s1'].messages
    expect(msgs).toHaveLength(2)
    expect(msgs[1].role).toBe('system')
    expect(msgs[1].blocks).toEqual([
      { type: 'system', label: 'chat.replay.empty', detail: undefined },
    ])
    expect(useChatStore.getState().states['s1'].mode).toBe('plan')
    // 空重放分支不做任何 sync 写回。
    expect(syncCallCount()).toBe(0)
  })

  it('consumes the baseline exactly once (a second restore does not resurrect old row ids)', () => {
    // 第一次恢复按 id 对齐写回；随后 store 是 commitReplay 从空白重建的消息（无 dbId）。
    // 第二次恢复若沿用第一次的基线，就会把 row-1 再次贴到语义无关的重建消息上
    // （UPDATE 错行）——故基线必须只用一次，第二次退化为无 id 全量写回。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    settleHydrate([mkMsg({ role: 'assistant', text: 'turn one', dbId: 'row-1', id: 'row-1' })])

    restore(ws)
    send(ws, { type: 'replay_start' })
    send(ws, replayChunkFrame('turn one'))
    send(ws, { type: 'replay_end' })
    expect(lastSyncBody().messages[0].id).toBe('row-1')

    restore(ws)
    send(ws, { type: 'replay_start' })
    send(ws, replayChunkFrame('turn one'))
    send(ws, { type: 'replay_end' })

    // 第二次：基线是重建出的无 dbId 消息 → 载荷与今天的全量 syncToDb 逐字一致。
    const second = lastSyncBody()
    expect(second.messages).toHaveLength(1)
    expect(second.messages[0]).not.toHaveProperty('id')
    expect(second.messages[0].blocks).toBe(
      JSON.stringify([{ type: 'text', text: 'turn one' }]),
    )
  })
})

describe('manual restore — aborted replay does not align against a stale baseline', () => {
  let root: Root | null = null
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    MockWebSocket.instances = []
    hookBox.current = null
    useChatStore.setState({ states: {} })
    fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', MockWebSocket)
    // 假时钟只服务自动重连的指数退避定时器（onclose → setTimeout(connect)）。
    // 必须在 rAF stub 之前调用：useFakeTimers 会重置全局，后置会连 stub 一起清掉。
    vi.useFakeTimers()
    // live 缓冲靠 rAF 合帧提交；假时钟不驱动 rAF，这里同步执行并把回调挂到全局，
    // 由测试在断言前手动 flush（等价「下一帧」）。
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      ;(globalThis as { __raf?: (() => void) | null }).__raf = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** flush liveBuffer：模拟浏览器把排队的 rAF 回调跑完（真实环境下每帧一次）。 */
  const flushRaf = () => {
    act(() => {
      const g = globalThis as { __raf?: (() => void) | null }
      let guard = 0
      while (g.__raf && guard < 8) {
        const cb = g.__raf
        g.__raf = null
        cb()
        guard += 1
      }
    })
  }

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

  const restore = (ws: MockWebSocket) => {
    act(() => {
      hookBox.current!.restore()
    })
    expect(ws.sent.some((s) => s.includes('load_session'))).toBe(true)
  }

  const syncBodies = () =>
    fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/messages/sync'))
      .map((c) => JSON.parse(c[1].body))

  it('a failed restore (error frame) leaves no stale baseline for the next one', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    act(() => {
      useChatStore.getState().hydrate(
        's1',
        [mkMsg({ role: 'assistant', text: 'old turn text', dbId: 'row-1', id: 'row-1' })],
        null,
      )
      useChatStore.getState().setHydrated('s1', true)
    })

    // 第一次恢复：replay_start 已快照基线（['old turn text'] / row-1），随后后端以
    // error 帧代替 replay_end（load_failed）→ abortReplay 复位 staging 与基线。
    restore(ws)
    send(ws, { type: 'replay_start' })
    send(ws, replayChunkFrame('partial replay'))
    send(ws, { type: 'error', message: 'load_failed' })

    // 恢复失败：现有消息保留、重放中止、不写回。
    expect(useChatStore.getState().states['s1'].messages.map((m) => m.text)).toEqual([
      'old turn text',
    ])
    expect(useChatStore.getState().states['s1'].replaying).toBe(false)
    expect(syncBodies()).toHaveLength(0)

    // 关键断言：失败恢复之后 store 内容被换成另一批行（reset + 重新 hydrate，
    // 会话状态重建的真实路径），再恢复时**不得**再按上一次那条陈旧基线对齐——
    // 'brand new turn' 不是 'old turn text' 的前缀，陈旧基线只能给出「无 id」。
    act(() => {
      useChatStore.getState().reset('s1')
      useChatStore.getState().hydrate(
        's1',
        [mkMsg({ role: 'assistant', text: 'brand new turn', dbId: 'row-9', id: 'row-9' })],
        null,
      )
      useChatStore.getState().setHydrated('s1', true)
    })

    restore(ws)
    send(ws, { type: 'replay_start' })
    send(ws, replayChunkFrame('brand new turn'))
    send(ws, { type: 'replay_end' })

    const bodies = syncBodies()
    expect(bodies).toHaveLength(1)
    // 指向新行的 id（来自本次新快照），而不是陈旧基线的 row-1 / 也不是「无 id」。
    expect(bodies[0].messages[0].id).toBe('row-9')
  })

  it('a replay interrupted by WS close does not freeze the store on reconnect', () => {
    // 重放期间断线：replay_end 已不可能到达（发进死连接），abortReplay 在 onclose
    // 路径里被调用。若 staging 不复位，重连后 live 帧会被无限期攒进 staging 永不提交，
    // 聊天界面冻结（useAcpChat.ts abortReplay 的既有契约）。
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    act(() => {
      useChatStore.getState().hydrate(
        's1',
        [mkMsg({ role: 'assistant', text: 'hydrated row', dbId: 'row-1', id: 'row-1' })],
        null,
      )
      useChatStore.getState().setHydrated('s1', true)
    })

    restore(ws)
    send(ws, { type: 'replay_start' })
    send(ws, replayChunkFrame('partial replay'))
    act(() => {
      ws.onclose?.()
    })
    expect(useChatStore.getState().states['s1'].replaying).toBe(false)
    // 断线前那条 staging 帧遗留下一个未 flush 的 rAF：在这里先排空，避免它把
    // 重连后的断言搅乱（live 路径与 staging 路径的提交时机不同）。
    flushRaf()

    // 自动重连（指数退避首档 1000ms）后 live 帧即时进 store。
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    const reconnected = MockWebSocket.instances[MockWebSocket.instances.length - 1]
    expect(reconnected).not.toBe(ws)
    act(() => {
      reconnected.onopen?.()
    })
    // live 帧进 liveBuffer 后要等 rAF flush（假时钟不驱动 rAF）。
    send(reconnected, replayChunkFrame('live after reconnect'))
    flushRaf()
    expect(useChatStore.getState().states['s1'].messages.map((m) => m.text)).toEqual([
      'hydrated row',
      'live after reconnect',
    ])
  })
})
