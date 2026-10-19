import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextMenu } from './ContextMenu'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function renderMenu(point: { x: number; y: number } | null, run = vi.fn(), onClose = vi.fn()) {
  act(() => {
    root.render(
      <ContextMenu
        point={point}
        onClose={onClose}
        items={[{ id: 'copy', label: 'Copy SHA', run }]}
      />,
    )
  })
  return { run, onClose }
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

describe('ContextMenu', () => {
  it('runs the action and closes on item click', () => {
    const { run, onClose } = renderMenu({ x: 40, y: 40 })
    const item = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent === 'Copy SHA',
    )
    expect(item).toBeTruthy()
    act(() => item!.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape', () => {
    const { onClose } = renderMenu({ x: 40, y: 40 })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('clamps the menu inside the viewport', () => {
    renderMenu({ x: window.innerWidth - 4, y: window.innerHeight - 4 })
    const menu = document.body.querySelector('.pixel-float') as HTMLElement
    expect(parseInt(menu.style.left, 10)).toBeLessThan(window.innerWidth - 160)
    expect(parseInt(menu.style.top, 10)).toBeLessThan(window.innerHeight - 44)
  })

  it('renders nothing when the anchor point is null', () => {
    renderMenu(null)
    expect(document.body.querySelector('.pixel-float')).toBeNull()
  })
})
