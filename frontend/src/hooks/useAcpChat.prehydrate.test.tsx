import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAcpChat } from './useAcpChat'
import { AttentionContext } from '../hooks/useAttention'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'
import { useChatStore } from '../stores/chatStore'
import '../i18n'

// preHydrateBuffer 限界 + cleanup flush 的会话归属（2026-10-10 计划 ⑨）：
// - preHydrateBuffer 是 hydrate 门控的帧缓冲（窗口 = 一次 GET /messages 在飞），
//   agent 高频输出 × 大页面 hydrate 慢时帧数无自然上限——条数 + UTF-8 字节双上限，
//   越界丢最旧并置 needsCatchUp（被丢内容由聚焦补拉从 DB 幂等找回，不静默丢弃）。
// - ws 生命周期 effect 的 cleanup 里 flushLiveBuffer 读 sessionIdRef.current 时 ref
//   已被 render 赋成新会话——旧会话的积压动作会错投进新会话 store；flush 必须落
//   到「本 effect 的 sessionId」。

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

/** 受控 sessionId：⑨b 用例要在不卸载组件的前提下切换会话（触发 effect cleanup）。 */
function Harness({ sessionIdRef }: { sessionIdRef: { current: string } }) {
  useAcpChat({ sessionId: sessionIdRef.current })
  return null
}

/** rAF 停摆开关：⑨b 需要积压留在 liveBuffer 里不被消费。 */
let rafPaused = false
let rafQueue: FrameRequestCallback[] = []

const modeFrame = (mode: string) => ({
  type: 'session_update',
  data: { update: { CurrentModeUpdate: { mode } } },
})

/** 入缓冲后经 markError 落到 store.error 的帧——丢弃与否可在回放后直接观测。 */
const errorFrame = (message: string) => ({ type: 'prompt_error', message })

describe('useAcpChat preHydrateBuffer 限界与 flush 会话归属（2026-10-10 ⑨）', () => {
  let root: Root | null = null
  let sidRef: { current: string }
  let host: HTMLDivElement

  beforeEach(() => {
    MockWebSocket.instances = []
    rafQueue = []
    rafPaused = false
    useChatStore.setState({ states: {} })
    sidRef = { current: 's1' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      if (rafPaused) return 0
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    // fake timers 必须先于 mount：liveBuffer 的 1s 兜底 flush 定时器在 mount effect
    // 里创建，装晚了 advanceTimersByTime 管不到它（mode 动作要经它才进 store）。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })

    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => {
      root!.render(
        <AttentionContext.Provider value={fakeAttention}>
          <Harness sessionIdRef={sidRef} />
        </AttentionContext.Provider>,
      )
    })
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    host.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    useChatStore.setState({ states: {} })
  })

  const ws = () => MockWebSocket.instances[0]
  const send = (frame: Record<string, unknown>) => {
    act(() => {
      ws().onmessage?.({ data: JSON.stringify(frame) })
    })
  }

  it('条数越界丢最旧并置 needsCatchUp：被丢帧的效果不出现，保留帧按序回放', () => {
    // hydrate 未落定（未调 setHydrated）→ gated 帧全部入缓冲。
    const total = 2000 + 5
    send(errorFrame('dropped-early')) // 最旧的 5 条之首发：可观测的丢弃探针
    for (let i = 0; i < 4; i++) send(modeFrame(`fill-${i}`))
    for (let i = 5; i < total; i++) send(modeFrame(`m-${i}`))

    const st = () => useChatStore.getState().states['s1']
    // 帧全部留在缓冲、未派发（setNeedsCatchUp 丢弃路径已创建 state 条目，mode/error
    // 是 EMPTY 默认的 null）；越界已置聚焦补拉标记（丢最旧的显式找回路径）。
    expect(st()?.mode).toBeNull()
    expect(st()?.error).toBeNull()
    expect(st()?.needsCatchUp).toBe(true)

    // hydrate 落定 → 回放：恰保留最近 2000 条（m-5..m-2004），探针被丢。
    act(() => {
      useChatStore.getState().setHydrated('s1', true)
    })
    expect(st()?.error).toBeNull()
    expect(st()?.mode).toBe(`m-${total - 1}`)
  })

  it('字节越界同样丢最旧（单帧大小由 agent 决定，条数上限界不住体积）', () => {
    // 一条 > 2 MiB 的 prompt_error（UTF-8 字节超限）+ 一条小 mode 帧：第二条入队时
    // 总量越界，最旧的 error 帧被丢。
    send(errorFrame('x'.repeat(2 * 1024 * 1024 + 64)))
    send(modeFrame('after'))

    act(() => {
      useChatStore.getState().setHydrated('s1', true)
    })
    // mode 动作走 liveBuffer（rAF/兜底定时器才进 store）：推进一拍兜底定时器。
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    const st = useChatStore.getState().states['s1']
    expect(st?.error).toBeNull()
    expect(st?.mode).toBe('after')
    expect(st?.needsCatchUp).toBe(true)
  })

  it('正常窗口内不丢帧：hydrate 落定后按序回放全部', () => {
    send(errorFrame('kept'))
    send(modeFrame('m-final'))

    act(() => {
      useChatStore.getState().setHydrated('s1', true)
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    const st = useChatStore.getState().states['s1']
    expect(st?.error).toBe('kept')
    expect(st?.mode).toBe('m-final')
    expect(st?.needsCatchUp).not.toBe(true)
  })

  it('切会话触发 cleanup 时，积压的 live 动作落进旧会话而非新会话（⑨b）', () => {
    rafPaused = true
    act(() => {
      ws().onopen?.()
      useChatStore.getState().setHydrated('s1', true)
    })
    send(modeFrame('s1-pending'))
    // rAF 停摆：动作仍在 liveBuffer，未进 store（mode 仍是 hydrate 时的空态 null）。
    expect(useChatStore.getState().states['s1']?.mode).toBeNull()

    // 切会话（不卸载组件）：render 已把 sessionIdRef 换成 s2，随后 cleanup 运行——
    // 修复前 flush 读 ref 会把 s1 的动作错投进 s2。
    sidRef.current = 's2'
    act(() => {
      root!.render(
        <AttentionContext.Provider value={fakeAttention}>
          <Harness sessionIdRef={sidRef} />
        </AttentionContext.Provider>,
      )
    })

    expect(useChatStore.getState().states['s1']?.mode).toBe('s1-pending')
    // s2 条目由新连接的 setError(sid, null) 初始化（EMPTY 默认 mode=null）——
    // 重点是没收到 s1 的任何动作。
    expect(useChatStore.getState().states['s2']?.mode).toBeNull()
  })
})
