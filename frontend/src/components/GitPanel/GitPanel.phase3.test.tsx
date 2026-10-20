import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { GitPanel } from './GitPanel'
import { useGitStore } from '../../stores/gitStore'

const mocks = vi.hoisted(() => ({
  addToast: vi.fn(),
  gitStatus: vi.fn(),
  gitBranches: vi.fn(),
  gitRangeFiles: vi.fn(),
  gitRangeDiff: vi.fn(),
  gitMerge: vi.fn(async () => ({ ok: true })),
  gitRebase: vi.fn(async () => ({ ok: true })),
  gitOperationContinue: vi.fn(async () => ({ ok: true })),
  gitOperationAbort: vi.fn(async () => ({ ok: true })),
  getAiCommitConfig: vi.fn(),
  gitLog: vi.fn(async () => ({ entries: [], has_more: false })),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      activeSessionId: 's1',
      activeWorkspaceId: null,
      activeProjectId: null,
      isMobile: false,
      settingsOpen: false,
      uiZoom: 100,
      fileManagerOpen: false,
      fileManagerCollapsed: false,
      fileManagerWidth: 360,
      setIsResizing: vi.fn(),
      fileManagerEl: null,
    }),
}))

vi.mock('../../stores/toastStore', () => ({
  useToastStore: (selector: (s: { addToast: typeof mocks.addToast }) => unknown) =>
    selector({ addToast: mocks.addToast }),
}))

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    api: {
      gitStatus: mocks.gitStatus,
      gitBranches: mocks.gitBranches,
      gitRangeFiles: mocks.gitRangeFiles,
      gitRangeDiff: mocks.gitRangeDiff,
      gitMerge: mocks.gitMerge,
      gitRebase: mocks.gitRebase,
      gitOperationContinue: mocks.gitOperationContinue,
      gitOperationAbort: mocks.gitOperationAbort,
      getAiCommitConfig: mocks.getAiCommitConfig,
      gitLog: mocks.gitLog,
    },
  }
})

const RAW_DIFF = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1 +1 @@',
  '-a',
  '+A',
  '',
].join('\n')

function status(overrides: Record<string, unknown> = {}) {
  return {
    is_repo: true,
    repo_root: '/repo',
    branch: 'dev',
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [{ path: 'tracked.txt', index_status: 'M', worktree_status: '.', conflicted: false }],
    in_progress: null,
    ...overrides,
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent === label,
  )
  if (!found) throw new Error(`${label} button not found`)
  return found as HTMLButtonElement
}

function rangeSelect(): HTMLSelectElement {
  const select = document.body.querySelector('select.git-range-select')
  if (!select) throw new Error('range select not found')
  return select as HTMLSelectElement
}

function setRangeBase(value: string) {
  const select = rangeSelect()
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setter.call(select, value)
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

async function renderPanel() {
  await act(async () => {
    root.render(<GitPanel visible />)
  })
  await flush()
  await flush()
}

async function openBranchMenu() {
  await act(async () => {
    ;(document.body.querySelector('.git-branch-btn') as HTMLElement).click()
  })
}

beforeEach(() => {
  mocks.addToast.mockReset()
  mocks.gitStatus.mockReset()
  mocks.gitBranches.mockReset()
  mocks.gitRangeFiles.mockReset()
  mocks.gitRangeDiff.mockReset()
  mocks.gitMerge.mockReset()
  mocks.gitRebase.mockReset()
  mocks.gitOperationContinue.mockReset()
  mocks.gitOperationAbort.mockReset()
  mocks.getAiCommitConfig.mockReset()
  mocks.gitLog.mockReset()

  mocks.gitStatus.mockResolvedValue(status())
  mocks.gitBranches.mockResolvedValue({
    branches: [
      { name: 'dev', current: true },
      { name: 'feature', current: false },
      { name: 'main', current: false },
    ],
  })
  mocks.gitRangeFiles.mockResolvedValue({
    merge_base: 'abc123',
    files: [
      { path: 'a.txt', status: 'M' },
      { path: 'b.txt', status: 'R', orig_path: 'old-b.txt' },
    ],
    files_truncated: false,
    diff: RAW_DIFF,
    truncated: false,
    root: '/repo',
  })
  mocks.gitRangeDiff.mockResolvedValue({ diff: RAW_DIFF, truncated: false, root: '/repo' })
  mocks.gitMerge.mockResolvedValue({ ok: true })
  mocks.gitRebase.mockResolvedValue({ ok: true })
  mocks.gitOperationContinue.mockResolvedValue({ ok: true })
  mocks.gitOperationAbort.mockResolvedValue({ ok: true })
  mocks.getAiCommitConfig.mockResolvedValue({
    provider: 'off',
    base_url: '',
    model: '',
    has_api_key: false,
    api_key_source: null,
    api_key_env: null,
    api_key_env_set: null,
  })
  mocks.gitLog.mockResolvedValue({ entries: [], has_more: false })

  useGitStore.getState().reset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('GitPanel branch comparison', () => {
  it('switches CHANGES to a read-only range list and opens the range drawer', async () => {
    await renderPanel()
    expect(Array.from(rangeSelect().options).map((o) => o.value)).toEqual([
      '', 'feature', 'main',
    ])

    await act(async () => {
      setRangeBase('feature')
    })
    await flush()

    expect(mocks.gitRangeFiles).toHaveBeenCalledWith({ session: 's1' }, 'feature')
    expect(document.body.textContent).toContain('git.rangeSection')
    expect(document.body.textContent).toContain('a.txt')
    expect(document.body.querySelectorAll('.git-file-actions')).toHaveLength(0)
    expect(document.body.querySelector('textarea.git-commit-input')).toBeNull()

    await act(async () => {
      ;(document.body.querySelector('.git-file-row') as HTMLElement).click()
    })
    await flush()
    expect(mocks.gitRangeDiff).toHaveBeenCalledWith({ session: 's1' }, 'feature', 'a.txt')
    expect(document.body.textContent).toContain('git.rangeLabel')
  })

  it('restores the normal changes view when the base is cleared', async () => {
    await renderPanel()
    await act(async () => {
      setRangeBase('feature')
    })
    await flush()
    await act(async () => {
      setRangeBase('')
    })
    await flush()

    expect(document.body.querySelector('textarea.git-commit-input')).not.toBeNull()
    expect(document.body.textContent).not.toContain('git.rangeSection')
  })

  it('notes a truncated file list', async () => {
    mocks.gitRangeFiles.mockResolvedValue({
      merge_base: 'abc123',
      files: [{ path: 'a.txt', status: 'M' }],
      files_truncated: true,
      diff: RAW_DIFF,
      truncated: false,
      root: '/repo',
    })
    await renderPanel()
    await act(async () => {
      setRangeBase('main')
    })
    await flush()
    expect(document.body.textContent).toContain('git.rangeFilesTruncated')
  })

  it('falls back to the normal view when the base no longer exists', async () => {
    mocks.gitRangeFiles.mockRejectedValue(new Error('base gone'))
    await renderPanel()
    await act(async () => {
      setRangeBase('feature')
    })
    await flush()

    expect(mocks.addToast).toHaveBeenCalledWith('error', 'base gone')
    expect(rangeSelect().value).toBe('')
    expect(document.body.querySelector('textarea.git-commit-input')).not.toBeNull()
  })
})

describe('GitPanel merge/rebase operations', () => {
  it('merges the selected branch into the current branch', async () => {
    await renderPanel()
    await openBranchMenu()
    const mergeButtons = document.body.querySelectorAll('button[title="git.mergeBranch"]')
    expect(mergeButtons).toHaveLength(2)
    await act(async () => {
      ;(mergeButtons[0] as HTMLElement).click()
    })
    await flush()

    expect(mocks.gitMerge).toHaveBeenCalledWith({ session: 's1' }, 'feature')
    expect(mocks.addToast).toHaveBeenCalledWith('success', 'git.merged')
  })

  it('requires confirmation before rebasing', async () => {
    await renderPanel()
    await openBranchMenu()
    await act(async () => {
      ;(document.body.querySelector('button[title="git.rebaseBranch"]') as HTMLElement).click()
    })
    expect(mocks.gitRebase).not.toHaveBeenCalled()

    await act(async () => {
      button('git.rebaseAction').click()
    })
    await flush()
    expect(mocks.gitRebase).toHaveBeenCalledWith({ session: 's1' }, 'feature')
  })
})

describe('GitPanel in-progress banner', () => {
  it('blocks branch operations and the base selector while paused', async () => {
    mocks.gitStatus.mockResolvedValue(
      status({ branch: null, detached: true, in_progress: { kind: 'rebase', conflicted: 1 } }),
    )
    await renderPanel()

    expect(document.body.textContent).toContain('git.inProgress.rebase')
    expect(button('git.continueOp').disabled).toBe(true)
    expect(rangeSelect().disabled).toBe(true)
  })

  it('aborts after confirmation and refreshes branches', async () => {
    mocks.gitStatus.mockResolvedValue(
      status({ in_progress: { kind: 'merge', conflicted: 1 } }),
    )
    await renderPanel()

    await act(async () => {
      button('git.abortOp').click()
    })
    const confirmButtons = Array.from(document.body.querySelectorAll('button')).filter(
      (b) => b.textContent === 'git.abortOp',
    )
    await act(async () => {
      confirmButtons[confirmButtons.length - 1].click()
    })
    await flush()

    expect(mocks.gitOperationAbort).toHaveBeenCalledWith({ session: 's1' })
    expect(mocks.addToast).toHaveBeenCalledWith('success', 'git.aborted')
    expect(mocks.gitBranches).toHaveBeenCalled()
  })

  it('continues once the conflicts are resolved', async () => {
    mocks.gitStatus.mockResolvedValue(
      status({ in_progress: { kind: 'cherry_pick', conflicted: 0 } }),
    )
    await renderPanel()

    expect(button('git.continueOp').disabled).toBe(false)
    await act(async () => {
      button('git.continueOp').click()
    })
    await flush()

    expect(mocks.gitOperationContinue).toHaveBeenCalledWith({ session: 's1' })
    expect(mocks.addToast).toHaveBeenCalledWith('success', 'git.continued')
  })
})
