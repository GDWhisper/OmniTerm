import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DeleteWorktreeDialog, type DeleteWorktreeTarget } from './DeleteWorktreeDialog'

// `git worktree remove` keeps the branch ref, so the dialog owns the opt-in
// "also delete the branch" decision. These tests pin that contract: opt-in by
// default off, and no checkbox at all for a detached worktree.

const deleteWorktree = vi.fn(async () => ({ ok: true as const }))
const addToast = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../api/client', () => ({
  api: {
    deleteWorktree: (...args: unknown[]) =>
      (deleteWorktree as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
  },
}))

vi.mock('../../stores/toastStore', () => ({
  useToastStore: (selector: (s: { addToast: typeof addToast }) => unknown) => selector({ addToast }),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: (
    selector: (s: {
      worktrees: Record<string, unknown[]>
      activeWorkspaceId: string | null
      setActiveWorkspace: () => void
      setActiveSession: () => void
    }) => unknown,
  ) =>
    selector({
      worktrees: {},
      activeWorkspaceId: null,
      setActiveWorkspace: vi.fn(),
      setActiveSession: vi.fn(),
    }),
}))

const target: DeleteWorktreeTarget = {
  projectId: 'p1',
  path: '/repo/main-feature-xyz',
  label: 'feature-xyz',
  branch: 'feature-xyz',
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(t: DeleteWorktreeTarget | null) {
  act(() => {
    root.render(
      <DeleteWorktreeDialog target={t} onClose={vi.fn()} reloadWorktrees={vi.fn(async () => {})} />,
    )
  })
}

/** Checkboxes live in a portal on document.body, not in `container`. */
function checkboxes(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll('input[type="checkbox"]'))
}

function clickDelete() {
  const btn = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent === 'sidebar.delete',
  )
  if (!btn) throw new Error('delete button not found')
  act(() => {
    btn.click()
  })
}

function check(box: HTMLInputElement) {
  act(() => {
    box.click()
  })
}

beforeEach(() => {
  deleteWorktree.mockClear()
  addToast.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('DeleteWorktreeDialog', () => {
  it('does not delete the branch unless the user opts in', async () => {
    render(target)
    const boxes = checkboxes()
    expect(boxes).toHaveLength(2) // [0] also-delete-branch, [1] acknowledgement
    expect(boxes[0].checked).toBe(false)

    check(boxes[1]) // acknowledge only
    clickDelete()
    await act(async () => {})

    expect(deleteWorktree).toHaveBeenCalledWith('p1', '/repo/main-feature-xyz', {
      deleteBranch: false,
    })
  })

  it('deletes the branch when the user opts in', async () => {
    render(target)
    const boxes = checkboxes()
    check(boxes[0])
    check(boxes[1])
    clickDelete()
    await act(async () => {})

    expect(deleteWorktree).toHaveBeenCalledWith('p1', '/repo/main-feature-xyz', {
      deleteBranch: true,
    })
  })

  it('hides the branch checkbox for a detached worktree', () => {
    render({ ...target, branch: null })
    expect(checkboxes()).toHaveLength(1) // acknowledgement only
  })

  it('warns instead of claiming full success when branch deletion fails', async () => {
    deleteWorktree.mockImplementationOnce(
      async () => ({ ok: true as const, branch_error: 'branch is checked out elsewhere' }),
    )
    render(target)
    const boxes = checkboxes()
    check(boxes[0])
    check(boxes[1])
    clickDelete()
    await act(async () => {})

    expect(addToast).toHaveBeenCalledWith('warning', 'sidebar.worktreeDeletedBranchFailed')
  })
})
