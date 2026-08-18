import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { TouchEvent } from 'react'
import { useLongPress, findScrollContainer, SCROLL_COOLDOWN_MS } from './useLongPress'

type HookResult = ReturnType<typeof useLongPress>

// ── Helpers ──
// Rendered via a probe component (no @testing-library/react in deps),
// following the useDirBrowser.test.ts pattern.

function Probe(props: {
  onLongPress: (p: { x: number; y: number }, e: TouchEvent) => void
  onResult: (r: HookResult) => void
}) {
  props.onResult(useLongPress({ onLongPress: props.onLongPress }))
  return null
}

// jsdom has no TouchEvent constructor; shape an object close enough for the hook.
function touchEv(
  overrides: { touches?: Array<{ clientX: number; clientY: number }>; target?: EventTarget | null } = {},
) {
  return { touches: [{ clientX: 0, clientY: 0 }], target: null, ...overrides } as unknown as TouchEvent
}

// ── findScrollContainer ──

describe('findScrollContainer', () => {
  it('returns the nearest ancestor with scrollable overflow-y', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const mid = document.createElement('div')
    const target = document.createElement('div')
    scroller.appendChild(mid)
    mid.appendChild(target)
    document.body.appendChild(scroller)
    expect(findScrollContainer(target)).toBe(scroller)
    expect(findScrollContainer(mid)).toBe(scroller)
    expect(findScrollContainer(scroller)).toBe(scroller)
    scroller.remove()
  })

  it('returns null when no ancestor is scrollable', () => {
    const outer = document.createElement('div')
    const target = document.createElement('div')
    outer.appendChild(target)
    document.body.appendChild(outer)
    expect(findScrollContainer(target)).toBeNull()
    outer.remove()
  })

  it('returns null for non-element targets', () => {
    expect(findScrollContainer(null)).toBeNull()
    expect(findScrollContainer(document.createTextNode('x'))).toBeNull()
  })
})

// ── useLongPress behavior ──

describe('useLongPress', () => {
  let container: HTMLDivElement
  let root: Root
  let hook: HookResult
  let onLongPress: (p: { x: number; y: number }, e: TouchEvent) => void

  beforeEach(() => {
    vi.useFakeTimers()
    // 推进时钟让模块级 lastScrollAt 冷却过期（上一用例可能标记过滚动）
    vi.advanceTimersByTime(SCROLL_COOLDOWN_MS + 100)
    onLongPress = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root.render(
        createElement(Probe, {
          onLongPress,
          onResult: (r: HookResult) => {
            hook = r
          },
        }),
      )
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    document.body.removeChild(container)
    vi.useRealTimers()
  })

  it('fires onLongPress after holding still for longPressMs', () => {
    const target = document.createElement('div')
    container.appendChild(target)
    act(() => {
      hook.onTouchStart(touchEv({ touches: [{ clientX: 10, clientY: 20 }], target }))
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(onLongPress).toHaveBeenCalledTimes(1)
    expect(onLongPress).toHaveBeenCalledWith({ x: 10, y: 20 }, expect.objectContaining({ target }))
  })

  it('cancels when movement exceeds cancelPx', () => {
    act(() => {
      hook.onTouchStart(touchEv({ touches: [{ clientX: 0, clientY: 0 }] }))
    })
    act(() => {
      hook.onTouchMove(touchEv({ touches: [{ clientX: 0, clientY: 15 }] }))
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('cancels on touchEnd before the timer fires', () => {
    act(() => {
      hook.onTouchStart(touchEv({ touches: [{ clientX: 0, clientY: 0 }] }))
    })
    act(() => {
      hook.onTouchEnd()
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('cancels when the container scrolls even if movement stays below cancelPx (slow drag)', () => {
    const scroller = document.createElement('div')
    scroller.style.overflowY = 'auto'
    const target = document.createElement('div')
    scroller.appendChild(target)
    container.appendChild(scroller)
    act(() => {
      hook.onTouchStart(touchEv({ touches: [{ clientX: 10, clientY: 10 }], target }))
    })
    scroller.scrollTop = 30 // 内容已滚动，但触点位移只有 2px
    act(() => {
      hook.onTouchMove(touchEv({ touches: [{ clientX: 12, clientY: 12 }] }))
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('does not start the timer for a new touch inside the scroll cooldown window', () => {
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    act(() => {
      hook.onTouchStart(touchEv({ touches: [{ clientX: 0, clientY: 0 }] }))
    })
    act(() => {
      vi.advanceTimersByTime(600)
    })
    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('resumes normal long-press after the scroll cooldown elapses', () => {
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    act(() => {
      vi.advanceTimersByTime(SCROLL_COOLDOWN_MS + 1)
    })
    act(() => {
      hook.onTouchStart(touchEv({ touches: [{ clientX: 0, clientY: 0 }] }))
    })
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(onLongPress).toHaveBeenCalledTimes(1)
  })
})
