import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigToolbar } from './ConfigToolbar'
import type { ConfigOption } from '../../stores/chatStore'

// 回归测试：打开 model 下拉时搜索框不得自动聚焦（移动端会自动弹软键盘挡住
// 选项列表）。不聚焦后 Esc 必须由 document 层兜底关闭，否则键盘用户关不掉。

const MODEL_OPTION: ConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  currentValue: 'm0',
  options: Array.from({ length: 10 }, (_, i) => ({ name: `model-${i}`, value: `m${i}` })),
}

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

function render(opts?: { readOnly?: boolean }) {
  const onSetConfigOption = vi.fn()
  act(() => {
    root.render(
      <ConfigToolbar
        configOptions={[MODEL_OPTION]}
        usage={null}
        onSetConfigOption={onSetConfigOption}
        readOnly={opts?.readOnly}
      />,
    )
  })
  return { onSetConfigOption }
}

function searchInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('input[placeholder="Search..."]')
}

function openDropdown() {
  const trigger = Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes('model-0'),
  )
  expect(trigger, 'model trigger button').toBeTruthy()
  act(() => {
    trigger!.click()
  })
}

describe('ConfigToolbar dropdown', () => {
  it('does not focus the search input when opened', () => {
    render()
    openDropdown()

    const input = searchInput()
    expect(input, 'search input should render for >8 options').toBeTruthy()
    expect(document.activeElement).not.toBe(input)
  })

  it('still closes on Escape when the search input is not focused', () => {
    render()
    openDropdown()
    expect(searchInput()).toBeTruthy()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(searchInput()).toBeNull()
  })
})

// 已结束会话的配置快照：只读置灰（样式与活跃一致、整体 opacity 0.5），
// 下拉按钮 disabled，点击不触发 onSelect、不弹选项列表。
describe('ConfigToolbar readOnly', () => {
  it('disables dropdowns and does not open the option list on click', () => {
    const { onSetConfigOption } = render({ readOnly: true })

    const trigger = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('model-0'),
    )
    expect(trigger, 'model trigger button').toBeTruthy()
    expect(trigger!.disabled).toBe(true)

    act(() => {
      trigger!.click()
    })
    expect(onSetConfigOption).not.toHaveBeenCalled()
    // 未弹出选项列表（disabled 按钮不触发 open state）。
    expect(searchInput()).toBeNull()
    expect(container.querySelector('button')!.textContent).not.toContain('model-1')
  })

  it('stays interactive when readOnly is false', () => {
    render()
    const trigger = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('model-0'),
    )
    expect(trigger!.disabled).toBe(false)
  })
})
