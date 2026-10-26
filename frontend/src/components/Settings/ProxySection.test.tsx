import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { ProxySection } from './ProxySection'
import { api, ApiError, type ProxySettings } from '../../api/client'
import { setProxyEnabled } from '../../utils/proxyUrl'
import en from '../../locales/en/translation.json'
import zh from '../../locales/zh/translation.json'

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    api: { ...actual.api, getProxySettings: vi.fn(), setProxySettings: vi.fn() },
  }
})

vi.mock('../../utils/proxyUrl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/proxyUrl')>()
  return { ...actual, setProxyEnabled: vi.fn() }
})

const DEFAULTS: ProxySettings = { enabled: true, mode: 'default', allowed_ports: [] }

describe('ProxySection（代理安全设置）', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    i18n.changeLanguage('en')
    vi.mocked(api.getProxySettings).mockReset()
    vi.mocked(api.setProxySettings).mockReset()
    vi.mocked(setProxyEnabled).mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    vi.restoreAllMocks()
  })

  async function mount() {
    const React = await import('react')
    await React.act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <ProxySection />
        </I18nextProvider>,
      )
    })
    await React.act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain('Port-forward proxy')
      })
    })
  }

  function buttonByText(text: string): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes(text),
    )
    expect(button, `button containing "${text}"`).toBeTruthy()
    return button as HTMLButtonElement
  }

  function portInput(): HTMLInputElement {
    const input = container.querySelector('input[inputmode="numeric"]')
    expect(input, 'port input').toBeTruthy()
    return input as HTMLInputElement
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  async function click(element: HTMLElement) {
    const React = await import('react')
    await React.act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('loads and renders the effective policy', async () => {
    vi.mocked(api.getProxySettings).mockResolvedValue(DEFAULTS)
    await mount()
    expect(container.textContent).toContain('Safe range')
    expect(container.textContent).toContain('ON')
  })

  it('saves the whole draft and updates the link-rewrite gate', async () => {
    vi.mocked(api.getProxySettings).mockResolvedValue(DEFAULTS)
    const saved: ProxySettings = { enabled: false, mode: 'default', allowed_ports: [] }
    vi.mocked(api.setProxySettings).mockResolvedValue(saved)
    await mount()

    await click(buttonByText('ON'))
    await click(buttonByText('Save proxy settings'))

    const React = await import('react')
    await React.act(async () => {
      await vi.waitFor(() => expect(api.setProxySettings).toHaveBeenCalled())
    })
    expect(api.setProxySettings).toHaveBeenCalledWith({
      enabled: false,
      mode: 'default',
      allowed_ports: [],
    })
    expect(setProxyEnabled).toHaveBeenCalledWith(false)
    expect(container.textContent).toContain('Saved')
  })

  it('switches to allowlist mode, adds a port and sends normalized ports', async () => {
    vi.mocked(api.getProxySettings).mockResolvedValue(DEFAULTS)
    const saved: ProxySettings = { enabled: true, mode: 'allowlist', allowed_ports: [5173] }
    vi.mocked(api.setProxySettings).mockResolvedValue(saved)
    await mount()

    await click(buttonByText('Allowlist only'))
    expect(container.textContent).toContain('Empty allowlist = every port is denied.')

    await click(buttonByText('Add port'))
    const input = portInput()
    const React = await import('react')
    await React.act(async () => {
      setInputValue(input, '5173')
    })
    await click(buttonByText('Save proxy settings'))
    await React.act(async () => {
      await vi.waitFor(() => expect(api.setProxySettings).toHaveBeenCalled())
    })
    expect(api.setProxySettings).toHaveBeenCalledWith({
      enabled: true,
      mode: 'allowlist',
      allowed_ports: [5173],
    })
  })

  it('rejects out-of-range ports inline without calling the API', async () => {
    vi.mocked(api.getProxySettings).mockResolvedValue({
      enabled: true,
      mode: 'allowlist',
      allowed_ports: [3000],
    })
    await mount()

    const input = portInput()
    const React = await import('react')
    await React.act(async () => {
      setInputValue(input, '2999')
    })
    await click(buttonByText('Save proxy settings'))

    expect(container.textContent).toContain('Ports must be integers between 3000 and 65535')
    expect(api.setProxySettings).not.toHaveBeenCalled()
  })

  it('maps a backend 400 to the inline invalid-port message', async () => {
    vi.mocked(api.getProxySettings).mockResolvedValue({
      enabled: true,
      mode: 'allowlist',
      allowed_ports: [3000],
    })
    vi.mocked(api.setProxySettings).mockRejectedValue(new ApiError(400, {}, 'bad request'))
    await mount()

    // 先让草稿变为 dirty，否则保存按钮是禁用态。
    await click(buttonByText('ON'))
    await click(buttonByText('Save proxy settings'))
    const React = await import('react')
    await React.act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain('Ports must be integers between 3000 and 65535'),
      )
    })
  })

  it('shows a load failure instead of silently disappearing', async () => {
    vi.mocked(api.getProxySettings).mockRejectedValue(new Error('boom'))
    await mount()
    expect(container.textContent).toContain('Failed to load proxy settings.')
  })

  it('disables adding rows at the 64-port cap', async () => {
    const ports = Array.from({ length: 64 }, (_, i) => 3000 + i)
    vi.mocked(api.getProxySettings).mockResolvedValue({
      enabled: true,
      mode: 'allowlist',
      allowed_ports: ports,
    })
    await mount()
    expect(buttonByText('Add port').disabled).toBe(true)
  })

  it('defines every proxy copy and new audit action in both locales', () => {
    const keys = [
      'settings.proxy.title',
      'settings.proxy.enabledHintOn',
      'settings.proxy.enabledHintOff',
      'settings.proxy.mode',
      'settings.proxy.modeDefault',
      'settings.proxy.modeAllowlist',
      'settings.proxy.modeDefaultHint',
      'settings.proxy.modeAllowlistHint',
      'settings.proxy.allowedPorts',
      'settings.proxy.addPort',
      'settings.proxy.allowedPortsHint',
      'settings.proxy.emptyAllowlistWarning',
      'settings.proxy.save',
      'settings.proxy.saved',
      'settings.proxy.saveFailed',
      'settings.proxy.invalidPort',
      'settings.proxy.loadFailed',
      'settings.auditLog.action.proxyAccess',
      'settings.auditLog.action.proxyDenied',
      'settings.auditLog.action.proxySettingsChanged',
    ]
    for (const key of keys) {
      expect((en as Record<string, string>)[key], `en:${key}`).toBeTruthy()
      expect((zh as Record<string, string>)[key], `zh:${key}`).toBeTruthy()
      expect((en as Record<string, string>)[key], `en:${key}`).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })
})
