import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { AuthSection } from './AuthSection'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { api } from '../../api/client'
import en from '../../locales/en/translation.json'
import zh from '../../locales/zh/translation.json'

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    api: {
      getAuthSettings: vi.fn(),
      setAuthSettings: vi.fn(),
      changeUsername: vi.fn(),
      changePassword: vi.fn(),
      logout: vi.fn(),
      check: vi.fn(),
      setup: vi.fn(),
      login: vi.fn(),
    },
  }
})

const SETTINGS = { auth_enabled: true, local_auth_required: true, username: 'alice' }

/** Set a controlled input's value the way typing would, then flush React. */
function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    nativeSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('AuthSection local access + username', () => {
  let container: HTMLDivElement
  let root: Root

  /** Leaf sections only — ToggleRow's own <section>; the component root wraps everything. */
  const leafSections = () =>
    Array.from(container.querySelectorAll<HTMLElement>('section')).filter((s) => !s.querySelector('section'))

  const toggleButton = (label: string) => {
    const section = leafSections().find((s) => (s.textContent || '').includes(label))
    return section?.querySelector('button') ?? null
  }

  const buttonByText = (text: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => (b.textContent || '').trim() === text,
    ) ?? null

  beforeEach(() => {
    localStorage.clear()
    // vi.fn() module mocks are not restored by restoreAllMocks: clear the call
    // history explicitly so per-test assertions stay independent.
    vi.clearAllMocks()
    i18n.changeLanguage('en')
    useAppStore.setState({ authEnabled: true, authState: 'authenticated' })
    useToastStore.setState({ toasts: [] })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  async function mount() {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <AuthSection />
        </I18nextProvider>,
      )
    })
    // The settings fetch lives in a mount effect; wait for its promise (and the
    // resulting render) to settle inside act, as AuditLogSection.test does.
    await act(async () => {
      await vi.waitFor(() => {
        expect(vi.mocked(api.getAuthSettings)).toHaveBeenCalled()
      })
      await Promise.resolve()
    })
  }

  async function click(el: Element) {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
  }

  it('seeds the local toggle and username from GET /auth/settings', async () => {
    vi.mocked(api.getAuthSettings).mockResolvedValue(SETTINGS)
    await mount()

    const toggle = toggleButton(i18n.t('auth.localAuth'))
    expect(toggle).toBeTruthy()
    expect(toggle!.textContent).toContain(i18n.t('settings.on'))
    expect(container.textContent).toContain(i18n.t('auth.localAuthHintOn'))
    expect(container.textContent).toContain('alice')
  })

  it('toggle off persists { local_auth_required: false } and flips to the danger hint', async () => {
    vi.mocked(api.getAuthSettings).mockResolvedValue(SETTINGS)
    vi.mocked(api.setAuthSettings).mockResolvedValue(undefined)
    await mount()

    await click(toggleButton(i18n.t('auth.localAuth'))!)

    await vi.waitFor(() => {
      expect(api.setAuthSettings).toHaveBeenCalledWith({ local_auth_required: false })
    })
    const toggle = toggleButton(i18n.t('auth.localAuth'))!
    expect(toggle.textContent).toContain(i18n.t('settings.off'))
    expect(container.textContent).toContain(i18n.t('auth.localAuthHintOff'))
  })

  it('renames the account, toasts, then logs out locally', async () => {
    vi.mocked(api.getAuthSettings).mockResolvedValue(SETTINGS)
    vi.mocked(api.changeUsername).mockResolvedValue({ ok: true })
    vi.mocked(api.logout).mockResolvedValue(undefined)
    await mount()

    setInputValue(container.querySelector<HTMLInputElement>('#auth-change-username-pw')!, 'pw')
    setInputValue(container.querySelector<HTMLInputElement>('#auth-change-username-new')!, '  bob  ')
    await click(buttonByText(i18n.t('auth.changeUsername'))!)

    await vi.waitFor(() => {
      expect(api.changeUsername).toHaveBeenCalledWith('pw', 'bob')
    })
    expect(useToastStore.getState().toasts.some((x) => x.message === i18n.t('auth.usernameChanged'))).toBe(true)
    expect(useAppStore.getState().authState).toBe('unauthenticated')
  })

  it('keeps the session and reports a wrong password when renaming fails with 401', async () => {
    vi.mocked(api.getAuthSettings).mockResolvedValue(SETTINGS)
    vi.mocked(api.changeUsername).mockRejectedValue({ status: 401 })
    await mount()

    setInputValue(container.querySelector<HTMLInputElement>('#auth-change-username-pw')!, 'nope')
    setInputValue(container.querySelector<HTMLInputElement>('#auth-change-username-new')!, 'bob')
    await click(buttonByText(i18n.t('auth.changeUsername'))!)

    await vi.waitFor(() => {
      expect(container.textContent).toContain(i18n.t('auth.wrongPassword'))
    })
    expect(useAppStore.getState().authState).toBe('authenticated')
  })

  it('degrades to the master switch only when the settings read fails', async () => {
    vi.mocked(api.getAuthSettings).mockRejectedValue(new Error('boom'))
    await mount()

    // 读不到不改其它区块，也不崩：只有总开关，不出现本地校验开关
    expect(toggleButton(i18n.t('auth.passwordAuth'))).toBeTruthy()
    expect(toggleButton(i18n.t('auth.localAuth'))).toBeNull()
    // 改用户名表单不依赖读口，仍然可用
    expect(buttonByText(i18n.t('auth.changeUsername'))).toBeTruthy()
  })

  it('defines every new auth key in both en and zh', () => {
    const enMap = en as Record<string, string>
    const zhMap = zh as Record<string, string>
    const keys = [
      'auth.username',
      'auth.usernamePlaceholderDefault',
      'auth.usernameNotSet',
      'auth.newUsername',
      'auth.changeUsername',
      'auth.usernameChanged',
      'auth.changeUsernameFailed',
      'auth.invalidUsername',
      'auth.localAuth',
      'auth.localAuthHintOn',
      'auth.localAuthHintOff',
      'auth.localAuthUpdateFailed',
    ]
    for (const k of keys) {
      expect(enMap[k], k).toBeTruthy()
      expect(zhMap[k], k).toBeTruthy()
      expect(enMap[k], k).not.toMatch(/[\u4e00-\u9fff]/)
    }
    // 关闭态的文案必须点明「仅回环免密、远程仍需密码」
    for (const map of [enMap, zhMap]) {
      expect(map['auth.localAuthHintOff']).toContain('127.0.0.1')
      expect(map['auth.localAuthHintOff']).toContain('localhost')
    }
    expect(enMap['auth.localAuthHintOff']).toMatch(/remote/i)
    expect(zhMap['auth.localAuthHintOff']).toContain('远程')
  })
})
