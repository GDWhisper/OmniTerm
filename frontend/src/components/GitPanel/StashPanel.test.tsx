import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { StashPanel } from './StashPanel'

const gitStashList = vi.fn()
const gitStashPush = vi.fn()
const gitStashApply = vi.fn()
const gitStashPop = vi.fn()
const gitStashDrop = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../api/client', () => ({
  api: {
    gitStashList: (...args: unknown[]) => gitStashList(...args),
    gitStashPush: (...args: unknown[]) => gitStashPush(...args),
    gitStashApply: (...args: unknown[]) => gitStashApply(...args),
    gitStashPop: (...args: unknown[]) => gitStashPop(...args),
    gitStashDrop: (...args: unknown[]) => gitStashDrop(...args),
  },
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: (selector: (s: { uiZoom: number }) => unknown) => selector({ uiZoom: 100 }),
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

function renderPanel(overrides: { hasChanges?: boolean } = {}) {
  const onChanged = vi.fn()
  const runOp = vi.fn(async (op: () => Promise<unknown>) => {
    await op()
    return true
  })
  act(() => {
    root.render(
      <StashPanel
        open
        bind={{ workspaceId: 'w1' }}
        hasChanges={overrides.hasChanges ?? true}
        busy={false}
        onClose={vi.fn()}
        onChanged={onChanged}
        runOp={runOp}
      />,
    )
  })
  return { onChanged, runOp }
}

beforeEach(() => {
  gitStashList.mockReset().mockResolvedValue({
    stashes: [{ index: 0, date: 'now', message: 'WIP on dev' }],
  })
  gitStashPush.mockReset().mockResolvedValue({ ok: true })
  gitStashApply.mockReset().mockResolvedValue({ ok: true })
  gitStashPop.mockReset().mockResolvedValue({ ok: true })
  gitStashDrop.mockReset().mockResolvedValue({ ok: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('StashPanel', () => {
  it('lists stashes and applies the selected entry', async () => {
    const { onChanged } = renderPanel()
    await act(async () => {})

    expect(document.body.textContent).toContain('WIP on dev')
    await act(async () => {
      button('git.stashApply').click()
    })
    expect(gitStashApply).toHaveBeenCalledWith({ workspaceId: 'w1' }, 0)
    expect(onChanged).toHaveBeenCalled()
    expect(gitStashList).toHaveBeenCalledTimes(2)
  })

  it('shows the empty state and disables saving when the worktree is clean', async () => {
    gitStashList.mockResolvedValue({ stashes: [] })
    renderPanel({ hasChanges: false })
    await act(async () => {})

    expect(document.body.textContent).toContain('git.stashEmpty')
    expect(button('git.stashPushBtn').disabled).toBe(true)
  })

  it('requires confirmation before dropping a stash', async () => {
    renderPanel()
    await act(async () => {})
    await act(async () => {
      button('git.stashDrop').click()
    })
    expect(gitStashDrop).not.toHaveBeenCalled()

    // ConfirmDialog portals a second copy of the label; click the dialog action.
    const confirmButtons = Array.from(document.body.querySelectorAll('button')).filter(
      (b) => b.textContent === 'git.stashDrop',
    )
    await act(async () => {
      confirmButtons[confirmButtons.length - 1].click()
    })
    expect(gitStashDrop).toHaveBeenCalledWith({ workspaceId: 'w1' }, 0)
  })
})
