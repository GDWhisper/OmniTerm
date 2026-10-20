import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { GitHunk, GitHunkAction } from '../../api/client'
import { DiffView } from './DiffView'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const RAW = [
  'diff --git a/f.txt b/f.txt',
  'index 1111111..2222222 100644',
  '--- a/f.txt',
  '+++ b/f.txt',
  '@@ -1,3 +1,3 @@',
  ' a',
  '-b',
  '+B',
  ' c',
  '@@ -10,3 +10,3 @@',
  ' x',
  '-y',
  '+Y',
  ' z',
  '',
].join('\n')

const HUNKS: GitHunk[] = [
  { header: '@@ -1,3 +1,3 @@', patch: 'patch-1' },
  { header: '@@ -10,3 +10,3 @@', patch: 'patch-2' },
]

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function renderDiff(props: {
  hunks?: GitHunk[]
  hunkActions?: GitHunkAction[]
  onHunkAction?: (hunk: GitHunk, action: GitHunkAction) => void
  hunkBusy?: boolean
  truncated?: boolean
}) {
  act(() => {
    root.render(
      <DiffView
        raw={RAW}
        truncated={props.truncated ?? false}
        hunks={props.hunks}
        hunkActions={props.hunkActions}
        onHunkAction={props.onHunkAction}
        hunkBusy={props.hunkBusy}
      />,
    )
  })
}

function buttons(title: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll(`button[title="${title}"]`)) as HTMLButtonElement[]
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

describe('DiffView hunk actions', () => {
  it('offers stage and revert for unstaged hunks and sends the matching patch', () => {
    const onHunkAction = vi.fn()
    renderDiff({ hunks: HUNKS, hunkActions: ['stage', 'revert'], onHunkAction })

    const stage = buttons('git.stageHunk')
    expect(stage).toHaveLength(2)
    expect(buttons('git.revertHunk')).toHaveLength(2)
    expect(buttons('git.unstageHunk')).toHaveLength(0)

    act(() => stage[1].click())
    expect(onHunkAction).toHaveBeenCalledWith(HUNKS[1], 'stage')
  })

  it('offers only unstage for staged hunks', () => {
    renderDiff({ hunks: HUNKS, hunkActions: ['unstage'], onHunkAction: vi.fn() })

    expect(buttons('git.unstageHunk')).toHaveLength(2)
    expect(buttons('git.stageHunk')).toHaveLength(0)
    expect(buttons('git.revertHunk')).toHaveLength(0)
  })

  it('fails closed when a header does not match the backend patches', () => {
    renderDiff({
      hunks: [HUNKS[0], { header: '@@ -99,3 +99,3 @@', patch: 'other' }],
      hunkActions: ['stage', 'revert'],
      onHunkAction: vi.fn(),
    })

    expect(container.querySelectorAll('.git-row-btn')).toHaveLength(0)
  })

  it('fails closed when the patch count differs', () => {
    renderDiff({ hunks: [HUNKS[0]], hunkActions: ['stage'], onHunkAction: vi.fn() })
    expect(container.querySelectorAll('.git-row-btn')).toHaveLength(0)
  })

  it('disables actions while a mutation is in flight', () => {
    renderDiff({ hunks: HUNKS, hunkActions: ['stage'], onHunkAction: vi.fn(), hunkBusy: true })
    expect(buttons('git.stageHunk').every((button) => button.disabled)).toBe(true)
  })
})
