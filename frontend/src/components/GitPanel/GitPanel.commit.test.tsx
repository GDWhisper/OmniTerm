import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { GitPanel } from './GitPanel'
import { useGitStore } from '../../stores/gitStore'

const { addToast, calls, gitCommit, gitPush } = vi.hoisted(() => {
  const calls: string[] = []
  return {
    calls,
    addToast: vi.fn(),
    gitCommit: vi.fn(async (...args: unknown[]) => {
      void args
      calls.push('commit')
      return { ok: true }
    }),
    gitPush: vi.fn(async (...args: unknown[]) => {
      void args
      calls.push('push')
      return { ok: true }
    }),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: (selector: (s: {
    activeSessionId: string | null
    activeWorkspaceId: string | null
    activeProjectId: string | null
    isMobile: boolean
  }) => unknown) =>
    selector({
      activeSessionId: 's1',
      activeWorkspaceId: null,
      activeProjectId: null,
      isMobile: false,
    }),
}))

vi.mock('../../stores/toastStore', () => ({
  useToastStore: (selector: (s: { addToast: typeof addToast }) => unknown) => selector({ addToast }),
}))

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    api: {
      gitStatus: vi.fn(async () => ({
        is_repo: true,
        repo_root: '/repo',
        branch: 'dev',
        detached: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        entries: [{ path: 'a.txt', index_status: 'M', worktree_status: '.', conflicted: false }],
      })),
      gitBranches: vi.fn(async () => ({ branches: [] })),
      gitCommit: (...args: unknown[]) => gitCommit(...args),
      gitPush: (...args: unknown[]) => gitPush(...args),
      gitLog: vi.fn(async () => ({ entries: [], has_more: false })),
    },
  }
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent === label,
  )
  if (!found) throw new Error(`${label} button not found`)
  return found as HTMLButtonElement
}

function setMessage(value: string) {
  const textarea = document.body.querySelector('textarea.git-commit-input') as HTMLTextAreaElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function renderPanel() {
  await act(async () => {
    root.render(<GitPanel visible />)
  })
  // Wait for the initial status fetch to settle.
  await act(async () => {})
}

beforeEach(() => {
  calls.length = 0
  addToast.mockClear()
  gitCommit.mockClear()
  gitPush.mockClear()
  useGitStore.getState().reset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('GitPanel commit actions', () => {
  it('commits and then pushes, reporting both successes', async () => {
    await renderPanel()
    setMessage('my message')
    await act(async () => {
      button('git.commitPushBtn').click()
    })

    expect(gitCommit).toHaveBeenCalledWith({ session: 's1' }, 'my message', false)
    expect(calls).toEqual(['commit', 'push'])
    expect(addToast).toHaveBeenCalledWith('success', 'git.committed')
    expect(addToast).toHaveBeenCalledWith('success', 'git.pushed')
  })

  it('amends without requiring a message', async () => {
    await renderPanel()
    const amend = document.body.querySelector('.git-commit-amend input') as HTMLInputElement
    act(() => amend.click())
    await act(async () => {
      button('git.commitBtn').click()
    })

    expect(gitCommit).toHaveBeenCalledWith({ session: 's1' }, '', true)
  })

  it('keeps the commit success when push fails', async () => {
    gitPush.mockRejectedValueOnce(new Error('push failed'))
    await renderPanel()
    setMessage('my message')
    await act(async () => {
      button('git.commitPushBtn').click()
    })

    expect(gitCommit).toHaveBeenCalledTimes(1)
    expect(addToast).toHaveBeenCalledWith('success', 'git.committed')
    expect(addToast).toHaveBeenCalledWith('error', 'push failed')
  })
})
