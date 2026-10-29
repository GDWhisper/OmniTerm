import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAcpChat } from './useAcpChat'
import { AttentionContext } from '../hooks/useAttention'
import type { AttentionContextValue } from '../components/Attention/AttentionProvider'
import { useChatStore } from '../stores/chatStore'
import i18n from '../i18n'

// sendPrompt 卫哨失败的可见化（2026-10-10 计划 ①）：socket 不可用时旧行为静默
// return——用户侧「能打字、回车毫无反应」，与「离开浏览器后假死」完全同形
// （AGENTS §S2 禁吞异常的前端对应形态：卫哨条件吞掉了整个失败语义）。
// 契约：失败落 store error（错误条渲染路径），不插用户气泡、不 toast；文案按
// connectionState 分档（connecting → 重连中，否则 → 未发送）；空输入仍是正常
// 输入守卫，静默。

class MockWebSocket {
  static CONNECTING = 0
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

/** 经对象属性收集最新 render 的 sendPrompt（模块级 let 重赋值会被 react-refresh
 *  规则拒绝；属性赋值不受限，prehydrate 测试同模式）。 */
const sendRef: { current: ReturnType<typeof useAcpChat>['sendPrompt'] | null } = { current: null }

function Harness({ sessionId }: { sessionId: string }) {
  sendRef.current = useAcpChat({ sessionId }).sendPrompt
  return null
}

describe('useAcpChat sendPrompt 卫哨失败可见化（2026-10-10 ①）', () => {
  let root: Root | null = null

  beforeEach(async () => {
    MockWebSocket.instances = []
    useChatStore.setState({ states: {} })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    vi.stubGlobal('WebSocket', MockWebSocket)
    // 文案断言固定语言（detector 会跟 navigator 漂移，CI 环境不可控）。
    await i18n.changeLanguage('zh')
  })

  afterEach(() => {
    act(() => {
      root?.unmount()
    })
    root = null
    vi.unstubAllGlobals()
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
    return MockWebSocket.instances[0]
  }

  it('socket CONNECTING（正在重连）→ 落重连文案，不发帧不插气泡', () => {
    const ws = mount()
    ws.readyState = MockWebSocket.CONNECTING
    act(() => {
      sendRef.current!('hello')
    })
    const st = useChatStore.getState().states['s1']
    expect(st?.error).toBe('正在重连，稍候重发')
    expect(st?.messages).toHaveLength(0)
    expect(ws.sent).toHaveLength(0)
  })

  it('无 socket（onclose 已拆除）→ 落断开文案', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    act(() => {
      ws.onclose?.()
    })
    act(() => {
      sendRef.current!('hello')
    })
    const st = useChatStore.getState().states['s1']
    expect(st?.error).toBe('连接已断开，消息未发送')
    expect(st?.messages).toHaveLength(0)
  })

  it('握着 CLOSED 的死 socket（半开窗口）→ 同断开档，不乐观置 sending', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    // 心跳半开检测发现前的窗口形态：connectionState 仍是 connected，但底层已死。
    ws.readyState = MockWebSocket.CLOSED
    act(() => {
      sendRef.current!('hello')
    })
    const st = useChatStore.getState().states['s1']
    expect(st?.error).toBe('连接已断开，消息未发送')
    expect(st?.sending).toBe(false)
    expect(st?.messages).toHaveLength(0)
  })

  it('空输入（无文字无附件）是正常守卫：静默，不落 error', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    act(() => {
      sendRef.current!('   ')
    })
    const st = useChatStore.getState().states['s1']
    expect(st?.error).toBeNull()
    expect(st?.messages).toHaveLength(0)
    expect(ws.sent).toHaveLength(0)
  })

  it('成功路径不回归：发 prompt 帧、乐观 user 行、置 sending', () => {
    const ws = mount()
    act(() => {
      ws.onopen?.()
    })
    act(() => {
      sendRef.current!('hello')
    })
    const st = useChatStore.getState().states['s1']
    expect(st?.error).toBeNull()
    expect(st?.sending).toBe(true)
    expect(st?.messages).toHaveLength(1)
    expect(st?.messages[0]).toMatchObject({ role: 'user', text: 'hello' })
    const frame = JSON.parse(ws.sent[0])
    expect(frame).toMatchObject({ type: 'prompt', text: 'hello' })
  })
})
