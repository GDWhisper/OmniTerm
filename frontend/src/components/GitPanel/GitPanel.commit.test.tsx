import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { GitPanel } from './GitPanel'
import { useGitStore } from '../../stores/gitStore'

const {
  addToast, calls, gitCommit, gitPush, getAiCommitConfig, gitGenerateCommitMessage,
} = vi.hoisted(() => {
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
    getAiCommitConfig: vi.fn(),
    gitGenerateCommitMessage: vi.fn(),
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
    settingsOpen: boolean
    uiZoom: number
  }) => unknown) =>
    selector({
      activeSessionId: 's1',
      activeWorkspaceId: null,
      activeProjectId: null,
      isMobile: false,
      settingsOpen: false,
      uiZoom: 100,
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
      getAiCommitConfig: (...args: unknown[]) => getAiCommitConfig(...args),
      gitGenerateCommitMessage: (...args: unknown[]) => gitGenerateCommitMessage(...args),
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
  // Wait for the initial status + AI config fetches to settle.
  await act(async () => {})
  await act(async () => {})
}

function commitTextarea(): HTMLTextAreaElement {
  return document.body.querySelector('textarea.git-commit-input') as HTMLTextAreaElement
}

beforeEach(() => {
  calls.length = 0
  addToast.mockClear()
  gitCommit.mockClear()
  gitPush.mockClear()
  getAiCommitConfig.mockReset().mockResolvedValue({
    provider: 'openai',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    has_api_key: true,
  })
  gitGenerateCommitMessage.mockReset().mockResolvedValue({
    message: 'generated message',
    provider: 'openai',
    model: 'gpt-4o-mini',
    file_count: 1,
    omitted_files: 0,
    omitted_chars: 0,
  })
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

  it('fills an empty commit box directly from GENERATE', async () => {
    await renderPanel()
    await act(async () => {
      button('git.generate').click()
    })

    expect(gitGenerateCommitMessage).toHaveBeenCalledWith({ session: 's1' })
    expect(commitTextarea().value).toBe('generated message')
    expect(() => button('git.replace')).toThrow()
  })

  it('asks before overwriting existing text and appends when chosen', async () => {
    await renderPanel()
    setMessage('existing')
    await act(async () => {
      button('git.generate').click()
    })

    expect(() => button('git.replace')).not.toThrow()
    expect(commitTextarea().value).toBe('existing')
    await act(async () => {
      button('git.append').click()
    })
    expect(commitTextarea().value).toBe('existing\n\ngenerated message')
  })

  it('replaces existing text when chosen', async () => {
    await renderPanel()
    setMessage('existing')
    await act(async () => {
      button('git.generate').click()
    })
    await act(async () => {
      button('git.replace').click()
    })
    expect(commitTextarea().value).toBe('generated message')
  })

  it('warns when the provider only saw a truncated diff', async () => {
    gitGenerateCommitMessage.mockResolvedValue({
      message: 'generated message',
      provider: 'openai',
      model: 'gpt-4o-mini',
      file_count: 40,
      omitted_files: 10,
      omitted_chars: 500,
    })
    await renderPanel()
    await act(async () => {
      button('git.generate').click()
    })
    expect(addToast).toHaveBeenCalledWith('warning', 'git.generatedTruncated')
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
