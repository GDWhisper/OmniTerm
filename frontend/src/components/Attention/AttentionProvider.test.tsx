import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { createContext, useContext, useState, useCallback } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AttentionProvider } from './AttentionProvider'
import { useAttention as useRealAttention } from '../../hooks/useAttention'
import { useAppStore } from '../../stores/appStore'

// ═══════════════════════════════════════════════════════════
// Replicate the attention logic inline for pure testing
// (same logic as AttentionProvider.tsx)
// ═══════════════════════════════════════════════════════════

type AttentionReason = 'decision' | 'done' | 'error'

interface AttentionAlert {
  targetId: string
  sessionKey: string
  reason: AttentionReason
}

interface AttentionContextValue {
  alerts: Map<string, AttentionAlert>
  fire: (targetId: string, sessionKey: string, reason: AttentionReason) => void
  clearAlert: (sessionKey: string) => void
  setActive: (sessionKey: string) => void
  reasonFor: (sessionKey: string) => AttentionReason | undefined
}

// ── Sound function (pure, testable) ──────────────────────

function createPingFunction(getCtx: () => AudioContext | null) {
  return function playPing() {
    const ctx = getCtx()
    if (!ctx) return
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {})
    }
    try {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.3, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(ctx.currentTime)
      osc.stop(ctx.currentTime + 0.3)
    } catch {
      // Web Audio not available
    }
  }
}

// ── Test the render-based provider ───────────────────────

const AttentionContext = createContext<AttentionContextValue | null>(null)

function TestProvider({ children, onAlert }: { children: React.ReactNode; onAlert?: () => void }) {
  const [alertsMap, setAlertsMap] = useState<Map<string, AttentionAlert>>(new Map())
  const activeRef = React.useRef<string | null>(null)

  const fire = useCallback((targetId: string, sessionKey: string, reason: AttentionReason) => {
    setAlertsMap(prev => {
      const next = new Map(prev)
      next.set(sessionKey, { targetId, sessionKey, reason })
      return next
    })
    onAlert?.()
  }, [onAlert])

  const clearAlert = useCallback((sessionKey: string) => {
    setAlertsMap(prev => {
      const next = new Map(prev)
      next.delete(sessionKey)
      return next
    })
  }, [])

  const setActive = useCallback((sessionKey: string) => {
    activeRef.current = sessionKey
    clearAlert(sessionKey)
  }, [clearAlert])

  const reasonFor = useCallback((sessionKey: string) => {
    return alertsMap.get(sessionKey)?.reason
  }, [alertsMap])

  return React.createElement(
    AttentionContext.Provider,
    { value: { alerts: alertsMap, fire, clearAlert, setActive, reasonFor } },
    children,
  )
}

function useAttention(): AttentionContextValue {
  const ctx = useContext(AttentionContext)
  if (!ctx) throw new Error('useAttention must be used within provider')
  return ctx
}

// ── Test helper: render a consumer component ─────────────

function renderConsumer(
  useValue: (val: AttentionContextValue) => void,
  onAlert?: () => void,
): { root: Root; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  function Consumer() {
    const val = useAttention()
    useValue(val)
    return null
  }

  root.render(React.createElement(TestProvider, { onAlert, children: React.createElement(Consumer) }))
  return { root, container }
}

// ── Tests ───────────────────────────────────────────────

describe('AttentionProvider', () => {
  let captured: AttentionContextValue | null = null
  let onAlertCalls: number

  beforeEach(() => {
    captured = null
    onAlertCalls = 0
  })

  function capture(val: AttentionContextValue) {
    captured = val
  }

  it('should fire an alert and retrieve via reasonFor', async () => {
    renderConsumer(capture, () => { onAlertCalls++ })

    // Wait for render
    await vi.waitFor(() => expect(captured).not.toBeNull())
    
    captured!.fire('target1', 'session1', 'decision')
    
    // re-render to get updated state
    await vi.waitFor(() => {
      const r = captured?.reasonFor('session1')
      expect(r).toBe('decision')
    })
    
    expect(onAlertCalls).toBe(1)
  })

  it('should clear an alert', async () => {
    renderConsumer(capture, () => { onAlertCalls++ })
    await vi.waitFor(() => expect(captured).not.toBeNull())

    captured!.fire('t1', 's1', 'done')
    await vi.waitFor(() => expect(captured?.reasonFor('s1')).toBe('done'))

    captured!.clearAlert('s1')
    await vi.waitFor(() => expect(captured?.reasonFor('s1')).toBeUndefined())
  })

  it('should clear alert via setActive', async () => {
    renderConsumer(capture)
    await vi.waitFor(() => expect(captured).not.toBeNull())

    captured!.fire('t1', 's1', 'error')
    await vi.waitFor(() => expect(captured?.reasonFor('s1')).toBe('error'))

    captured!.setActive('s1')
    await vi.waitFor(() => expect(captured?.reasonFor('s1')).toBeUndefined())
  })

  it('should handle multiple alerts', async () => {
    renderConsumer(capture)
    await vi.waitFor(() => expect(captured).not.toBeNull())

    captured!.fire('t1', 's1', 'decision')
    captured!.fire('t2', 's2', 'error')
    captured!.fire('t3', 's3', 'done')

    await vi.waitFor(() => {
      expect(captured?.reasonFor('s1')).toBe('decision')
      expect(captured?.reasonFor('s2')).toBe('error')
      expect(captured?.reasonFor('s3')).toBe('done')
      expect(captured?.alerts.size).toBe(3)
    })

    captured!.clearAlert('s2')
    await vi.waitFor(() => {
      expect(captured?.reasonFor('s2')).toBeUndefined()
      expect(captured?.alerts.size).toBe(2)
    })
  })

  it('should replace alert on re-fire', async () => {
    renderConsumer(capture)
    await vi.waitFor(() => expect(captured).not.toBeNull())

    captured!.fire('t1', 's1', 'decision')
    await vi.waitFor(() => expect(captured?.reasonFor('s1')).toBe('decision'))

    captured!.fire('t1', 's1', 'error')
    await vi.waitFor(() => {
      expect(captured?.reasonFor('s1')).toBe('error')
      expect(captured?.alerts.size).toBe(1)
    })
  })

  it('should return undefined for unknown session', async () => {
    renderConsumer(capture)
    await vi.waitFor(() => expect(captured).not.toBeNull())

    expect(captured?.reasonFor('nonexistent')).toBeUndefined()
    expect(captured?.alerts.size).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════
// Sound function tests (pure, no DOM needed)
// ═══════════════════════════════════════════════════════════

describe('playPing (sound)', () => {
  it('should create oscillator and gain nodes', () => {
    const mockOsc = { type: '', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }
    const mockGain = {
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }
    const mockCtx = {
      state: 'running' as const,
      currentTime: 0,
      createOscillator: () => mockOsc,
      createGain: () => mockGain,
      resume: vi.fn().mockResolvedValue(undefined),
      destination: {},
    }

    const ctxRef: AudioContext | null = mockCtx as unknown as AudioContext
    const playPing = createPingFunction(() => ctxRef)

    playPing()

    expect(mockOsc.type).toBe('sine')
    expect(mockOsc.frequency.value).toBe(880)
    expect(mockOsc.connect).toHaveBeenCalled()
    expect(mockOsc.start).toHaveBeenCalled()
    expect(mockOsc.stop).toHaveBeenCalled()
  })

  it('should resume suspended context', () => {
    const mockCtx = {
      state: 'suspended' as const,
      currentTime: 0,
      createOscillator: () => ({ type: '', frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }),
      createGain: () => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn() }),
      resume: vi.fn().mockResolvedValue(undefined),
      destination: {},
    }

    const ctxRef: AudioContext | null = mockCtx as unknown as AudioContext
    const playPing = createPingFunction(() => ctxRef)

    playPing()

    expect(mockCtx.resume).toHaveBeenCalled()
  })

  it('should not throw when AudioContext is null', () => {
    const playPing = createPingFunction(() => null)
    expect(() => playPing()).not.toThrow()
  })

  it('should not throw on oscillator error', () => {
    const mockCtx = {
      state: 'running' as const,
      currentTime: 0,
      createOscillator: () => { throw new Error('Not supported') },
      createGain: vi.fn(),
      resume: vi.fn(),
      destination: {},
    }

    const ctxRef: AudioContext | null = mockCtx as unknown as AudioContext
    const playPing = createPingFunction(() => ctxRef)

    expect(() => playPing()).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════
// 真实 Provider 集成：回到正在查看的会话时清除提醒
// （用户报告：ACP 会话中切走窗口，agent 完成后回来，甚至看完输出，
//  侧栏提醒仍永久挂着——只有点击侧栏会话行 / 发消息 / 响应审批才清除）
// ═══════════════════════════════════════════════════════════

/** jsdom 的 document.hidden 是 Document.prototype getter，实例上 defineProperty
 *  遮蔽之（与 ChatView.catchup.test.tsx / Terminal.testUtils 同手法）。 */
type DocumentVisibilityStub = { hidden?: unknown; visibilityState?: unknown }

function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  })
}

describe('AttentionProvider — return to the active session clears its alert', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let captured: ReturnType<typeof useRealAttention> | null = null

  // 经回调捕获（与文件上方 capture 同模式）：组件内直接对外部变量赋值会触发
  // react-compiler 的「Cannot reassign variables declared outside」。
  function captureValue(v: ReturnType<typeof useRealAttention>) {
    captured = v
  }

  function Capture({ onValue }: { onValue: (v: ReturnType<typeof useRealAttention>) => void }) {
    onValue(useRealAttention())
    return null
  }

  /** 「离开 → 回来」：真机由 visibilitychange 两段完成。 */
  const leaveAndReturn = () => {
    setDocumentHidden(true)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    setDocumentHidden(false)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
  }

  beforeEach(() => {
    captured = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root!.render(
        <AttentionProvider>
          <Capture onValue={captureValue} />
        </AttentionProvider>,
      )
    })
    act(() => {
      useAppStore.setState({
        activeSessionId: 's-current',
        isMobile: false,
        activeTab: 'terminal',
      })
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
    useAppStore.setState({ activeSessionId: null, isMobile: false, activeTab: 'terminal' })
    delete (document as DocumentVisibilityStub).hidden
    delete (document as DocumentVisibilityStub).visibilityState
  })

  it('clears the alert of the current session when the page becomes visible again', () => {
    act(() => {
      captured!.fire('s-current', 's-current', 'done')
    })
    expect(captured!.reasonFor('s-current')).toBe('done')

    leaveAndReturn()

    expect(captured!.reasonFor('s-current')).toBeUndefined()
  })

  it('clears on window focus too (page stayed visible, e.g. dual screen)', () => {
    act(() => {
      captured!.fire('s-current', 's-current', 'done')
    })

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    expect(captured!.reasonFor('s-current')).toBeUndefined()
  })

  it('keeps alerts of other sessions (user has not seen them)', () => {
    act(() => {
      captured!.fire('s-other', 's-other', 'error')
    })
    expect(captured!.reasonFor('s-other')).toBe('error')

    leaveAndReturn()

    expect(captured!.reasonFor('s-other')).toBe('error')
  })

  it('does not clear while the page is still hidden', () => {
    act(() => {
      captured!.fire('s-current', 's-current', 'done')
    })

    setDocumentHidden(true)
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(captured!.reasonFor('s-current')).toBe('done')
  })

  it('does not clear on mobile when another tab is shown (session view not visible)', () => {
    act(() => {
      useAppStore.setState({ isMobile: true, activeTab: 'sessions' })
    })
    act(() => {
      captured!.fire('s-current', 's-current', 'done')
    })

    leaveAndReturn()

    expect(captured!.reasonFor('s-current')).toBe('done')
  })
})
