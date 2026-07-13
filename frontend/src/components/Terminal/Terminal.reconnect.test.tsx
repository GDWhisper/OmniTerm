import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { Terminal } from './Terminal'
import { useAppStore } from '../../stores/appStore'
import { AttentionProvider } from '../Attention/AttentionProvider'

describe('Terminal reconnect overlay', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows reconnect button when disconnected but session is active', async () => {
    i18n.changeLanguage('en')
    useAppStore.setState({
      isMobile: false,
      activeSessionId: 'sess-1',
      terminalDisconnected: true,
    })

    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true })
    document.body.appendChild(container)

    const root = createRoot(container)
    root.render(
      <I18nextProvider i18n={i18n}>
        <AttentionProvider>
          <Terminal />
        </AttentionProvider>
      </I18nextProvider>
    )

    await vi.waitFor(() => {
      const button = container.querySelector('button')
      expect(button).toBeTruthy()
      expect(button?.textContent).toBe('重连')
    })

    root.unmount()
  })

  it('shows reconnect button even when Sidebar health poll flips global connected=true', async () => {
    i18n.changeLanguage('en')
    // Reproduces the race: terminal WS was torn down (terminalDisconnected=true)
    // but the backend is still reachable so the health poll sets connected=true.
    useAppStore.setState({
      isMobile: false,
      activeSessionId: 'sess-1',
      connected: true,
      terminalDisconnected: true,
    })

    const container = document.createElement('div')
    Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true })
    document.body.appendChild(container)

    const root = createRoot(container)
    root.render(
      <I18nextProvider i18n={i18n}>
        <AttentionProvider>
          <Terminal />
        </AttentionProvider>
      </I18nextProvider>
    )

    await vi.waitFor(() => {
      const button = container.querySelector('button')
      expect(button).toBeTruthy()
      expect(button?.textContent).toBe('重连')
    })

    root.unmount()
  })
})
