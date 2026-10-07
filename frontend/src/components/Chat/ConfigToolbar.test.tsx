import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigToolbar } from './ConfigToolbar'
import type { ConfigOption } from '../../stores/chatStore'
import { useAppStore } from '../../stores/appStore'
import i18n from '../../i18n'

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
  useAppStore.setState({ isMobile: false })
})

function render(opts?: {
  readOnly?: boolean
  options?: ConfigOption[]
  mobile?: boolean
}) {
  const onSetConfigOption = vi.fn()
  useAppStore.setState({ isMobile: opts?.mobile === true })
  act(() => {
    root.render(
      <ConfigToolbar
        configOptions={opts?.options ?? [MODEL_OPTION]}
        onSetConfigOption={onSetConfigOption}
        readOnly={opts?.readOnly}
      />,
    )
  })
  return { onSetConfigOption }
}

/** 按可见文案找按钮（移动端收纳按钮、面板行都用文案定位）。 */
function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((b) =>
    b.textContent?.includes(text),
  )
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

// ── 移动端收纳：配置项超过 3 个时只留 权限/模型/思考 在行内，其余进「高级」 ──
// ACP §12.3 的四个类别 + 未知类别：mode 与 thought_level 没有 model 那么长的
// 选项列表，用两个选项足够验证「当前值是行内展示的那一个」。

const MODE_OPTION: ConfigOption = {
  id: 'mode',
  name: 'Session Mode',
  category: 'mode',
  currentValue: 'ask',
  options: [
    { value: 'ask', name: 'Ask' },
    { value: 'code', name: 'Code' },
  ],
}

const THOUGHT_OPTION: ConfigOption = {
  id: 'thought_level',
  name: 'Thinking',
  category: 'thought_level',
  currentValue: 'high',
  options: [
    { value: 'low', name: 'Low' },
    { value: 'high', name: 'High' },
  ],
}

const CONFIG_OPTION: ConfigOption = {
  id: 'brave_mode',
  name: 'Brave Mode',
  category: 'model_config',
  currentValue: 'false',
  options: [
    { value: 'true', name: 'On' },
    { value: 'false', name: 'Off' },
  ],
}

const UNKNOWN_OPTION: ConfigOption = {
  id: 'something_else',
  name: 'Weird Knob',
  category: 'other',
  currentValue: 'a',
  options: [
    { value: 'a', name: 'A' },
    { value: 'b', name: 'B' },
  ],
}

/** 5 个配置项：主位 3 + 收纳 2（model_config + 未知类别）。 */
const OVERFLOW_OPTIONS: ConfigOption[] = [
  MODE_OPTION,
  MODEL_OPTION,
  THOUGHT_OPTION,
  CONFIG_OPTION,
  UNKNOWN_OPTION,
]

describe('ConfigToolbar mobile overflow', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('keeps mode/model/thinking inline and moves the rest behind Advanced', () => {
    render({ mobile: true, options: OVERFLOW_OPTIONS })

    // 主位三项照常展示，且为紧凑态（不带「Mode:」类别前缀）
    expect(findButton('Ask')).toBeTruthy()
    expect(findButton('model-0')).toBeTruthy()
    expect(findButton('High')).toBeTruthy()
    expect(findButton('Mode:')).toBeUndefined()

    // 收纳入口：按钮在（角标为收纳数量），面板未开
    const trigger = findButton('Advanced')
    expect(trigger, 'Advanced trigger').toBeTruthy()
    expect(trigger!.getAttribute('aria-label')).toContain('2')
    expect(findButton('Brave Mode')).toBeUndefined()
    expect(findButton('Weird Knob')).toBeUndefined()
  })

  it('opens the panel and applies a collapsed option', () => {
    const { onSetConfigOption } = render({ mobile: true, options: OVERFLOW_OPTIONS })

    act(() => {
      findButton('Advanced')!.click()
    })
    expect(container.textContent).toContain('Advanced options')

    const row = findButton('Brave Mode')
    expect(row, 'collapsed row').toBeTruthy()
    act(() => {
      row!.click()
    })

    act(() => {
      findButton('On')!.click()
    })
    expect(onSetConfigOption).toHaveBeenCalledWith('brave_mode', 'true')
  })

  it('hides the Advanced trigger when every option fits inline', () => {
    render({ mobile: true, options: [MODE_OPTION, MODEL_OPTION, THOUGHT_OPTION] })

    expect(findButton('Advanced')).toBeUndefined()
    expect(findButton('Ask')).toBeTruthy()
  })

  it('disables the Advanced trigger for a read-only snapshot', () => {
    render({ mobile: true, options: OVERFLOW_OPTIONS, readOnly: true })

    const trigger = findButton('Advanced')
    expect(trigger).toBeTruthy()
    expect(trigger!.disabled).toBe(true)
    act(() => {
      trigger!.click()
    })
    expect(container.textContent).not.toContain('Advanced options')
  })

  it('closes the panel on Escape', () => {
    render({ mobile: true, options: OVERFLOW_OPTIONS })

    act(() => {
      findButton('Advanced')!.click()
    })
    expect(container.textContent).toContain('Advanced options')

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.textContent).not.toContain('Advanced options')
  })

  it('closes the panel when the trigger is clicked again (no double-toggle)', () => {
    render({ mobile: true, options: OVERFLOW_OPTIONS })
    const trigger = () => findButton('Advanced')!

    act(() => {
      trigger().click()
    })
    expect(container.textContent).toContain('Advanced options')

    // 触发器与面板同属一个 ref 容器：mousedown 不算外部点击，第二次点击必须是
    // 纯 toggle（否则 mousedown 先关、click 又开，面板永远关不掉）。
    act(() => {
      trigger().click()
    })
    expect(container.textContent).not.toContain('Advanced options')
  })

  it('renders every selector inline on desktop (no Advanced trigger)', () => {
    render({ mobile: false, options: OVERFLOW_OPTIONS })

    expect(findButton('Advanced')).toBeUndefined()
    // 桌面端保留类别前缀（非紧凑态）
    expect(findButton('Mode:')).toBeTruthy()

    // 回归：桌面端不得收纳，收纳项必须原样行内渲染。曾按 showAdvanced = isMobile
    // 只渲染主位三项，导致模型参数/未知类别在 PC 端既不进行内也不进面板、
    // 直接消失（移动端「高级」里反而看得到）。
    const config = findButton('Config:')
    expect(config, 'model_config inline on desktop').toBeTruthy()
    expect(config!.textContent).toContain('Off') // brave_mode 当前值
    const weird = findButton('Weird Knob:')
    expect(weird, 'unknown category inline on desktop').toBeTruthy()
    expect(weird!.textContent).toContain('A') // something_else 当前值
    // 5 个配置项 = 5 个触发器，一个都不能少
    expect(container.querySelectorAll('button')).toHaveLength(5)
  })

  // jsdom 不做布局，单行保证只能靠样式契约守住：nowrap + 可收缩（min-width:0）。
  // 历史上正是漏了 min-width:0（弹性子项默认 auto、当前值 nowrap）导致 360px
  // 下四个控件换行成两行——这里把那条契约钉成断言。
  it('pins the single-row style contract (nowrap + shrinkable triggers)', () => {
    render({ mobile: true, options: OVERFLOW_OPTIONS })

    const row = container.firstElementChild as HTMLElement
    expect(row.style.flexWrap).toBe('nowrap')

    const trigger = findButton('Ask') as HTMLButtonElement
    expect(trigger.style.minWidth).toBe('0px')
    expect(trigger.style.width).toBe('100%')

    // 桌面端不钉单行（保持原有 wrap 行为）
    render({ mobile: false, options: OVERFLOW_OPTIONS })
    expect((container.firstElementChild as HTMLElement).style.flexWrap).toBe('wrap')
  })
})

// ── 同名选项的 description（模型消耗倍率）必须可见 ──────────────────────
// ACP 下发的同名模型仅靠 SessionConfigSelectOption.description 区分（实测
// "Hy3" x0.00 / "Hy3" x0.05 credits）。曾整体丢弃 → 下拉里两项完全一样。

/** 复刻实测数据：name 相同、倍率在 description。 */
const CREDITS_OPTION: ConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  currentValue: 'hy3-x',
  options: [
    { value: 'hy3', name: 'Hy3', description: 'x0.00 credits' },
    { value: 'hy3-x', name: 'Hy3', description: 'x0.05 credits' },
  ],
}

describe('ConfigToolbar option descriptions', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders each same-named option with its own description in the dropdown', () => {
    render({ options: [CREDITS_OPTION] })
    act(() => {
      findButton('Hy3')!.click()
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.find((b) => b.textContent?.includes('x0.00 credits'))).toBeTruthy()
    expect(buttons.find((b) => b.textContent?.includes('x0.05 credits'))).toBeTruthy()
  })

  it('shows the current option description on the trigger', () => {
    render({ options: [CREDITS_OPTION] })

    const trigger = findButton('Hy3')
    expect(trigger, 'trigger with current value').toBeTruthy()
    expect(trigger!.textContent).toContain('x0.05 credits')
  })

  it('renders descriptions in the mobile Advanced panel option list', () => {
    const config: ConfigOption = {
      ...CONFIG_OPTION,
      options: [
        { value: 'true', name: 'On', description: 'x2 credits' },
        { value: 'false', name: 'Off', description: 'x1 credit' },
      ],
    }
    render({ mobile: true, options: [MODE_OPTION, MODEL_OPTION, THOUGHT_OPTION, config] })

    act(() => {
      findButton('Advanced')!.click()
    })
    act(() => {
      findButton('Brave Mode')!.click()
    })

    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.find((b) => b.textContent?.includes('x2 credits'))).toBeTruthy()
    expect(buttons.find((b) => b.textContent?.includes('x1 credit'))).toBeTruthy()
  })
})
