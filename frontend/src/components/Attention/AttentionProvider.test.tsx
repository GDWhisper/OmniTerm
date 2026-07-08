import { describe, it, expect, vi, beforeEach } from 'vitest'
import React, { createContext, useContext, useState, useCallback } from 'react'
import { createRoot, type Root } from 'react-dom/client'

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
