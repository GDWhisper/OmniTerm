import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { Terminal as XTerm } from '@xterm/xterm'
import i18n from '../../i18n'
import { Terminal } from './Terminal'
import { useAppStore } from '../../stores/appStore'
import { AttentionProvider } from '../Attention/AttentionProvider'

/** Mount <Terminal /> at a non-zero size and flush effects. */
async function renderTerminal() {
  const container = document.createElement('div')
  // xterm measures clientWidth/Height in open(); jsdom reports 0 without this.
  Object.defineProperty(container, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true })
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <AttentionProvider>
          <Terminal />
        </AttentionProvider>
      </I18nextProvider>
    )
  })
  return { container, root }
}

/** createTerminal resolves asynchronously; the hidden textarea it creates is
 *  the observable signal that term.open() finished. */
async function waitForTerminalOpen(container: HTMLElement) {
  await act(async () => {
    await vi.waitFor(() => expect(container.querySelector('textarea')).toBeTruthy())
  })
}

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
    // Give the panel a non-zero size so the xterm terminal (initialized
    // inside useTerminal) doesn't crash on open (xterm measures clientWidth/Height).
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

describe('Terminal auto-focus on session switch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('focuses the terminal when the active session changes (desktop)', async () => {
    const focusSpy = vi.spyOn(XTerm.prototype, 'focus')
    useAppStore.setState({ isMobile: false, activeSessionId: 'sess-1' })
    const { container, root } = await renderTerminal()
    await waitForTerminalOpen(container)
    expect(focusSpy).toHaveBeenCalled()

    // Same-kind switches keep the view mounted, so focus must be driven by
    // the session id, not by mount.
    focusSpy.mockClear()
    await act(async () => {
      useAppStore.setState({ activeSessionId: 'sess-2' })
    })
    await vi.waitFor(() => expect(focusSpy).toHaveBeenCalled())
    root.unmount()
    document.body.removeChild(container)
  })

  it('does not auto-focus on mobile — focusing pops the soft keyboard', async () => {
    const focusSpy = vi.spyOn(XTerm.prototype, 'focus')
    useAppStore.setState({ isMobile: true, activeSessionId: 'sess-1' })
    const { container, root } = await renderTerminal()
    await waitForTerminalOpen(container)
    await act(async () => {
      useAppStore.setState({ activeSessionId: 'sess-2' })
    })
    await waitForTerminalOpen(container)
    expect(focusSpy).not.toHaveBeenCalled()
    root.unmount()
    document.body.removeChild(container)
  })
})
