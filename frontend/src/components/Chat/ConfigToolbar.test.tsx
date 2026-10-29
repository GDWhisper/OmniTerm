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

  // 行内宽度按「当前值文案视觉宽度」分配，不再等分：短值（Ask/High）只占自然宽，
  // 富余空间归长值（模型名）。basis 必须是 auto（自然宽）——固定 chrome（箭头、
  // 内边距）若参与等分，短值反而会被挤到截断。jsdom 不做布局，只钉 flex 契约。
  it('weights the leftover width by value length instead of splitting it evenly', () => {
    render({ mobile: true, options: [MODE_OPTION, MODEL_OPTION, THOUGHT_OPTION] })

    const wrapperOf = (text: string) => findButton(text)!.parentElement as HTMLElement
    // grow = 文案长度：'model-0' 7 / 'High' 4 / 'Ask' 3；shrink 只给最长值
    // （溢出时由它独吞，短值保持完整可读——短值收 1px 就会出省略号），其余为 0。
    expect(wrapperOf('model-0').style.flex).toBe('7 7 auto')
    expect(wrapperOf('High').style.flex).toBe('4 0 auto')
    expect(wrapperOf('Ask').style.flex).toBe('3 0 auto')
  })

  it('counts full-width CJK values as two columns when weighting', () => {
    const zhThought: ConfigOption = {
      ...THOUGHT_OPTION,
      options: [{ value: 'high', name: '高' }],
    }
    render({ mobile: true, options: [zhThought] })

    expect((findButton('高')!.parentElement as HTMLElement).style.flex).toBe('2 2 auto')
  })

  it('leaves desktop triggers at their natural width (no flex weighting)', () => {
    render({ mobile: false, options: [MODE_OPTION, MODEL_OPTION, THOUGHT_OPTION] })

    expect((findButton('Mode:')!.parentElement as HTMLElement).style.flex).toBe('')
  })
})

// ── 同名选项的 description（模型消耗倍率）：只在展开的选项列表可见 ──────
// ACP 下发的同名模型仅靠 SessionConfigSelectOption.description 区分（实测
// "Hy3" x0.00 / "Hy3" x0.05 credits）。常驻态（配置按钮 / 高级行头）不显示：
// 行内等分宽度下它永远最先被截断成残句，反而比不显示更糟。

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

  it('keeps the description off the resident trigger', () => {
    render({ options: [CREDITS_OPTION] })

    const trigger = findButton('Hy3')
    expect(trigger, 'trigger with current value').toBeTruthy()
    expect(trigger!.textContent).not.toContain('x0.05 credits')
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

    // 行头（「Brave Mode」那一行）自身不带倍率，倍率只在展开的选项行里。
    expect(findButton('Brave Mode')!.textContent).toContain('Off')
    expect(findButton('Brave Mode')!.textContent).not.toContain('x1 credit')
  })

  it('keeps the description off a desktop trigger', () => {
    render({ options: [CREDITS_OPTION] })

    const trigger = findButton('Model:')
    expect(trigger, 'desktop trigger with category prefix').toBeTruthy()
    expect(trigger!.textContent).toContain('Hy3')
    expect(trigger!.textContent).not.toContain('x0.05 credits')
  })
})

// ── 移动端当前值溢出：右缘渐隐 + 慢速往返轮播 ─────────────────────────
// 窄栏里模型名被硬截断（尾字直接消失，只剩半句）。改为「右缘渐隐 + 慢速往返
// 轮播」：渐隐吃掉硬边，轮播让完整名字有机会被读完。jsdom 不做布局，溢出
// 判据靠桩几何（内容宽 - 视口宽，与 SessionRow 同一实现）。

describe('ConfigToolbar mobile value marquee', () => {
  let resizeCallback: ResizeObserverCallback | undefined

  beforeEach(() => {
    class SpyResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        resizeCallback = cb
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', SpyResizeObserver as unknown as typeof ResizeObserver)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** 桩出「内容比视口宽 93px」的几何并触发一次测量。 */
  function stubOverflow() {
    const viewport = container.querySelector('.config-value') as HTMLElement
    const track = container.querySelector('.config-value-track') as HTMLElement
    Object.defineProperty(track, 'offsetWidth', { configurable: true, value: 234 })
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 141 })
    act(() => {
      resizeCallback?.([], null as unknown as ResizeObserver)
    })
    return viewport
  }

  it('挂渐隐 class 并写入轮播距离与时长（行程 = 溢出宽度 + 渐隐带）', () => {
    render({ mobile: true, options: [MODEL_OPTION] })

    const viewport = stubOverflow()

    expect(viewport.classList.contains('is-overflowing')).toBe(true)
    // 行程 = 溢出 93 + 渐隐带 16 = 109px：滚到尽头时尾字落在渐隐带内侧
    expect(viewport.style.getPropertyValue('--cfg-marquee-distance')).toBe('109px')
    expect(viewport.style.getPropertyValue('--cfg-fade-width')).toBe('16px')
    // 时长 = 行程 ÷ 速度 ÷ 单程占比 = 109 ÷ 20 ÷ 0.36 ≈ 15s
    expect(viewport.style.getPropertyValue('--cfg-marquee-duration')).toBe('15s')
  })

  it('内容放得下时不挂渐隐 class、也不写轮播变量', () => {
    render({ mobile: true, options: [MODEL_OPTION] })

    const viewport = container.querySelector('.config-value') as HTMLElement
    expect(viewport.classList.contains('is-overflowing')).toBe(false)
    expect(viewport.style.getPropertyValue('--cfg-marquee-distance')).toBe('')
    expect(viewport.style.getPropertyValue('--cfg-marquee-duration')).toBe('')
  })

  it('下拉展开时挂 is-open（暂停轮播，选项列表里已能看到完整名字）', () => {
    render({ mobile: true, options: [MODEL_OPTION] })

    act(() => {
      findButton('model-0')!.click()
    })

    const viewport = container.querySelector('.config-value') as HTMLElement
    expect(viewport.classList.contains('is-open')).toBe(true)
  })

  it('桌面端保持省略号截断（不引入轮播结构）', () => {
    render({ mobile: false, options: [MODEL_OPTION] })

    expect(container.querySelector('.config-value'), 'desktop uses no marquee markup').toBeNull()
    const trigger = findButton('Model:') as HTMLButtonElement
    const content = trigger.firstElementChild as HTMLElement
    // 内容块内第二个 span 是当前值（第一个是「Model:」前缀）
    const value = content.children[1] as HTMLElement
    expect(value.style.textOverflow).toBe('ellipsis')
  })
})

// ── 触发器内容居中 / 右截断契约 ────────────────────────────────────────
// 期望行为：空间充足（内容窄于按钮）时文字居中；不够时保持左对齐右截断。
// 实现是纯 CSS 表达（内层内容块 max-content + auto 外边距 + max-width 上限），
// jsdom 不做布局，只能把样式契约钉成断言；视觉验证见浏览器回归。

describe('ConfigToolbar centered trigger content', () => {
  it('pins the centered-content contract on the trigger', () => {
    render({ mobile: true, options: [MODE_OPTION, MODEL_OPTION, THOUGHT_OPTION] })

    const trigger = findButton('Ask') as HTMLButtonElement
    const content = trigger.firstElementChild as HTMLElement
    expect(content, 'inner content block').toBeTruthy()
    // 自然宽（有富余空间时 auto 外边距吸收并居中）
    expect(content.style.width).toBe('max-content')
    // 溢出上限（装不下时从左侧起排，内部 ellipsis 右截断）
    expect(content.style.maxWidth).toBe('100%')
    expect(content.style.minWidth).toBe('0px')
    // React 会把 `margin: 0 auto` 展开为左右 auto
    expect(content.style.marginLeft).toBe('auto')
    expect(content.style.marginRight).toBe('auto')

    // 桌面端（带 label 前缀）同样适用同一内容块契约
    render({ mobile: false, options: [MODE_OPTION, MODEL_OPTION, THOUGHT_OPTION] })
    const desktopTrigger = findButton('Mode:') as HTMLButtonElement
    expect((desktopTrigger.firstElementChild as HTMLElement).style.maxWidth).toBe('100%')
  })
})
