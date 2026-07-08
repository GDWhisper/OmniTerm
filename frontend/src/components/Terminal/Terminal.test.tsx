import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { Terminal } from './Terminal'
import { useAppStore } from '../../stores/appStore'
import { AttentionProvider } from '../Attention/AttentionProvider'

describe('Terminal mobile', () => {
  it('renders empty state when no active session', async () => {
    i18n.changeLanguage('zh')
    useAppStore.setState({ isMobile: true, activeSessionId: null })
    const container = document.createElement('div')
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
      expect(container.textContent).toContain('选择或创建一个会话')
    })
    root.unmount()
    document.body.removeChild(container)
  })

  // Basic invariant: the terminal panel container mounts when an active
  // session is present, even though useTerminal loads addons asynchronously.
  it('renders terminal panel div when an active session is present', async () => {
    i18n.changeLanguage('en')
    useAppStore.setState({ isMobile: true, activeSessionId: 'sess-1' })
    const container = document.createElement('div')
    // Give the panel a non-zero size so the async createTerminal doesn't
    // crash immediately (xterm measures clientWidth/Height on open).
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
    // Panel mounts synchronously; just confirm the pixel-bordered shell
    // appears in the DOM.  xterm itself won't render (no canvas in jsdom)
    // but the container div should be there.
    await vi.waitFor(() => {
      expect(container.querySelector('.terminal-panel-pixel')).toBeTruthy()
    })
    root.unmount()
    document.body.removeChild(container)
  })
})
