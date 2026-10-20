import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AiCommitSection } from './AiCommitSection'
import { ApiError } from '../../api/client'

const { getAiCommitConfig, setAiCommitConfig, listAiCommitModels, addToast } = vi.hoisted(() => ({
  getAiCommitConfig: vi.fn(),
  setAiCommitConfig: vi.fn(),
  listAiCommitModels: vi.fn(),
  addToast: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../stores/toastStore', () => ({
  useToastStore: (selector: (s: { addToast: typeof addToast }) => unknown) => selector({ addToast }),
}))

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getAiCommitConfig: (...args: unknown[]) => getAiCommitConfig(...args),
      setAiCommitConfig: (...args: unknown[]) => setAiCommitConfig(...args),
      listAiCommitModels: (...args: unknown[]) => listAiCommitModels(...args),
    },
  }
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent === label,
  )
  if (!found) throw new Error(`${label} button not found`)
  return found as HTMLButtonElement
}

function setInput(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function render() {
  await act(async () => {
    root.render(<AiCommitSection />)
  })
  await act(async () => {})
}

beforeEach(() => {
  getAiCommitConfig.mockReset()
  setAiCommitConfig.mockReset()
  listAiCommitModels.mockReset()
  addToast.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AiCommitSection', () => {
  it('reveals connection fields and loads models from /v1/models', async () => {
    getAiCommitConfig.mockResolvedValue({
      provider: 'off', base_url: '', model: '', has_api_key: false,
    })
    listAiCommitModels.mockResolvedValue({
      models: [{ id: 'gpt-4o', label: 'gpt-4o' }, { id: 'gpt-4o-mini', label: 'gpt-4o-mini' }],
      truncated: false,
    })
    await render()

    act(() => button('settings.aiCommit.openai').click())
    const base = document.body.querySelector('input:not([type="password"])') as HTMLInputElement
    setInput(base, 'https://api.openai.com/v1')
    await act(async () => {
      button('settings.aiCommit.loadModels').click()
    })

    expect(listAiCommitModels).toHaveBeenCalledWith({
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
    })
    const options = document.body.querySelectorAll('#omniterm-ai-commit-models option')
    expect(options).toHaveLength(2)
  })

  it('saves non-secret fields and sends a new key write-only', async () => {
    getAiCommitConfig.mockResolvedValue({
      provider: 'off', base_url: '', model: '', has_api_key: false,
    })
    setAiCommitConfig.mockResolvedValue({
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      has_api_key: true,
    })
    await render()

    act(() => button('settings.aiCommit.openai').click())
    const base = document.body.querySelector('input:not([type="password"])') as HTMLInputElement
    setInput(base, 'https://api.openai.com/v1')
    const model = document.body.querySelector('input[list="omniterm-ai-commit-models"]') as HTMLInputElement
    setInput(model, 'gpt-4o')
    const key = document.body.querySelector('input[type="password"]') as HTMLInputElement
    setInput(key, 'sk-test')

    await act(async () => {
      button('settings.aiCommit.save').click()
    })

    expect(setAiCommitConfig).toHaveBeenCalledWith({
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      api_key: 'sk-test',
    })
    expect(addToast).toHaveBeenCalledWith('success', 'settings.aiCommit.saved')
    expect((document.body.querySelector('input[type="password"]') as HTMLInputElement).value).toBe('')
  })

  it('can remove a stored key and never prefills it', async () => {
    getAiCommitConfig.mockResolvedValue({
      provider: 'anthropic',
      base_url: 'https://api.anthropic.com',
      model: 'claude-x',
      has_api_key: true,
    })
    setAiCommitConfig.mockResolvedValue({
      provider: 'anthropic',
      base_url: 'https://api.anthropic.com',
      model: 'claude-x',
      has_api_key: false,
    })
    await render()

    const key = document.body.querySelector('input[type="password"]') as HTMLInputElement
    expect(key.value).toBe('')
    expect(key.placeholder).toBe('settings.aiCommit.keyConfigured')

    const clear = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => clear.click())
    await act(async () => {
      button('settings.aiCommit.save').click()
    })

    expect(setAiCommitConfig).toHaveBeenCalledWith({
      provider: 'anthropic',
      base_url: 'https://api.anthropic.com',
      model: 'claude-x',
      clear_api_key: true,
    })
  })

  it('shows when the configured environment variable is missing', async () => {
    getAiCommitConfig.mockResolvedValue({
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt',
      has_api_key: true,
      api_key_source: 'env',
      api_key_env: 'OPENAI_API_KEY',
      api_key_env_set: false,
    })
    await render()
    expect(document.body.textContent).toContain('settings.aiCommit.envVarMissing')
  })

  it('maps provider auth errors to localized copy', async () => {
    getAiCommitConfig.mockResolvedValue({
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt',
      has_api_key: true,
    })
    listAiCommitModels.mockRejectedValue(new ApiError(422, { code: 'ai_auth' }, 'bad key'))
    await render()

    await act(async () => {
      button('settings.aiCommit.loadModels').click()
    })
    expect(addToast).toHaveBeenCalledWith('error', 'settings.aiCommit.error.ai_auth')
  })
})
