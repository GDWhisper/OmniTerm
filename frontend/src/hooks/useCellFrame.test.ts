import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useCellFrame, type CellFrame } from './useCellFrame'

// Probe-component pattern (no @testing-library/react in deps),
// following useLongPress.test.ts.

type HookResult = ReturnType<typeof useCellFrame>

function Probe(props: {
  termRef: React.RefObject<FakeTerminal | null>
  requestResync?: () => void
  onResult: (r: HookResult) => void
}) {
  props.onResult(
    useCellFrame(
      props.termRef as React.RefObject<import('@xterm/xterm').Terminal | null>,
      props.requestResync,
    ),
  )
  return null
}

class FakeTerminal {
  writes: string[] = []
  write(data: string): void {
    this.writes.push(data)
  }
}

function fullFrame(marker: string): CellFrame {
  return {
    t: 'cell_frame',
    session_id: 's',
    width: 2,
    height: 1,
    full: true,
    overlay: false,
    rows: [{ cells: [
      { sgr: '', ch: marker },
      { sgr: '', ch: ' ' },
    ] }],
  }
}

// rAF stub: collect callbacks, flush manually.
let rafQueue: Array<() => void> = []
function flushRaf(): void {
  const q = rafQueue
  rafQueue = []
  q.forEach((cb) => cb())
}

describe('useCellFrame', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    rafQueue = []
  })

  function mount(termRef: { current: FakeTerminal | null }, requestResync?: () => void) {
    let hook: HookResult | null = null
    act(() => {
      root.render(
        createElement(Probe, {
          termRef,
          requestResync,
          onResult: (r) => { hook = r },
        }),
      )
    })
    return hook as unknown as HookResult
  }

  it('renders every queued frame in order within one rAF (no latest-wins drops)', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const hook = mount(termRef)

    // Two full frames enqueued before rAF fires — BOTH must render, in order.
    act(() => hook.enqueue(fullFrame('A')))
    act(() => hook.enqueue(fullFrame('B')))
    act(() => flushRaf())

    const joined = term.writes.join('|')
    const idxA = joined.indexOf('A')
    const idxB = joined.indexOf('B')
    expect(idxA).toBeGreaterThanOrEqual(0)
    expect(idxB).toBeGreaterThan(idxA)
  })

  it('on queue overflow clears backlog, drops the incoming frame and requests resync', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const resync = vi.fn()
    const hook = mount(termRef, resync)

    // Never flush rAF → queue grows to the cap; the next enqueue overflows.
    for (let i = 0; i < 121; i++) {
      act(() => hook.enqueue(fullFrame('X')))
    }
    expect(resync).toHaveBeenCalledTimes(1)

    // Overflow cleared the backlog: the rAF render sees nothing queued.
    act(() => flushRaf())
    expect(term.writes.join('')).not.toContain('X')
  })

  it('throttles resync requests to at most one per second', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const resync = vi.fn()
    const hook = mount(termRef, resync)

    let now = 1000
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now)

    for (let burst = 0; burst < 3; burst++) {
      for (let i = 0; i < 121; i++) {
        act(() => hook.enqueue(fullFrame('X')))
      }
      act(() => flushRaf())
      now += 100 // bursts 100ms apart — inside the throttle window
    }
    expect(resync).toHaveBeenCalledTimes(1)

    // Past the throttle window the next overflow resyncs again.
    now += 1000
    for (let i = 0; i < 121; i++) {
      act(() => hook.enqueue(fullFrame('X')))
    }
    expect(resync).toHaveBeenCalledTimes(2)
    nowSpy.mockRestore()
  })
})
