import { describe, it, expect, vi } from 'vitest'
import { createTouchScroll, attachTouchScroll, TOUCH_SCROLL_FACTOR } from './touchScroll'

function ev(touches: Array<{ clientX: number; clientY: number }>) {
  return { touches, preventDefault: vi.fn() } as unknown as TouchEvent
}
const t = (x: number, y: number) => ({ clientX: x, clientY: y })

describe('createTouchScroll', () => {
  it('vertical drag upward emits positive deltaY scaled by factor', () => {
    const onScroll = vi.fn()
    const s = createTouchScroll(onScroll)
    s.onStart(ev([t(100, 200)]))
    s.onMove(ev([t(100, 180)])) // dy = -20, beyond slop → axis y
    s.onMove(ev([t(100, 170)])) // dy = -10 → deltaY = 10 * factor
    expect(onScroll).toHaveBeenLastCalledWith(10 * TOUCH_SCROLL_FACTOR)
  })

  it('horizontal drag is ignored (selection preserved) and does not preventDefault', () => {
    const onScroll = vi.fn()
    const s = createTouchScroll(onScroll)
    s.onStart(ev([t(100, 200)]))
    const moveEv = ev([t(60, 195)]) // dx dominant
    s.onMove(moveEv)
    expect(onScroll).not.toHaveBeenCalled()
    expect(moveEv.preventDefault).not.toHaveBeenCalled()
  })

  it('multi-touch is ignored', () => {
    const onScroll = vi.fn()
    const s = createTouchScroll(onScroll)
    s.onStart(ev([t(100, 200), t(120, 220)]))
    s.onMove(ev([t(100, 150), t(120, 170)]))
    expect(onScroll).not.toHaveBeenCalled()
  })

  it('axis resets on end; vertical scroll preventDefaults to suppress selection', () => {
    const onScroll = vi.fn()
    const s = createTouchScroll(onScroll)
    s.onStart(ev([t(100, 200)]))
    const moveEv = ev([t(100, 150)])
    s.onMove(moveEv)
    expect(moveEv.preventDefault).toHaveBeenCalled()
    s.onEnd()
    s.onStart(ev([t(100, 200)]))
    s.onMove(ev([t(50, 200)])) // now horizontal works again
    expect(onScroll).toHaveBeenCalledTimes(1)
  })
})

describe('attachTouchScroll', () => {
  function fireTouch(
    container: HTMLElement,
    type: string,
    touches: Array<{ clientX: number; clientY: number }>,
  ) {
    const ev = new Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'touches', { value: touches })
    container.dispatchEvent(ev)
  }

  function setup() {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const onScrollStart = vi.fn()
    const wheelEvents: WheelEvent[] = []
    container.addEventListener('wheel', (e: WheelEvent) => wheelEvents.push(e))
    const detach = attachTouchScroll(container, onScrollStart)
    return { container, onScrollStart, wheelEvents, detach }
  }

  it('fires onScrollStart once per gesture on the first real vertical scroll', () => {
    const { container, onScrollStart, wheelEvents, detach } = setup()
    fireTouch(container, 'touchstart', [t(100, 200)])
    fireTouch(container, 'touchmove', [t(100, 180)]) // axis y, delta 20
    fireTouch(container, 'touchmove', [t(100, 170)]) // delta 10
    expect(onScrollStart).toHaveBeenCalledTimes(1)
    expect(wheelEvents).toHaveLength(2)
    // A new gesture may scroll again — notification must fire again.
    fireTouch(container, 'touchstart', [t(100, 200)])
    fireTouch(container, 'touchmove', [t(100, 150)])
    expect(onScrollStart).toHaveBeenCalledTimes(2)
    detach()
  })

  it('does not fire onScrollStart or dispatch wheels for horizontal drags', () => {
    const { container, onScrollStart, wheelEvents, detach } = setup()
    fireTouch(container, 'touchstart', [t(100, 200)])
    fireTouch(container, 'touchmove', [t(60, 195)]) // dx dominant → selection
    expect(onScrollStart).not.toHaveBeenCalled()
    expect(wheelEvents).toHaveLength(0)
    detach()
  })

  it('stops notifying and dispatching after detach', () => {
    const { container, onScrollStart, wheelEvents, detach } = setup()
    detach()
    fireTouch(container, 'touchstart', [t(100, 200)])
    fireTouch(container, 'touchmove', [t(100, 150)])
    expect(onScrollStart).not.toHaveBeenCalled()
    expect(wheelEvents).toHaveLength(0)
  })
})
