import { describe, it, expect, vi } from 'vitest'

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { Layout } from './Layout'
import { useAppStore } from '../../stores/appStore'
import { AttentionProvider } from '../Attention/AttentionProvider'

describe('Layout mobile', () => {
  it('renders mobile layout when isMobile is true', async () => {
    useAppStore.setState({ isMobile: true, activeTab: 'terminal', activeSessionId: null })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    root.render(
      <I18nextProvider i18n={i18n}>
        <AttentionProvider>
          <Layout />
        </AttentionProvider>
      </I18nextProvider>
    )
    await vi.waitFor(() => {
      expect(container.querySelector('nav')).toBeTruthy()
    })
    root.unmount()
    document.body.removeChild(container)
  })
})
