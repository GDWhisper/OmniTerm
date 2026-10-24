import { describe, expect, it } from 'vitest'
import { autoScrollNearEdge } from './edgeAutoScroll'

/** 带可视矩形与浏览器式 scrollTop 夹紧的假滚动容器。 */
function fakeScroller(opts: {
  top?: number
  height?: number
  scrollTop?: number
  max?: number
} = {}) {
  const top = opts.top ?? 100
  const height = opts.height ?? 400
  const max = opts.max ?? 1000
  let current = opts.scrollTop ?? 0
  const el = document.createElement('div')
  el.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      left: 0,
      right: 300,
      width: 300,
      height,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => current,
    set: (v: number) => {
      current = Math.min(Math.max(0, v), max)
    },
  })
  return { el, top: () => current }
}

describe('autoScrollNearEdge', () => {
  it('指针在容器中部不滚动', () => {
    const { el, top } = fakeScroller()
    expect(autoScrollNearEdge(el, 300)).toBe(false)
    expect(top()).toBe(0)
  })

  it('指针进入下边缘带时向下滚动一帧步长', () => {
    const { el, top } = fakeScroller()
    expect(autoScrollNearEdge(el, 490)).toBe(true)
    expect(top()).toBe(8)
  })

  it('指针进入上边缘带时向上滚动一帧步长', () => {
    const { el, top } = fakeScroller({ scrollTop: 100 })
    expect(autoScrollNearEdge(el, 110)).toBe(true)
    expect(top()).toBe(92)
  })

  it('指针越出容器边缘仍按边缘带滚动（速度不随距离增加）', () => {
    const { el, top } = fakeScroller()
    expect(autoScrollNearEdge(el, 9000)).toBe(true)
    expect(top()).toBe(8)
  })

  it('已到滚动边界时返回 false（调用方据此跳过重算）', () => {
    const atTop = fakeScroller({ scrollTop: 0 })
    expect(autoScrollNearEdge(atTop.el, 100)).toBe(false)

    const atBottom = fakeScroller({ scrollTop: 1000, max: 1000 })
    expect(autoScrollNearEdge(atBottom.el, 500)).toBe(false)
  })

  it('支持自定义触发带与步长', () => {
    const { el, top } = fakeScroller({ height: 200 })
    expect(autoScrollNearEdge(el, 260, { edge: 100, step: 20 })).toBe(true)
    expect(top()).toBe(20)
  })

  it('容器无高度（无布局环境）时不动作', () => {
    const { el, top } = fakeScroller({ height: 0 })
    expect(autoScrollNearEdge(el, 100)).toBe(false)
    expect(top()).toBe(0)
  })
})
