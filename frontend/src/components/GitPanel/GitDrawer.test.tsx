import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { GitHunk } from '../../api/client'
import { GitDrawer, type GitDrawerTarget } from './GitDrawer'

const gitHunks = vi.fn()
const gitDiff = vi.fn()
const gitShow = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../api/client', () => ({
  api: {
    gitHunks: (...args: unknown[]) => gitHunks(...args),
    gitDiff: (...args: unknown[]) => gitDiff(...args),
    gitShow: (...args: unknown[]) => gitShow(...args),
  },
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      uiZoom: 100,
      isMobile: false,
      fileManagerOpen: false,
      fileManagerCollapsed: false,
      fileManagerWidth: 360,
      setIsResizing: vi.fn(),
      fileManagerEl: null,
    }),
}))

const RAW = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  '',
].join('\n')

const HUNKS: GitHunk[] = [{ header: '@@ -1,3 +1,3 @@', patch: 'patch-1' }]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function renderDrawer(target: GitDrawerTarget, busy = false) {
  const runHunkAction = vi.fn(async () => true)
  act(() => {
    root.render(
      <GitDrawer
        target={target}
        bind={{ workspaceId: 'w1' }}
        onClose={vi.fn()}
        height={300}
        onHeightChange={vi.fn()}
        refreshTick={0}
        onOpenInEditor={vi.fn()}
        runHunkAction={runHunkAction}
        busy={busy}
      />,
    )
  })
  return { runHunkAction }
}

function buttonByTitle(title: string): HTMLButtonElement {
  const found = container.querySelector(`button[title="${title}"]`)
  if (!found) throw new Error(`${title} button not found`)
  return found as HTMLButtonElement
}

beforeEach(() => {
  gitHunks.mockReset().mockImplementation(async (_bind, params: { context_lines?: number }) => ({
    diff: RAW,
    truncated: false,
    hunks: HUNKS,
    context_lines: params.context_lines ?? 3,
    root: '/repo',
  }))
  gitDiff.mockReset().mockResolvedValue({ diff: RAW, truncated: false, root: '/repo' })
  gitShow.mockReset().mockResolvedValue({
    sha: 'abc', short_sha: 'abc', author: 'A', email: 'a@b', date: new Date().toISOString(),
    message: 'msg', diff: RAW, truncated: false,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('GitDrawer hunk flow', () => {
  it('loads hunks for tracked files and stages the selected hunk', async () => {
    const { runHunkAction } = renderDrawer({ kind: 'file', path: 'a.txt', staged: false, untracked: false })
    await act(async () => {})

    expect(gitHunks).toHaveBeenCalledWith(
      { workspaceId: 'w1' },
      { path: 'a.txt', staged: false, context_lines: 3 },
    )
    expect(gitDiff).not.toHaveBeenCalled()

    await act(async () => {
      buttonByTitle('git.stageHunk').click()
    })
    expect(runHunkAction).toHaveBeenCalledWith({
      path: 'a.txt',
      action: 'stage',
      patch: 'patch-1',
      context_lines: 3,
    })
  })

  it('expands the context and refetches with the new line count', async () => {
    renderDrawer({ kind: 'file', path: 'a.txt', staged: false, untracked: false })
    await act(async () => {})

    await act(async () => {
      buttonByTitle('git.expandContext').click()
    })
    expect(gitHunks).toHaveBeenLastCalledWith(
      { workspaceId: 'w1' },
      { path: 'a.txt', staged: false, context_lines: 10 },
    )
  })

  it('requires confirmation before reverting a hunk', async () => {
    const { runHunkAction } = renderDrawer({ kind: 'file', path: 'a.txt', staged: false, untracked: false })
    await act(async () => {})

    await act(async () => {
      buttonByTitle('git.revertHunk').click()
    })
    expect(runHunkAction).not.toHaveBeenCalled()

    const confirm = Array.from(document.body.querySelectorAll('button')).filter(
      (button) => button.textContent === 'git.revertHunk',
    )
    await act(async () => {
      confirm[confirm.length - 1].click()
    })
    expect(runHunkAction).toHaveBeenCalledWith({
      path: 'a.txt',
      action: 'revert',
      patch: 'patch-1',
      context_lines: 3,
    })
  })

  it('keeps untracked files on the raw diff endpoint without hunk buttons', async () => {
    renderDrawer({ kind: 'file', path: 'new.txt', staged: false, untracked: true })
    await act(async () => {})

    expect(gitDiff).toHaveBeenCalledWith(
      { workspaceId: 'w1' },
      { path: 'new.txt', staged: false, untracked: true },
    )
    expect(gitHunks).not.toHaveBeenCalled()
    expect(container.querySelectorAll('.git-row-btn')).toHaveLength(0)
  })

  it('shows commit diffs read-only', async () => {
    renderDrawer({ kind: 'commit', sha: 'abc' })
    await act(async () => {})

    expect(gitShow).toHaveBeenCalled()
    expect(gitHunks).not.toHaveBeenCalled()
    expect(container.querySelectorAll('.git-row-btn')).toHaveLength(0)
  })
})
