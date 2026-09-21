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
      permTimeoutMin: 30,
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

  it('renders four sliders in sessions with defaults 30 / 5 / 10 / 15', () => {
    // 顺序：权限请求超时（PermissionTimeoutSection 在前）→ ACP 空闲回收 → 失焦 → 空闲。
    const r = ranges(container)
    expect(r.length).toBe(4)
    expect(r.map((x) => x.value)).toEqual(['30', '5', '10', '15'])
  })

  it('bounds every slider to 1..60 with step 1', () => {
    for (const input of ranges(container)) {
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
  'settings.permTimeoutMinutes',
  'settings.permTimeoutMinutesHint',
  'settings.permTimeoutMinutesWarning',
  'system.permTimeout.abort',
  'system.permTimeout.auto',
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
    useAppStore.setState({ permTimeoutMode: 'abort', permTimeoutMin: 30 })
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
    const spy = vi.spyOn(api, 'setPermissionTimeout').mockResolvedValue({ mode: 'auto', minutes: 30 })
    const btn = modeButton(['自动推进', 'Auto-Advance'])!
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useAppStore.getState().permTimeoutMode).toBe('auto')
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith('auto', 30)
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

  it('moving the slider persists mode and minutes together', async () => {
    const spy = vi.spyOn(api, 'setPermissionTimeout').mockResolvedValue({ mode: 'auto', minutes: 45 })
    act(() => {
      useAppStore.setState({ permTimeoutMode: 'auto' })
    })
    setRangeValue(ranges(container)[0], 45)
    expect(useAppStore.getState().permTimeoutMin).toBe(45)
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith('auto', 45)
    })
  })

  it('warns only above the 30-minute default (default itself stays quiet)', () => {
    const warning = i18n.t('settings.permTimeoutMinutesWarning')
    expect(container.textContent).not.toContain(warning)
    act(() => {
      useAppStore.setState({ permTimeoutMin: 45 })
    })
    expect(container.textContent).toContain(warning)
  })

  it('defines every permission-timeout key in both en and zh', () => {
    const enMap = en as Record<string, string>
    const zhMap = zh as Record<string, string>
    for (const k of PERM_TIMEOUT_KEYS) {
      expect(enMap[k], k).toBeTruthy()
      expect(zhMap[k], k).toBeTruthy()
    }
    // 两条 system 文案必须带插值变量，否则前端渲染出光板句子。
    expect(enMap['system.permTimeout.abort']).toContain('{{minutes}}')
    expect(zhMap['system.permTimeout.auto']).toContain('{{selected}}')
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
