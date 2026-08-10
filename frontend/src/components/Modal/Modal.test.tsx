import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Modal } from './Modal'

// Contract test, not a rendering test: the body container must keep
// `overflow-wrap: anywhere`. Without it, no-space long tokens (file paths,
// branch names, URLs) don't wrap and paint outside the `max-w-*` frame — a long
// worktree path overflowed the dialog by ~320px. The property lives on Modal so
// every dialog inherits it; dropping it silently regresses all of them.

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

describe('Modal', () => {
  it('lets no-space long tokens wrap inside the body (overflow-wrap: anywhere)', () => {
    const longPath =
      '/home/pax/.local/share/opencode/worktree/c8650d1b9cd5031a525c656e034002014c5ad184/playful-nebula'
    act(() => {
      root.render(
        <Modal open onClose={() => {}} title="t">
          <p>{longPath}</p>
        </Modal>,
      )
    })

    const body = Array.from(document.body.querySelectorAll('div')).find((d) =>
      d.textContent?.includes(longPath) && d.className.includes('px-5'),
    )
    expect(body, 'modal body container should exist').toBeTruthy()
    expect(getComputedStyle(body!).overflowWrap).toBe('anywhere')
  })

  it('renders nothing when closed', () => {
    act(() => {
      root.render(
        <Modal open={false} onClose={() => {}} title="t">
          <p>hidden</p>
        </Modal>,
      )
    })
    expect(document.body.textContent).not.toContain('hidden')
  })
})
