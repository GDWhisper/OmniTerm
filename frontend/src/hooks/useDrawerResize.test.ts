import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useDrawerResize } from './useDrawerResize'
import { clampDrawerHeight, DRAWER_MIN_HEIGHT, DRAWER_TOP_GAP } from '../utils/drawer'

type DragStartHandler = ReturnType<typeof useDrawerResize>

// Rendered via a probe component (no @testing-library/react in deps),
// following the useLongPress.test.ts pattern.
function Probe(props: { height: number; onHeightChange: (h: number) => void; onResult: (h: DragStartHandler) => void }) {
  props.onResult(useDrawerResize(props.height, props.onHeightChange))
  return null
}

// jsdom has no PointerEvent constructor; shape objects close enough for the hook.
function pointerDown(overrides: Partial<{ pointerId: number; clientY: number; pointerType: string; button: number }>) {
  return {
    pointerId: 1,
    clientY: 0,
    pointerType: 'touch',
    button: 0,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as React.PointerEvent
}

function windowPointerEvent(type: 'pointermove' | 'pointerup' | 'pointercancel', overrides: { pointerId?: number; clientY?: number }) {
  return Object.assign(new Event(type), { pointerId: 1, clientY: 0, ...overrides }) as unknown as PointerEvent
}

describe('clampDrawerHeight', () => {
  it('clamps into [DRAWER_MIN_HEIGHT, innerHeight - DRAWER_TOP_GAP]', () => {
    expect(clampDrawerHeight(1)).toBe(DRAWER_MIN_HEIGHT)
    expect(clampDrawerHeight(window.innerHeight)).toBe(window.innerHeight - DRAWER_TOP_GAP)
    expect(clampDrawerHeight(300)).toBe(300)
  })
})

describe('useDrawerResize', () => {
  let container: HTMLDivElement
  let root: Root
  let handleDragStart: DragStartHandler
  let onHeightChange: (h: number) => void

  const render = (height: number) => {
    act(() => {
      root.render(
        createElement(Probe, {
          height,
          onHeightChange,
          onResult: (h: DragStartHandler) => {
            handleDragStart = h
          },
        }),
      )
    })
  }

  beforeEach(() => {
    onHeightChange = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    document.body.removeChild(container)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  })

  it('tracks a touch pointer drag (up = taller)', () => {
    render(300)
    act(() => {
      handleDragStart(pointerDown({ pointerType: 'touch', clientY: 400 }))
    })
    expect(document.body.style.userSelect).toBe('none')
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointermove', { clientY: 300 }))
    })
    expect(onHeightChange).toHaveBeenLastCalledWith(400)
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointermove', { clientY: 250 }))
    })
    expect(onHeightChange).toHaveBeenLastCalledWith(450)
  })

  it('clamps to the min/max range while dragging', () => {
    render(300)
    act(() => {
      handleDragStart(pointerDown({ clientY: 400 }))
    })
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointermove', { clientY: -1000 }))
    })
    expect(onHeightChange).toHaveBeenLastCalledWith(window.innerHeight - DRAWER_TOP_GAP)
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointermove', { clientY: 2000 }))
    })
    expect(onHeightChange).toHaveBeenLastCalledWith(DRAWER_MIN_HEIGHT)
  })

  it('stops tracking after pointerup', () => {
    render(300)
    act(() => {
      handleDragStart(pointerDown({ clientY: 400 }))
    })
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointerup', { clientY: 350 }))
    })
    expect(document.body.style.userSelect).toBe('')
    expect(document.body.style.cursor).toBe('')
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointermove', { clientY: 100 }))
    })
    expect(onHeightChange).not.toHaveBeenCalled()
  })

  it('stops tracking on pointercancel (system gesture abort)', () => {
    render(300)
    act(() => {
      handleDragStart(pointerDown({ clientY: 400 }))
    })
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointercancel', {}))
    })
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointermove', { clientY: 100 }))
    })
    expect(onHeightChange).not.toHaveBeenCalled()
  })

  it('ignores moves from a different pointer (second finger does not take over)', () => {
    render(300)
    act(() => {
      handleDragStart(pointerDown({ pointerId: 1, clientY: 400 }))
    })
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointermove', { pointerId: 2, clientY: 100 }))
    })
    expect(onHeightChange).not.toHaveBeenCalled()
  })

  it('ignores non-primary mouse buttons', () => {
    render(300)
    act(() => {
      handleDragStart(pointerDown({ pointerType: 'mouse', button: 2, clientY: 400 }))
    })
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointermove', { clientY: 100 }))
    })
    expect(onHeightChange).not.toHaveBeenCalled()
  })
})
