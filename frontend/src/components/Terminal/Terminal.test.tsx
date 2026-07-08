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

  // Regression: Terminal must mount the panel + xterm container when an
  // active session is present, even though the addons are async-imported.
  // Earlier the async createTerminal left a window where the panel could
  // render before the addons finished loading, and a size change in that
  // window was missed by the ResizeObserver (which was set up AFTER
  // term.open). Symptom: terminal fitted to a stale 1-row size — input
  // line at the bottom, big black area above, cursor at the top, no input.
  // The fix moves ResizeObserver ahead of term.open and uses rAF for the
  // initial fit. This test just verifies the panel mounts without throwing.
  it('renders terminal panel when an active session is present', async () => {
    i18n.changeLanguage('en')
    useAppStore.setState({
      isMobile: true,
      activeSessionId: 'sess-1',
      // No terminal panel mount uses fontSize beyond the default.
    })
    const container = document.createElement('div')
    // Give the panel a non-zero size — ResizeObserver in jsdom needs it
    // to fire and the fix's rAF-triggered fit reads it.
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
    // Panel renders synchronously (the container div mounts in the same
    // commit as the useEffect that triggers createTerminal). Wait for the
    // pixel-bordered terminal-panel class to appear, then assert the title
    // bar and panel scaffolding are in place.
    await vi.waitFor(() => {
      expect(container.querySelector('.terminal-panel-pixel')).toBeTruthy()
    })
    // Title bar should show the live badge when a session is active.
    expect(container.textContent).toContain('LIVE')
    root.unmount()
    document.body.removeChild(container)
  })
})
