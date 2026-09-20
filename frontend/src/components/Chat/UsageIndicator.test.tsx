import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { UsageIndicator } from './UsageIndicator'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(usage: Record<string, unknown> | null, compact = false) {
  act(() => {
    root.render(
      // 木底徽章样式由外层 .panel-title-bar 提供，测试只验证结构与行为。
      <div className="panel-title-bar">
        {usage && <UsageIndicator usage={usage} compact={compact} />}
      </div>,
    )
  })
}

function detail(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.title-bar-badge .pixel-float')
}

describe('UsageIndicator', () => {
  it('renders ring + percentage + cost', () => {
    render({ used: 50_000, size: 200_000, cost: { amount: 0.1234 } })

    expect(container.textContent).toContain('25%')
    expect(container.textContent).toContain('$0.1234')
    // 圆环是 SVG；明细（used / size）常驻 DOM 但默认透明
    expect(container.querySelector('svg')).toBeTruthy()
    expect(detail()!.style.opacity).toBe('0')
  })

  it('hides the cost in compact mode (mobile title bar width)', () => {
    render({ used: 50_000, size: 200_000, cost: { amount: 0.1234 } }, true)

    expect(container.textContent).toContain('25%')
    expect(container.textContent).not.toContain('$0.1234')
  })

  it('reveals the used/size detail on hover', () => {
    render({ used: 50_000, size: 200_000 })
    expect(detail()!.style.opacity).toBe('0')

    // React 的 onMouseEnter 由 mouseover 委派合成，须派发 bubbles 的 mouseover。
    act(() => {
      container
        .querySelector('.title-bar-badge')!
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(detail()!.style.opacity).toBe('1')
    expect(detail()!.textContent).toBe('50k / 200k')
  })

  it('renders nothing when there is neither usage nor cost', () => {
    render(null)
    expect(container.querySelector('.title-bar-badge')).toBeNull()

    render({})
    expect(container.querySelector('.title-bar-badge')).toBeNull()
  })

  it('keeps the cost-only case renderable (no percentage)', () => {
    render({ cost: { amount: 1 } })
    const badge = container.querySelector('.title-bar-badge')
    expect(badge).toBeTruthy()
    expect(container.textContent).toContain('$1.0000')
    expect(container.querySelector('svg')).toBeNull()
  })
})
