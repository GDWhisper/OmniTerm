import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { AuthPage } from './AuthPage'
import { useAppStore } from '../../stores/appStore'
import { api, DEFAULT_USERNAME } from '../../api/client'

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return { ...actual, api: { setup: vi.fn(), login: vi.fn() } }
})

/** Set a controlled input's value the way typing would, then flush React. */
function setInputValue(input: HTMLInputElement, value: string) {
  act(() => {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    nativeSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('AuthPage username field', () => {
  let container: HTMLDivElement
  let root: Root

  const usernameInput = () => container.querySelector<HTMLInputElement>('#auth-username')!
  const passwordInput = () => container.querySelector<HTMLInputElement>('#auth-password')!
  const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!

  beforeEach(() => {
    localStorage.clear()
    // vi.fn() module mocks are not restored by restoreAllMocks: clear the call
    // history explicitly so "not called" assertions stay per-test.
    vi.clearAllMocks()
    i18n.changeLanguage('en')
    useAppStore.setState({ authState: 'unauthenticated' })
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

  async function mount(needsSetup: boolean) {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <AuthPage needsSetup={needsSetup} />
        </I18nextProvider>,
      )
    })
  }

  /** Submit through the form so React's onSubmit runs (jsdom click on a submit
   *  button does not reliably trigger form submission). */
  async function submit() {
    const form = container.querySelector('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
  }

  it('logs in with the trimmed username and the password', async () => {
    vi.mocked(api.login).mockResolvedValue(undefined)
    await mount(false)

    expect(usernameInput().value).toBe('')
    expect(usernameInput().placeholder).toBe(i18n.t('auth.usernamePlaceholderDefault'))
    expect(usernameInput().getAttribute('autocomplete')).toBe('username')

    setInputValue(usernameInput(), '  alice  ')
    setInputValue(passwordInput(), 'secret')
    await submit()

    expect(api.login).toHaveBeenCalledTimes(1)
    expect(api.login).toHaveBeenCalledWith('alice', 'secret')
    expect(api.setup).not.toHaveBeenCalled()
    expect(useAppStore.getState().authState).toBe('authenticated')
  })

  it('sets up with the prefilled default username', async () => {
    vi.mocked(api.setup).mockResolvedValue(undefined)
    await mount(true)

    // Setup prefills the default so the user keeps it or types their own.
    expect(usernameInput().value).toBe(DEFAULT_USERNAME)
    setInputValue(passwordInput(), 'pw1234')
    await submit()

    expect(api.setup).toHaveBeenCalledWith(DEFAULT_USERNAME, 'pw1234')
    expect(api.login).not.toHaveBeenCalled()
    expect(useAppStore.getState().authState).toBe('authenticated')
  })

  it('keeps submit disabled until both fields hold non-blank text', async () => {
    vi.mocked(api.login).mockResolvedValue(undefined)
    await mount(false)

    expect(submitButton().disabled).toBe(true)

    setInputValue(usernameInput(), 'alice')
    expect(submitButton().disabled).toBe(true)

    setInputValue(passwordInput(), 'secret')
    expect(submitButton().disabled).toBe(false)

    // Whitespace-only username counts as empty (trimmed before submit).
    setInputValue(usernameInput(), '   ')
    expect(submitButton().disabled).toBe(true)
    await submit()
    expect(api.login).not.toHaveBeenCalled()
  })

  it('shows the backend error and stays unauthenticated on failure', async () => {
    vi.mocked(api.login).mockRejectedValue({ status: 401, body: { error: 'Invalid credentials' } })
    await mount(false)

    setInputValue(usernameInput(), 'alice')
    setInputValue(passwordInput(), 'nope')
    await submit()

    expect(container.textContent).toContain('Invalid credentials')
    expect(useAppStore.getState().authState).toBe('unauthenticated')
  })

  it('defines the username copy in both en and zh', async () => {
    const { default: en } = await import('../../locales/en/translation.json')
    const { default: zh } = await import('../../locales/zh/translation.json')
    const enMap = en as Record<string, string>
    const zhMap = zh as Record<string, string>
    for (const k of ['auth.username', 'auth.usernamePlaceholderDefault']) {
      expect(enMap[k], k).toBeTruthy()
      expect(zhMap[k], k).toBeTruthy()
      // en 侧不得混入中文，zh 侧不得是未翻译的占位
      expect(enMap[k], k).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })
})
