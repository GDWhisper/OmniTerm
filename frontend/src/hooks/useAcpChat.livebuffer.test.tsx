import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAcpChat } from './useAcpChat'
import { AttentionContext } from '../hooks/useAttention'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'
import { useChatStore } from '../stores/chatStore'
import { LiveBuffer, LIVE_BUFFER_FLUSH_FALLBACK_MS, LIVE_BUFFER_MAX_ACTIONS } from '../utils/liveBuffer'

// liveBuffer 接线回归（2026-10-10「长时间离开浏览器后假死」）：
// 隐藏页 / 后台标签**不派发 rAF**（动画帧随渲染一起停），而 WS 消息照常投递。
// 只靠 rAF 的 flush ⇒ 离开多久缓冲就累积多久，回来时一帧吐完半天，
// `applyActionsToMessages` 每个 action 全量浅拷贝 messages ⇒ 主线程阻塞数秒。
// 两条防线在此固化：① 越界即 flush（硬上限，rAF 不来也成立）；
//                 ② 1s 兜底定时器（rAF 停摆时分批提交）。
//
// 观测点选 `LiveBuffer.prototype.take`（每次 flush 恰调一次）而非 store action：
// zustand 每次 set 都新建 state 对象并拷贝自身属性，间谍装在哪个对象上会被
// 拷贝传播、`restoreAllMocks` 收不干净，跨用例串话。

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

/** rAF 停摆开关：true = 模拟隐藏页（回调排队但永不被浏览器调度）。 */
let rafPaused = false
let rafQueue: FrameRequestCallback[] = []

/** 一条 `setMode` 帧：分类为结构性 action（不与相邻 prose 合并），用于堆满条数上限。 */
const modeFrame = (mode: string) => ({
  type: 'session_update',
  data: { update: { CurrentModeUpdate: { mode } } },
})

/** 只伪装定时器：不碰 Date（useAcpChat 的 turn 计时读 Date.now）。 */
const useOnlyTimers = () =>
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })

describe('useAcpChat liveBuffer 限界接线', () => {
  let root: Root | null = null

  beforeEach(() => {
    MockWebSocket.instances = []
    rafQueue = []
    rafPaused = false
    useChatStore.setState({ states: {} })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      if (rafPaused) return 0
      rafQueue.push(cb)
      return rafQueue.length
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    // 上千帧的用例会把 DEV 调试日志刷满 stdout
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

  const send = (ws: MockWebSocket, frame: Record<string, unknown>) => {
    act(() => {
      ws.onmessage?.({ data: JSON.stringify(frame) })
    })
  }

  const mode = () => useChatStore.getState().states['s1']?.mode

  it('rAF 停摆时越界即 flush：不成一帧巨批，残差由兜底定时器收尾且一条不丢', () => {
    useOnlyTimers()
    rafPaused = true
    const ws = mount()
    const takeSpy = vi.spyOn(LiveBuffer.prototype, 'take')

    const total = LIVE_BUFFER_MAX_ACTIONS * 2 + 100
    for (let i = 0; i < total; i++) send(ws, modeFrame(`m${i}`))

    // 硬上限生效：rAF 一次都没来，仍按上限分批提交（各批恰为上限，无巨批）
    expect(takeSpy).toHaveBeenCalledTimes(2)
    const sizes = takeSpy.mock.results.map((r) => (r.value as unknown[]).length)
    expect(sizes).toEqual([LIVE_BUFFER_MAX_ACTIONS, LIVE_BUFFER_MAX_ACTIONS])
    // 未越界的残差（100 条）仍在缓冲里，等下一个 flush 触发器
    expect(mode()).toBe(`m${LIVE_BUFFER_MAX_ACTIONS * 2 - 1}`)

    act(() => {
      vi.advanceTimersByTime(LIVE_BUFFER_FLUSH_FALLBACK_MS)
    })
    // 守恒：推送 total 条，最终全部落到 store（超限策略是提前 flush，不是丢弃）
    expect(takeSpy).toHaveBeenCalledTimes(3)
    expect((takeSpy.mock.results[2].value as unknown[]).length).toBe(100)
    expect(mode()).toBe(`m${total - 1}`)
  })

  it('rAF 停摆时兜底定时器按期分批提交', () => {
    useOnlyTimers()
    rafPaused = true
    const ws = mount()
    const takeSpy = vi.spyOn(LiveBuffer.prototype, 'take')

    send(ws, modeFrame('a'))
    send(ws, modeFrame('b'))
    expect(takeSpy).not.toHaveBeenCalled() // rAF 停摆、定时器未到点
    expect(mode()).toBeNull()

    act(() => {
      vi.advanceTimersByTime(LIVE_BUFFER_FLUSH_FALLBACK_MS)
    })
    expect(takeSpy).toHaveBeenCalledTimes(1)
    expect(mode()).toBe('b')
  })

  it('rAF 正常时仍走每帧一次的老路径（兜底定时器命中空缓冲即 no-op）', () => {
    useOnlyTimers()
    const ws = mount()
    const takeSpy = vi.spyOn(LiveBuffer.prototype, 'take')

    send(ws, modeFrame('x'))
    expect(takeSpy).not.toHaveBeenCalled() // 还在等这一个动画帧
    expect(mode()).toBeNull()
    act(() => {
      for (const cb of rafQueue.splice(0)) cb(0)
    })
    expect(takeSpy).toHaveBeenCalledTimes(1)
    expect(mode()).toBe('x')

    act(() => {
      vi.advanceTimersByTime(LIVE_BUFFER_FLUSH_FALLBACK_MS * 3)
    })
    expect(takeSpy).toHaveBeenCalledTimes(1) // 空缓冲不重复提交
  })
})
