import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { Settings } from './Settings'
import { useAppStore } from '../../stores/appStore'
import { api } from '../../api/client'
import en from '../../locales/en/translation.json'
import zh from '../../locales/zh/translation.json'

function mountSettings(root: Root) {
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <Settings />
      </I18nextProvider>,
    )
  })
}

function clickSessionsTab(container: HTMLElement) {
  const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-tab')).find(
    (b) => (b.textContent || '').trim() === 'SESSIONS' || (b.textContent || '').trim() === '会话',
  )
  expect(tab).toBeTruthy()
  act(() => {
    tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function ranges(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="range"]'))
}

/** Set a controlled range input's value the way a drag would, then flush React.
 *  Must go through the native setter so React's value tracker sees the change. */
function setRangeValue(input: HTMLInputElement, value: number) {
  act(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    nativeSetter?.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const SLIDER_KEYS = [
  'settings.acpIdleRecycle',
  'settings.acpIdleRecycleHint',
  'settings.acpIdleRecycleWarning',
  'settings.tmuxBlurDisconnect',
  'settings.tmuxBlurDisconnectHint',
  'settings.tmuxIdleDisconnect',
  'settings.tmuxIdleDisconnectHint',
  'settings.tmuxDisconnectWarning',
  'settings.minutesUnit',
]

describe('Settings sessions disconnect sliders', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState({
      acpIdleRecycleMin: 5,
      blurDisconnectMin: 10,
      idleDisconnectMin: 15,
      permTimeoutMode: 'abort',
      permTimeoutSecs: 1800,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mountSettings(root)
    clickSessionsTab(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.removeChild(container)
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('renders four sliders in sessions with defaults 30min / 5 / 10 / 15', () => {
    // 顺序：权限请求超时（PermissionTimeoutSection 在前）→ ACP 空闲回收 → 失焦 → 空闲。
    // 权限超时走秒制档位（默认 1800s = 30 分钟）。
    const r = ranges(container)
    expect(r.length).toBe(4)
    expect(r.map((x) => x.value)).toEqual(['1800', '5', '10', '15'])
  })

  it('bounds the minute sliders to 1..60 with step 1', () => {
    // 权限超时滑块另有秒制档位（见下方 describe），此处只管三个分钟滑块。
    for (const input of ranges(container).slice(1)) {
      expect(input.min).toBe('1')
      expect(input.max).toBe('60')
      expect(input.step).toBe('1')
    }
  })

  it('calls setAcpIdleRecycle with the new value when the ACP slider moves', async () => {
    const spy = vi.spyOn(api, 'setAcpIdleRecycle').mockResolvedValue({ minutes: 30 })
    setRangeValue(ranges(container)[1], 30)
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(30)
    })
  })

  it('persists blur/idle sliders to localStorage via the store setters', () => {
    setRangeValue(ranges(container)[2], 20) // blur
    expect(localStorage.getItem('omniterm_blur_disconnect_min')).toBe('20')
    setRangeValue(ranges(container)[3], 25) // idle
    expect(localStorage.getItem('omniterm_idle_disconnect_min')).toBe('25')
  })

  it('shows no memory warning below 30 and shows it at 30', () => {
    const acpWarning = i18n.t('settings.acpIdleRecycleWarning')
    expect(container.textContent).not.toContain(acpWarning)

    act(() => {
      useAppStore.setState({ acpIdleRecycleMin: 45, blurDisconnectMin: 30 })
    })
    expect(container.textContent).toContain(acpWarning)
    expect(container.textContent).toContain(i18n.t('settings.tmuxDisconnectWarning'))
  })
})

describe('Settings disconnect slider i18n keys', () => {
  const enMap = en as Record<string, string>
  const zhMap = zh as Record<string, string>

  it('defines every slider key in both en and zh', () => {
    for (const k of SLIDER_KEYS) {
      expect(enMap[k]).toBeTruthy()
      expect(zhMap[k]).toBeTruthy()
    }
  })

  it('keeps en/zh warning copy aligned on memory/resource semantics', () => {
    const enWarn = `${enMap['settings.acpIdleRecycleWarning']} ${enMap['settings.tmuxDisconnectWarning']}`
    const zhWarn = `${zhMap['settings.acpIdleRecycleWarning']} ${zhMap['settings.tmuxDisconnectWarning']}`
    // 中英文案都必须明确「长时间/超时 → 内存/资源占用」
    expect(enWarn).toMatch(/timeout|long/i)
    expect(enWarn).toMatch(/memor/i)
    expect(zhWarn).toMatch(/超时|长时间/)
    expect(zhWarn).toMatch(/内存|资源/)
  })
})

const PERM_TIMEOUT_KEYS = [
  'settings.permTimeout',
  'settings.permTimeoutWait',
  'settings.permTimeoutWaitHint',
  'settings.permTimeoutAuto',
  'settings.permTimeoutAutoHint',
  'settings.permTimeoutAutoWarning',
  'settings.permTimeoutAbort',
  'settings.permTimeoutAbortHint',
  'settings.permTimeoutDuration',
  'settings.permTimeoutDurationHint',
  'settings.permTimeoutDurationWarning',
  'settings.permTimeoutAlways',
  'system.permTimeout.abort',
  'system.permTimeout.auto',
  'system.permTimeout.autoAlways',
  'system.permTimeout.durationMin',
  'system.permTimeout.durationSec',
  'system.permTimeout.requestTool',
  'system.permTimeout.contentOmitted',
  'system.permTimeout.options',
  'system.permTimeout.extra',
]

describe('Settings permission timeout', () => {
  let container: HTMLDivElement
  let root: Root

  /** 模式按钮按中英标签匹配（测试 i18n 语言随环境，两种都要命中）。 */
  const modeButton = (labels: string[]) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      labels.includes((b.textContent || '').trim()),
    )

  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState({ permTimeoutMode: 'abort', permTimeoutSecs: 1800 })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mountSettings(root)
    clickSessionsTab(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.removeChild(container)
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('offers the three modes with abort active by default', () => {
    // 只渲染当前语言的一套标签（i18n 语言随测试环境）。
    const labels = i18n.language.startsWith('zh')
      ? ['一直等待', '自动推进', '超时中止']
      : ['Wait', 'Auto-Advance', 'Abort']
    for (const label of labels) {
      expect(modeButton([label]), label).toBeTruthy()
    }
    expect(useAppStore.getState().permTimeoutMode).toBe('abort')
    // 默认 abort：滑块在场（wait 模式才隐藏）。
    expect(ranges(container).length).toBe(4)
  })

  it('switching mode persists via api.setPermissionTimeout and updates the store', async () => {
    const spy = vi.spyOn(api, 'setPermissionTimeout').mockResolvedValue({ mode: 'auto', seconds: 1800 })
    const btn = modeButton(['自动推进', 'Auto-Advance'])!
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useAppStore.getState().permTimeoutMode).toBe('auto')
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith('auto', 1800)
    })
    // 选中态按钮样式与未选中不同（active 用 --accent 边框）。
    expect(btn.style.borderColor).toBe('var(--accent)')
  })

  it('wait mode hides the timeout slider', () => {
    act(() => {
      useAppStore.setState({ permTimeoutMode: 'wait' })
    })
    // 只剩 ACP 空闲回收 / 失焦 / 空闲三条。
    expect(ranges(container).length).toBe(3)
  })

  it('auto mode shows the unattended-risk warning; other modes do not', () => {
    const warning = i18n.t('settings.permTimeoutAutoWarning')
    expect(container.textContent).not.toContain(warning)
    act(() => {
      useAppStore.setState({ permTimeoutMode: 'auto' })
    })
    expect(container.textContent).toContain(warning)
  })

  it('moving the slider persists mode and seconds together', async () => {
    const spy = vi.spyOn(api, 'setPermissionTimeout').mockResolvedValue({ mode: 'auto', seconds: 2700 })
    act(() => {
      useAppStore.setState({ permTimeoutMode: 'auto' })
    })
    setRangeValue(ranges(container)[0], 2700)
    expect(useAppStore.getState().permTimeoutSecs).toBe(2700)
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith('auto', 2700)
    })
  })

  it('warns only above the 30-minute default (default itself stays quiet)', () => {
    const warning = i18n.t('settings.permTimeoutDurationWarning')
    expect(container.textContent).not.toContain(warning)
    act(() => {
      useAppStore.setState({ permTimeoutSecs: 45 * 60 })
    })
    expect(container.textContent).toContain(warning)
  })

  // ── 「总是」/ 30 秒两个新增档位（2026-10-01）──

  it('offers the never notch only in auto mode, stepped by 30s', () => {
    const slider = ranges(container)[0]
    // abort：30s..1h（没有「总是」——该档只对自动放行有意义）
    expect(slider.min).toBe('30')
    expect(slider.max).toBe('3600')
    expect(slider.step).toBe('30')
    act(() => {
      useAppStore.setState({ permTimeoutMode: 'auto' })
    })
    // auto：最左档 0 =「总是」
    expect(ranges(container)[0].min).toBe('0')
  })

  it('labels the notches 总是 / 30 秒 / 30 分钟', () => {
    const always = i18n.t('settings.permTimeoutAlways')
    act(() => {
      useAppStore.setState({ permTimeoutMode: 'auto', permTimeoutSecs: 0 })
    })
    expect(container.textContent).toContain(always)
    act(() => {
      useAppStore.setState({ permTimeoutSecs: 30 })
    })
    expect(container.textContent).toContain(i18n.t('system.permTimeout.durationSec', { value: 30 }))
    act(() => {
      useAppStore.setState({ permTimeoutSecs: 1800 })
    })
    expect(container.textContent).toContain(i18n.t('system.permTimeout.durationMin', { value: 30 }))
  })

  it('persists the always notch as seconds=0 in auto mode', async () => {
    const spy = vi.spyOn(api, 'setPermissionTimeout').mockResolvedValue({ mode: 'auto', seconds: 0 })
    act(() => {
      useAppStore.setState({ permTimeoutMode: 'auto', permTimeoutSecs: 1800 })
    })
    setRangeValue(ranges(container)[0], 0)
    expect(useAppStore.getState().permTimeoutSecs).toBe(0)
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith('auto', 0)
    })
  })

  it('snaps the duration back to 30s when leaving auto mode with 总是 selected', () => {
    const spy = vi.spyOn(api, 'setPermissionTimeout').mockResolvedValue({ mode: 'abort', seconds: 30 })
    act(() => {
      useAppStore.setState({ permTimeoutMode: 'auto', permTimeoutSecs: 0 })
    })
    act(() => {
      modeButton(['超时中止', 'Abort'])!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // abort 下滑块下限是 30s：面板不能停在一个拖不到、语义也无效的值上。
    expect(useAppStore.getState().permTimeoutSecs).toBe(30)
    expect(spy).toHaveBeenCalledWith('abort', 30)
  })

  it('keeps the duration across a wait round-trip (wait hides the slider)', () => {
    vi.spyOn(api, 'setPermissionTimeout').mockResolvedValue({ mode: 'wait', seconds: 30 })
    act(() => {
      useAppStore.setState({ permTimeoutMode: 'auto', permTimeoutSecs: 30 })
    })
    act(() => {
      modeButton(['一直等待', 'Wait'])!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useAppStore.getState().permTimeoutSecs).toBe(30)
    expect(ranges(container).length).toBe(3)
    act(() => {
      modeButton(['自动推进', 'Auto-Advance'])!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useAppStore.getState().permTimeoutSecs).toBe(30)
  })

  it('defines every permission-timeout key in both en and zh', () => {
    const enMap = en as Record<string, string>
    const zhMap = zh as Record<string, string>
    for (const k of PERM_TIMEOUT_KEYS) {
      expect(enMap[k], k).toBeTruthy()
      expect(zhMap[k], k).toBeTruthy()
    }
    // 三条 system 文案必须带插值变量，否则前端渲染出光板句子。
    expect(enMap['system.permTimeout.abort']).toContain('{{duration}}')
    expect(zhMap['system.permTimeout.auto']).toContain('{{selected}}')
    expect(zhMap['system.permTimeout.autoAlways']).toContain('{{selected}}')
    // 时长单位文案由 permTimeoutDuration() 选取，两种单位都要有词条。
    for (const k of ['system.permTimeout.durationMin', 'system.permTimeout.durationSec']) {
      expect(enMap[k]).toContain('{{value}}')
      expect(zhMap[k]).toContain('{{value}}')
    }
  })
})

describe('Settings default terminal engine', () => {
  let container: HTMLDivElement
  let root: Root

  const clickTerminalTab = () => {
    const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('.settings-tab')).find(
      (b) => (b.textContent || '').trim() === 'TERMINAL' || (b.textContent || '').trim() === '终端',
    )
    expect(tab).toBeTruthy()
    act(() => {
      tab!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  const engineButton = (engine: 'pty' | 'tmux') =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      (b.textContent || '').trim().startsWith(engine),
    )

  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState({ defaultTerminalEngine: 'tmux', multiplexerAvailable: true, multiplexer: 'tmux' })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mountSettings(root)
    clickTerminalTab()
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.removeChild(container)
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('offers both engines with tmux first (pty is still beta)', () => {
    const labels = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .map((b) => (b.textContent || '').trim())
      .filter((x) => x === 'tmux' || x.startsWith('pty'))
    expect(labels[0]).toBe('tmux')
    expect(labels[1].startsWith('pty')).toBe(true)
    expect(container.textContent).toContain('BETA')
  })

  it('persists the picked engine to localStorage via the store setter', () => {
    act(() => engineButton('pty')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(useAppStore.getState().defaultTerminalEngine).toBe('pty')
    expect(localStorage.getItem('omniterm_default_terminal_engine')).toBe('pty')
  })

  it('disables the tmux option and explains why when the host has no multiplexer', () => {
    act(() => {
      useAppStore.setState({ multiplexerAvailable: false })
    })
    expect(engineButton('tmux')!.disabled).toBe(true)
    expect(container.textContent).toContain(i18n.t('sidebar.muxUnavailable', { mux: 'tmux' }))
  })

  it('defines the engine keys in both en and zh', () => {
    const enMap = en as Record<string, string>
    const zhMap = zh as Record<string, string>
    for (const k of ['settings.defaultEngine', 'settings.defaultEngineHint']) {
      expect(enMap[k]).toBeTruthy()
      expect(zhMap[k]).toBeTruthy()
    }
    // 两处都要点明 pty 还在 beta，否则设置项看不出为何默认 tmux
    expect(enMap['settings.defaultEngineHint']).toMatch(/beta/i)
    expect(zhMap['settings.defaultEngineHint']).toContain('beta')
  })
})

describe('Settings thinking effect (ACP waiting indicator)', () => {
  let container: HTMLDivElement
  let root: Root

  const EFFECT_IDS = ['scramble', 'spinner', 'braille'] as const
  const EFFECT_LABELS: Record<(typeof EFFECT_IDS)[number], string[]> = {
    scramble: ['乱码流', 'Scramble'],
    spinner: ['经典转圈', 'Spinner'],
    braille: ['盲文点阵', 'Braille'],
  }

  /** 按总开关标题（中英随测试环境）定位 ThinkingEffectSection 的开关行。 */
  const thinkingSection = () =>
    Array.from(container.querySelectorAll('section')).find((s) =>
      (s.querySelector('h3')?.textContent || '').includes(i18n.t('settings.thinkingEffect.master')),
    )

  const masterButton = () => thinkingSection()!.querySelector<HTMLButtonElement>('button')!

  const effectButton = (id: (typeof EFFECT_IDS)[number]) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      EFFECT_LABELS[id].includes((b.textContent || '').trim()),
    )

  const click = (el: Element) =>
    act(() => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState({ thinkingEffectEnabled: true, thinkingEffectId: 'scramble' })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // appearance 是默认 tab，本 section 无需点击切换即可见。
    mountSettings(root)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.removeChild(container)
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('renders the master switch and all three effects with scramble active by default', () => {
    expect(thinkingSection()).toBeTruthy()
    for (const id of EFFECT_IDS) {
      expect(effectButton(id), id).toBeTruthy()
    }
    expect(effectButton('scramble')!.style.borderColor).toBe('var(--accent)')
    expect(effectButton('spinner')!.style.borderColor).not.toBe('var(--accent)')
  })

  it('persists the picked effect to the store and localStorage', () => {
    click(effectButton('braille')!)
    expect(useAppStore.getState().thinkingEffectId).toBe('braille')
    expect(localStorage.getItem('omniterm_thinking_effect')).toBe('braille')
    expect(effectButton('braille')!.style.borderColor).toBe('var(--accent)')
  })

  it('turning the master switch off persists, disables and dims the effect row', () => {
    click(masterButton())
    expect(useAppStore.getState().thinkingEffectEnabled).toBe(false)
    expect(localStorage.getItem('omniterm_thinking_effect_enabled')).toBe('false')
    // pointer-events: none 挡不住 jsdom 的 dispatchEvent——可测性与 a11y 依赖 disabled 属性。
    for (const id of EFFECT_IDS) {
      expect(effectButton(id)!.disabled, id).toBe(true)
    }
    const dim = effectButton('braille')!.closest<HTMLElement>('[style*="opacity"]')!
    expect(dim.style.opacity).toBe('0.45')
  })

  it('defines every thinking-effect i18n key in both en and zh', () => {
    const enMap = en as Record<string, string>
    const zhMap = zh as Record<string, string>
    for (const k of [
      'settings.thinkingEffect.master',
      'settings.thinkingEffect.masterHint',
      'settings.thinkingEffect.style',
      'settings.thinkingEffect.scramble',
      'settings.thinkingEffect.spinner',
      'settings.thinkingEffect.braille',
    ]) {
      expect(enMap[k], k).toBeTruthy()
      expect(zhMap[k], k).toBeTruthy()
    }
  })
})

describe('Settings session display (expand thinking + collapsed mode)', () => {
  let container: HTMLDivElement
  let root: Root

  const HIDE_LABELS = ['完全隐藏', 'Hide Completely']
  const BRIEF_LABELS = ['显示简要', 'Show Brief']

  /** 按小节标题（中英随测试环境）定位「收起时显示」档位行。 */
  const collapsedSection = () =>
    Array.from(container.querySelectorAll('section')).find((s) =>
      (s.querySelector('h3')?.textContent || '').includes(i18n.t('settings.thinkingCollapsed')),
    )

  const modeButton = (labels: string[]) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      labels.includes((b.textContent || '').trim()),
    )

  const click = (el: Element | null | undefined) =>
    act(() => {
      el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

  /** 「展开思考」开关行（ToggleRow 的第一个 button）。 */
  const expandThinkingButton = () => {
    const row = Array.from(container.querySelectorAll('section')).find((s) =>
      (s.querySelector('h3')?.textContent || '').includes(i18n.t('settings.expandThinking')),
    )
    return row?.querySelector<HTMLButtonElement>('button') ?? null
  }

  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'hide' })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mountSettings(root)
    clickSessionsTab(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.removeChild(container)
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('shows the collapsed-mode row with 完全隐藏 active by default when 展开思考 is off', () => {
    expect(collapsedSection()).toBeTruthy()
    expect(modeButton(HIDE_LABELS)).toBeTruthy()
    expect(modeButton(BRIEF_LABELS)).toBeTruthy()
    // 默认档位 = 完全隐藏（与加此设置前的行为一致）
    expect(modeButton(HIDE_LABELS)!.style.borderColor).toBe('var(--accent)')
    expect(modeButton(BRIEF_LABELS)!.style.borderColor).not.toBe('var(--accent)')
  })

  it('persists the picked mode to the store and localStorage', () => {
    click(modeButton(BRIEF_LABELS))
    expect(useAppStore.getState().thinkingCollapsedMode).toBe('brief')
    expect(localStorage.getItem('omniterm_thinking_collapsed')).toBe('brief')
    expect(modeButton(BRIEF_LABELS)!.style.borderColor).toBe('var(--accent)')
    // 档位互斥：另一个按钮回到非选中态
    expect(modeButton(HIDE_LABELS)!.style.borderColor).not.toBe('var(--accent)')
  })

  it('round-trips 完全隐藏 back from 显示简要', () => {
    click(modeButton(BRIEF_LABELS))
    click(modeButton(HIDE_LABELS))
    expect(useAppStore.getState().thinkingCollapsedMode).toBe('hide')
    expect(localStorage.getItem('omniterm_thinking_collapsed')).toBe('hide')
    expect(modeButton(HIDE_LABELS)!.style.borderColor).toBe('var(--accent)')
  })

  it('hides the collapsed-mode row entirely when 展开思考 is on', () => {
    // 开时思考块恒展开，档位改了看不到效果——不渲染，避免空转开关。
    expect(collapsedSection()).toBeTruthy()
    click(expandThinkingButton())
    expect(useAppStore.getState().expandThinking).toBe(true)
    // find 未命中返回 undefined（不是 null）——行确实不再渲染
    expect(collapsedSection()).toBeFalsy()
    expect(modeButton(HIDE_LABELS)).toBeFalsy()
    expect(modeButton(BRIEF_LABELS)).toBeFalsy()
  })

  it('brings the row back (with the stored mode still active) after turning 展开思考 off again', () => {
    click(modeButton(BRIEF_LABELS))
    click(expandThinkingButton()) // on
    click(expandThinkingButton()) // off again
    expect(collapsedSection()).toBeTruthy()
    // 档位是独立设置，不随展开开关复位
    expect(useAppStore.getState().thinkingCollapsedMode).toBe('brief')
    expect(modeButton(BRIEF_LABELS)!.style.borderColor).toBe('var(--accent)')
  })

  it('defines every collapsed-mode i18n key in both en and zh', () => {
    const enMap = en as Record<string, string>
    const zhMap = zh as Record<string, string>
    for (const k of [
      'settings.thinkingCollapsed',
      'settings.thinkingCollapsedHint',
      'settings.thinkingCollapsedHide',
      'settings.thinkingCollapsedBrief',
    ]) {
      expect(enMap[k], k).toBeTruthy()
      expect(zhMap[k], k).toBeTruthy()
    }
  })
})

describe('Settings session display (auto-collapse thought on finish)', () => {
  let container: HTMLDivElement
  let root: Root

  /** 「思考完成后自动折叠」开关行（ToggleRow 的第一个 button）。 */
  const autoCollapseButton = () => {
    const row = Array.from(container.querySelectorAll('section')).find((s) =>
      (s.querySelector('h3')?.textContent || '').includes(i18n.t('settings.thinkingAutoCollapse')),
    )
    return row?.querySelector<HTMLButtonElement>('button') ?? null
  }

  /** 「展开思考」开关行（ToggleRow 的第一个 button）。 */
  const expandThinkingButton = () => {
    const row = Array.from(container.querySelectorAll('section')).find((s) =>
      (s.querySelector('h3')?.textContent || '').includes(i18n.t('settings.expandThinking')),
    )
    return row?.querySelector<HTMLButtonElement>('button') ?? null
  }

  const click = (el: Element | null | undefined) =>
    act(() => {
      el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

  beforeEach(() => {
    localStorage.clear()
    // 显式给默认值：开关默认**开**（用户 2026-10-14 选定），不依赖 store 模块级初值。
    useAppStore.setState({
      expandThinking: true,
      thinkingCollapsedMode: 'hide',
      thinkingAutoCollapse: true,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mountSettings(root)
    clickSessionsTab(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.removeChild(container)
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('renders the row (default ON) when 展开思考 is on', () => {
    expect(autoCollapseButton()).toBeTruthy()
    // 默认选中（开）：ToggleRow 的选中态由 aria / data 属性表达，这里直接验 store
    expect(useAppStore.getState().thinkingAutoCollapse).toBe(true)
  })

  it('hides the row when 展开思考 is off — 块本就收起，开关无效果可看', () => {
    // 与收起态档位行互为补集：两者永不同屏。
    expect(autoCollapseButton()).toBeTruthy()
    click(expandThinkingButton())
    expect(useAppStore.getState().expandThinking).toBe(false)
    // find 未命中返回 undefined（不是 null）——行确实不再渲染
    expect(autoCollapseButton()).toBeFalsy()
  })

  it('persists a toggle-off to the store and localStorage', () => {
    click(autoCollapseButton())
    expect(useAppStore.getState().thinkingAutoCollapse).toBe(false)
    expect(localStorage.getItem('omniterm_thinking_autocollapse')).toBe('false')
    // 再点一次开回来，双向都能落档
    click(autoCollapseButton())
    expect(useAppStore.getState().thinkingAutoCollapse).toBe(true)
    expect(localStorage.getItem('omniterm_thinking_autocollapse')).toBe('true')
  })

  it('keeps its own value across 展开思考 flips (independent setting)', () => {
    // 与 expandThinking / thinkingCollapsedMode 三者各自独立，互不复位。
    click(autoCollapseButton()) // off
    click(expandThinkingButton()) // expandThinking off
    click(expandThinkingButton()) // back on
    expect(autoCollapseButton()).toBeTruthy()
    expect(useAppStore.getState().thinkingAutoCollapse).toBe(false)
  })

  it('defines both i18n keys in en and zh', () => {
    const enMap = en as Record<string, string>
    const zhMap = zh as Record<string, string>
    for (const k of ['settings.thinkingAutoCollapse', 'settings.thinkingAutoCollapseHint']) {
      expect(enMap[k], k).toBeTruthy()
      expect(zhMap[k], k).toBeTruthy()
    }
  })
})
