import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { GitInProgress } from '../../api/client'
import { OperationBanner } from './OperationBanner'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent === label,
  )
  if (!found) throw new Error(`${label} button not found`)
  return found as HTMLButtonElement
}

function renderBanner(
  state: GitInProgress,
  opts: { busy?: boolean } = {},
): { onContinue: ReturnType<typeof vi.fn>; onAbort: ReturnType<typeof vi.fn> } {
  const onContinue = vi.fn()
  const onAbort = vi.fn()
  act(() => {
    root.render(
      <OperationBanner
        state={state}
        busy={opts.busy ?? false}
        onContinue={onContinue}
        onAbort={onAbort}
      />,
    )
  })
  return { onContinue, onAbort }
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

describe('OperationBanner', () => {
  it('shows the operation kind and the remaining conflict count', () => {
    renderBanner({ kind: 'merge', conflicted: 2 })
    expect(container.textContent).toContain('git.inProgress.merge')
    expect(container.textContent).toContain('git.inProgressConflicted')
  })

  it('renders am separately from rebase', () => {
    renderBanner({ kind: 'am', conflicted: 0 })
    expect(container.textContent).toContain('git.inProgress.am')
    expect(container.textContent).not.toContain('git.inProgress.rebase')
  })

  it('blocks CONTINUE while conflicts remain', async () => {
    const blocked = renderBanner({ kind: 'rebase', conflicted: 1 })
    expect(button('git.continueOp').disabled).toBe(true)
    await act(async () => {
      button('git.continueOp').click()
    })
    expect(blocked.onContinue).not.toHaveBeenCalled()
  })

  it('runs CONTINUE once the conflicts are resolved', async () => {
    const cleared = renderBanner({ kind: 'rebase', conflicted: 0 })
    expect(button('git.continueOp').disabled).toBe(false)
    await act(async () => {
      button('git.continueOp').click()
    })
    expect(cleared.onContinue).toHaveBeenCalledTimes(1)
  })

  it('disables both actions while a mutation is in flight', () => {
    renderBanner({ kind: 'cherry_pick', conflicted: 0 }, { busy: true })
    expect(button('git.continueOp').disabled).toBe(true)
    expect(button('git.abortOp').disabled).toBe(true)
  })

  it('requires confirmation before aborting', async () => {
    const { onAbort } = renderBanner({ kind: 'merge', conflicted: 0 })
    await act(async () => {
      button('git.abortOp').click()
    })
    expect(onAbort).not.toHaveBeenCalled()

    const confirmButtons = Array.from(document.body.querySelectorAll('button')).filter(
      (b) => b.textContent === 'git.abortOp',
    )
    expect(confirmButtons.length).toBeGreaterThan(1)
    await act(async () => {
      confirmButtons[confirmButtons.length - 1].click()
    })
    expect(onAbort).toHaveBeenCalledTimes(1)
  })
})
