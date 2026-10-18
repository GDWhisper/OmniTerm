import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { CreateProjectModal } from './CreateProjectModal'
import { api, ApiError } from '../../api/client'
import { useToastStore, type ToastType } from '../../stores/toastStore'

vi.mock('../../api/client', () => ({
  api: {
    listDirs: vi.fn().mockResolvedValue({ files: [] }),
    pickDirectory: vi.fn(),
  },
  // CreateProjectModal / useDirBrowser 在运行时要 import ApiError（409 分支），
  // 即使本文件不触发也必须存在该命名导出。
  ApiError: class ApiError extends Error {
    status: number
    body: unknown
    constructor(message: string, status: number, body?: unknown) {
      super(message)
      this.status = status
      this.body = body
    }
  },
}))

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let addToast: ReturnType<typeof vi.fn>

function renderModal() {
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <CreateProjectModal
          open
          homeDir="/home/user"
          onClose={() => {}}
          reloadProjects={async () => {}}
          onFocusProject={() => {}}
        />
      </I18nextProvider>,
    )
  })
}

function pathInput(): HTMLInputElement {
  const input = document.body.querySelector('input[placeholder="/home/user"]')
  if (!(input instanceof HTMLInputElement)) throw new Error('path input not found')
  return input
}

function pickButton(): HTMLButtonElement {
  const button = document.body.querySelector('[data-testid="pick-directory"]')
  if (!(button instanceof HTMLButtonElement)) throw new Error('pick button not found')
  return button
}

describe('CreateProjectModal native folder picker', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    localStorage.clear()
    vi.clearAllMocks()
    addToast = vi.fn()
    useToastStore.setState({
      addToast: addToast as unknown as (type: ToastType, message: string) => void,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('fills the path returned by the native picker', async () => {
    vi.mocked(api.pickDirectory).mockResolvedValue({ path: '/home/user/picked' })
    renderModal()
    await vi.waitFor(() => expect(pathInput().value).toBe('/home/user/'))

    await act(async () => {
      pickButton().click()
    })

    await vi.waitFor(() => expect(pathInput().value).toBe('/home/user/picked/'))
    expect(api.pickDirectory).toHaveBeenCalledWith('/home/user/', expect.any(AbortSignal))
  })

  it('normalizes Windows separators and adds a trailing slash', async () => {
    vi.mocked(api.pickDirectory).mockResolvedValue({ path: 'C:\\work\\picked' })
    renderModal()
    await vi.waitFor(() => expect(pathInput().value).toBe('/home/user/'))

    await act(async () => {
      pickButton().click()
    })

    await vi.waitFor(() => expect(pathInput().value).toBe('C:/work/picked/'))
  })

  it('leaves the path untouched when the picker is cancelled', async () => {
    vi.mocked(api.pickDirectory).mockResolvedValue({ cancelled: true })
    renderModal()
    await vi.waitFor(() => expect(pathInput().value).toBe('/home/user/'))

    await act(async () => {
      pickButton().click()
    })

    await vi.waitFor(() => expect(api.pickDirectory).toHaveBeenCalledTimes(1))
    expect(pathInput().value).toBe('/home/user/')
  })

  it('localizes the localhost-only rejection', async () => {
    await i18n.changeLanguage('zh')
    // mock 的 ApiError 签名是 (message, status, body)，与真实类的
    // (status, body, message) 不同；运行时构造的仍是 mock 类，故
    // CreateProjectModal 的 instanceof 判据同源（与 Sidebar.test 同款）。
    const MockApiError = ApiError as unknown as new (
      message: string,
      status: number,
      body?: unknown,
    ) => Error
    vi.mocked(api.pickDirectory).mockRejectedValue(
      new MockApiError('local only', 403, { code: 'native_picker_local_only' }),
    )
    renderModal()
    await vi.waitFor(() => expect(pathInput().value).toBe('/home/user/'))

    await act(async () => {
      pickButton().click()
    })

    await vi.waitFor(() => expect(addToast).toHaveBeenCalledTimes(1))
    expect(addToast).toHaveBeenCalledWith('error', i18n.t('sidebar.pickDirectoryLocalOnly'))
    expect(addToast.mock.calls[0][1]).toContain('localhost')
    expect(pathInput().value).toBe('/home/user/')
  })

  it('re-enables the button and keeps the path when the picker fails', async () => {
    vi.mocked(api.pickDirectory).mockRejectedValue(new Error('not available'))
    renderModal()
    await vi.waitFor(() => expect(pathInput().value).toBe('/home/user/'))

    await act(async () => {
      pickButton().click()
    })

    await vi.waitFor(() => expect(api.pickDirectory).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(pickButton().disabled).toBe(false))
    expect(pathInput().value).toBe('/home/user/')
  })
})
