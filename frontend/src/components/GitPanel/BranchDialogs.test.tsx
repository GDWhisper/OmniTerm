import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { GitBranch } from '../../api/client'
import { BranchDeleteDialog, BranchRenameDialog } from './BranchDialogs'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: (selector: (s: { uiZoom: number }) => unknown) => selector({ uiZoom: 100 }),
}))

const branch: GitBranch = { name: 'feature', current: false, upstream: 'origin/feature' }

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent === label,
  )
  if (!found) throw new Error(`${label} button not found`)
  return found as HTMLButtonElement
}

function checkboxes(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll('input[type="checkbox"]'))
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

describe('BranchRenameDialog', () => {
  it('prefills the current name and submits a trimmed new name', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        <BranchRenameDialog target={branch} busy={false} onClose={vi.fn()} onConfirm={onConfirm} />,
      )
    })
    const input = document.body.querySelector('input.git-input') as HTMLInputElement
    expect(input.value).toBe('feature')

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '  renamed  ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      button('git.renameBranchAction').click()
    })
    expect(onConfirm).toHaveBeenCalledWith('renamed')
  })

  it('keeps confirm disabled when the name is unchanged', () => {
    act(() => {
      root.render(
        <BranchRenameDialog target={branch} busy={false} onClose={vi.fn()} onConfirm={vi.fn()} />,
      )
    })
    expect(button('git.renameBranchAction').disabled).toBe(true)
  })
})

describe('BranchDeleteDialog', () => {
  it('offers remote deletion only when the branch has an upstream', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        <BranchDeleteDialog
          target={branch}
          unmerged={false}
          busy={false}
          onClose={vi.fn()}
          onConfirm={onConfirm}
        />,
      )
    })
    const boxes = checkboxes()
    expect(boxes).toHaveLength(1)
    act(() => boxes[0].click())
    act(() => button('git.deleteBranchAction').click())
    expect(onConfirm).toHaveBeenCalledWith(false, true)
  })

  it('requires the force checkbox after an unmerged refusal', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(
        <BranchDeleteDialog
          target={{ name: 'feature', current: false }}
          unmerged
          busy={false}
          onClose={vi.fn()}
          onConfirm={onConfirm}
        />,
      )
    })
    expect(button('git.deleteBranchAction').disabled).toBe(true)
    const boxes = checkboxes()
    expect(boxes).toHaveLength(1)
    act(() => boxes[0].click())
    act(() => button('git.deleteBranchAction').click())
    expect(onConfirm).toHaveBeenCalledWith(true, false)
  })
})
