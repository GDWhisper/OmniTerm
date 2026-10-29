import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useOverflowDistance } from './useOverflowDistance'

/** 渐隐 + 轮播的共同底座：溢出宽度 = 内容宽 - 视口宽。
 *
 *  这条判据必须与 transform 无关（用 offsetWidth 而不是 scrollWidth）——
 *  滚动动画进行中 scrollWidth 量到的是被平移后的值，距离会自激振荡。 */
function Probe({
  viewportRef,
  contentRef,
  contentKey,
  onRender,
}: {
  viewportRef: React.RefObject<HTMLSpanElement | null>
  contentRef: React.RefObject<HTMLSpanElement | null>
  contentKey: string
  onRender?: () => void
}) {
  const distance = useOverflowDistance(viewportRef, contentRef, contentKey)
  onRender?.()
  return (
    <>
      <span ref={viewportRef} data-distance={distance} />
      <span ref={contentRef} />
    </>
  )
}

describe('useOverflowDistance', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let resizeCallback: ResizeObserverCallback | undefined
  let geometry: { viewportWidth: number; contentWidth: number }
  let viewportRef: React.RefObject<HTMLSpanElement | null>
  let contentRef: React.RefObject<HTMLSpanElement | null>

  beforeEach(() => {
    class SpyResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', SpyResizeObserver as unknown as typeof ResizeObserver)

    geometry = { viewportWidth: 100, contentWidth: 220 }
    viewportRef = { current: null }
    contentRef = { current: null }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  function render(contentKey = 'a', onRender?: () => void) {
    act(() => {
      root.render(
        <Probe
          viewportRef={viewportRef}
          contentRef={contentRef}
          contentKey={contentKey}
          onRender={onRender}
        />,
      )
    })
  }

  /** 桩好几何（jsdom 不做布局，offsetWidth/clientWidth 恒为 0）。 */
  function stubGeometry() {
    const viewport = viewportRef.current!
    const content = contentRef.current!
    Object.defineProperty(viewport, 'clientWidth', {
      configurable: true,
      get: () => geometry.viewportWidth,
    })
    Object.defineProperty(content, 'offsetWidth', {
      configurable: true,
      get: () => geometry.contentWidth,
    })
  }

  function measure() {
    act(() => {
      resizeCallback?.([], null as unknown as ResizeObserver)
    })
  }

  function distance(): number {
    return Number(container.querySelector('[data-distance]')!.getAttribute('data-distance'))
  }

  it('返回内容比视口多出的宽度', () => {
    render()
    stubGeometry()
    measure()
    expect(distance()).toBe(120)
  })

  it('内容放得下时返回 0（不该渐隐也不该滚动）', () => {
    render()
    stubGeometry()
    geometry.contentWidth = 80
    measure()
    expect(distance()).toBe(0)
  })

  it('内容标识变化后重新测量（换模型名要按新宽度重测）', () => {
    render('model-a')
    stubGeometry()
    measure()
    expect(distance()).toBe(120)

    geometry.contentWidth = 400
    render('model-b')
    expect(distance()).toBe(300)
  })

  it('±1px 抖动不触发重渲染（亚像素舍入、滚动条出现/消失）', () => {
    let renders = 0
    render('a', () => renders++)
    stubGeometry()
    measure()
    const afterFirst = renders
    expect(distance()).toBe(120)

    geometry.contentWidth = 221
    measure()
    expect(distance()).toBe(120)
    expect(renders).toBe(afterFirst)
  })
})
