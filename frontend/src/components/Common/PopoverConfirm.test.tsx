import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { PopoverConfirm } from './PopoverConfirm'
import type { ConfirmCheckbox } from '../../hooks/useConfirmCheckbox'
import type { PopoverAnchor, PopoverAnchorRect } from '../../utils/popover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const rect: PopoverAnchorRect = { left: 900, top: 100, right: 920, bottom: 120 }
const anchor: PopoverAnchor = { rect, scrollRoot: window }

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(overrides: Partial<Parameters<typeof PopoverConfirm>[0]> = {}) {
  const props: Parameters<typeof PopoverConfirm>[0] = {
    open: true,
    anchor,
    title: 'Delete session',
    message: 'Are you sure?',
    confirmText: 'Delete',
    destructive: true,
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  act(() => {
    root.render(<PopoverConfirm {...props} />)
  })
  return props
}

function popover(): HTMLElement {
  const el = document.body.querySelector('.popover-confirm') as HTMLElement | null
  if (!el) throw new Error('popover not rendered')
  return el
}

function button(text: string): HTMLButtonElement {
  const el = Array.from(document.body.querySelectorAll('.popover-confirm button')).find(
    (b) => b.textContent === text,
  ) as HTMLButtonElement | undefined
  if (!el) throw new Error(`button not found: ${text}`)
  return el
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('PopoverConfirm', () => {
  it('renders an anchored alertdialog without a modal backdrop', () => {
    render()
    const el = popover()
    expect(el.getAttribute('role')).toBe('alertdialog')
    expect(el.textContent).toContain('Delete session')
    expect(el.textContent).toContain('Are you sure?')
    expect(document.body.querySelector('.animate-scale-in')).toBeNull()
  })

  it('prefers the space below the trigger and clamps horizontally to the viewport', () => {
    render({
      anchor: {
        rect: { left: 1180, top: 100, right: 1200, bottom: 120 },
        scrollRoot: window,
      },
    })
    const el = popover()
    // jsdom innerWidth = 1024, width = 320, margin = 8 → left max = 696
    expect(el.style.left).toBe('696px')
    // content height is 0 in jsdom → fits below
    expect(el.style.top).toBe('126px')
  })

  it('passes the checkbox state to onConfirm', () => {
    const checkbox: ConfirmCheckbox = { label: 'Also delete agent-side record' }
    const props = render({ checkbox })
    act(() => {
      const box = popover().querySelector('input[type="checkbox"]') as HTMLInputElement
      box.click()
    })
    act(() => button('Delete').click())
    expect(props.onConfirm).toHaveBeenCalledWith(true)
  })

  it('closes on Escape', () => {
    const props = render()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on outside pointer-down but stays open for clicks inside', () => {
    const props = render()
    act(() => {
      popover().querySelector('.popover-confirm-content')!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      )
    })
    expect(props.onClose).not.toHaveBeenCalled()

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the underlying page scrolls so the anchor cannot detach', () => {
    const props = render()
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores unrelated scrolls and only follows the trigger scroll container', () => {
    const scrollRoot = document.createElement('div')
    document.body.appendChild(scrollRoot)
    const props = render({ anchor: { rect, scrollRoot } })

    // 后台聊天/终端自动滚动不应关掉确认气泡
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(props.onClose).not.toHaveBeenCalled()

    // 触发按钮所在列表滚动时才关闭（锚点会随之移动）
    act(() => {
      scrollRoot.dispatchEvent(new Event('scroll'))
    })
    expect(props.onClose).toHaveBeenCalledTimes(1)
    scrollRoot.remove()
  })

  it('does not treat a press on the trigger itself as an outside click', () => {
    const props = render()
    act(() => {
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, clientX: 910, clientY: 110 }),
      )
    })
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('calls onClose from the cancel button', () => {
    const props = render()
    act(() => button('modal.cancel').click())
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})
