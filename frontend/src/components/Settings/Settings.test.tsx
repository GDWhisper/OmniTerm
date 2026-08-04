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

  it('renders three sliders in sessions with defaults 5 / 10 / 15', () => {
    const r = ranges(container)
    expect(r.length).toBe(3)
    expect(r.map((x) => x.value)).toEqual(['5', '10', '15'])
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
    setRangeValue(ranges(container)[0], 30)
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledWith(30)
    })
  })

  it('persists blur/idle sliders to localStorage via the store setters', () => {
    setRangeValue(ranges(container)[1], 20) // blur
    expect(localStorage.getItem('omniterm_blur_disconnect_min')).toBe('20')
    setRangeValue(ranges(container)[2], 25) // idle
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
