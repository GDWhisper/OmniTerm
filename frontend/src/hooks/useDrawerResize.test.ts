import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useDrawerResize, useCornerResize } from './useDrawerResize'
import { clampDrawerHeight, DRAWER_MIN_HEIGHT, DRAWER_TOP_GAP } from '../utils/drawer'
import { clampFileManagerWidth, MIN_FILE_MANAGER_WIDTH } from '../utils/layout'

type DragStartHandler = ReturnType<typeof useDrawerResize>

// Rendered via a probe component (no @testing-library/react in deps),
// following the useLongPress.test.ts pattern.
function Probe(props: { height: number; onHeightChange: (h: number) => void; onResult: (h: DragStartHandler) => void }) {
  props.onResult(useDrawerResize(props.height, props.onHeightChange))
  return null
}

function CornerProbe(props: {
  width: number
  height: number
  onWidthChange: (w: number) => void
  onHeightChange: (h: number) => void
  onCommit: (w: number, h: number) => void
  onResult: (h: DragStartHandler) => void
}) {
  props.onResult(
    useCornerResize({
      width: props.width,
      height: props.height,
      onWidthChange: props.onWidthChange,
      onHeightChange: props.onHeightChange,
      onCommit: props.onCommit,
    }),
  )
  return null
}

// jsdom has no PointerEvent constructor; shape objects close enough for the hook.
function pointerDown(overrides: Partial<{ pointerId: number; clientX: number; clientY: number; pointerType: string; button: number }>) {
  return {
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    pointerType: 'touch',
    button: 0,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as React.PointerEvent
}

function windowPointerEvent(type: 'pointermove' | 'pointerup' | 'pointercancel', overrides: { pointerId?: number; clientX?: number; clientY?: number }) {
  return Object.assign(new Event(type), { pointerId: 1, clientX: 0, clientY: 0, ...overrides }) as unknown as PointerEvent
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

describe('useCornerResize', () => {
  let container: HTMLDivElement
  let root: Root
  let handleDragStart: DragStartHandler
  let onWidthChange: (w: number) => void
  let onHeightChange: (h: number) => void
  let onCommit: (w: number, h: number) => void

  const renderCorner = (width: number, height: number) => {
    act(() => {
      root.render(
        createElement(CornerProbe, {
          width,
          height,
          onWidthChange,
          onHeightChange,
          onCommit,
          onResult: (h: DragStartHandler) => {
            handleDragStart = h
          },
        }),
      )
    })
  }

  const drag = (to: { clientX: number; clientY: number }) =>
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointermove', to))
    })

  beforeEach(() => {
    onWidthChange = vi.fn<(w: number) => void>()
    onHeightChange = vi.fn<(h: number) => void>()
    onCommit = vi.fn<(w: number, h: number) => void>()
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

  it('dragging up-left widens the panel and raises the drawer', () => {
    renderCorner(300, 300)
    act(() => {
      handleDragStart(pointerDown({ clientX: 500, clientY: 400 }))
    })
    drag({ clientX: 450, clientY: 350 })
    expect(onWidthChange).toHaveBeenLastCalledWith(350) // left = wider
    expect(onHeightChange).toHaveBeenLastCalledWith(350) // up = taller
    drag({ clientX: 550, clientY: 450 })
    expect(onWidthChange).toHaveBeenLastCalledWith(250) // right = narrower
    expect(onHeightChange).toHaveBeenLastCalledWith(250) // down = shorter
  })

  it('clamps both dimensions independently into their own range', () => {
    renderCorner(300, 300)
    act(() => {
      handleDragStart(pointerDown({ clientX: 500, clientY: 400 }))
    })
    // 一路拖到左上：两个维度各自撞上界，互不受对方范围影响
    drag({ clientX: -5000, clientY: -5000 })
    expect(onWidthChange).toHaveBeenLastCalledWith(Math.floor(window.innerWidth / 2))
    expect(onHeightChange).toHaveBeenLastCalledWith(window.innerHeight - DRAWER_TOP_GAP)
    // 一路拖到右下：两个维度各自撞下界
    drag({ clientX: 5000, clientY: 5000 })
    expect(onWidthChange).toHaveBeenLastCalledWith(MIN_FILE_MANAGER_WIDTH)
    expect(onHeightChange).toHaveBeenLastCalledWith(DRAWER_MIN_HEIGHT)
  })

  it('commits the final size once on release instead of per move', () => {
    renderCorner(300, 300)
    act(() => {
      handleDragStart(pointerDown({ clientX: 500, clientY: 400 }))
    })
    drag({ clientX: 460, clientY: 360 })
    drag({ clientX: 440, clientY: 340 })
    expect(onCommit).not.toHaveBeenCalled()
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointerup', { clientX: 440, clientY: 340 }))
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onCommit).toHaveBeenCalledWith(360, 360)
  })

  it('does not commit when the pointer never moved', () => {
    renderCorner(300, 300)
    act(() => {
      handleDragStart(pointerDown({ clientX: 500, clientY: 400 }))
    })
    act(() => {
      window.dispatchEvent(windowPointerEvent('pointerup', {}))
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('uses the nwse-resize cursor and reports drag start', () => {
    renderCorner(300, 300)
    let started = false
    act(() => {
      started = handleDragStart(pointerDown({ clientX: 500, clientY: 400 }))
    })
    expect(started).toBe(true)
    expect(document.body.style.cursor).toBe('nwse-resize')
    // 已有指针在拖时第二指不接管
    let second = true
    act(() => {
      second = handleDragStart(pointerDown({ pointerId: 2, clientX: 100, clientY: 100 }))
    })
    expect(second).toBe(false)
  })

  it('shares the width bounds with the layout drag bar', () => {
    expect(clampFileManagerWidth(1)).toBe(MIN_FILE_MANAGER_WIDTH)
    expect(clampFileManagerWidth(window.innerWidth)).toBe(Math.floor(window.innerWidth / 2))
    expect(clampDrawerHeight(300)).toBe(300)
  })
})
