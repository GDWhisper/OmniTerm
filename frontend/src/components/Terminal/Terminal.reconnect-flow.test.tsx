import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { Terminal } from './Terminal'
import { useAppStore } from '../../stores/appStore'
import { AttentionProvider } from '../Attention/AttentionProvider'

// Mock xterm so terminal creation is deterministic in jsdom (real xterm
// needs canvas). The fake appends a `.xterm` element to the container it
// was opened on, so tests can assert WHICH container hosts the terminal.
vi.mock('@xterm/xterm', () => {
  class FakeXterm {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    element: HTMLElement | null = null
    open(container: HTMLElement) {
      const el = document.createElement('div')
      el.className = 'xterm'
      el.appendChild(document.createElement('textarea'))
      container.appendChild(el)
      this.element = el
    }
    loadAddon() {}
    focus() {}
    write() {}
    writeln() {}
    reset() {}
    dispose() {
      this.element?.remove()
      this.element = null
    }
    onData() {
      return { dispose() {} }
    }
    onResize() {
      return { dispose() {} }
    }
    onTitleChange() {
      return { dispose() {} }
    }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    getSelection() {
      return ''
    }
  }
  return { Terminal: FakeXterm }
})
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
    // proposeDimensions is a public API of the real addon-fit; the
    // terminal hook overrides it on mobile (see useTerminal.ts), so the
    // fake must provide it for that override to be installed safely.
    proposeDimensions() {
      return { cols: 80, rows: 24 }
    }
  }
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  url: string
  binaryType = 'blob'
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  send() {}
  close() {
    this.readyState = FakeWebSocket.CLOSED
  }
}

function findReconnectButton(host: HTMLElement) {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '重连')
}

describe('Terminal reconnect flow', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
    i18n.changeLanguage('zh')
    useAppStore.setState({
      isMobile: false,
      activeSessionId: 'sess-1',
      activeExternalSession: null,
      terminalDisconnected: false,
      connected: true,
    })
    host = document.createElement('div')
    Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true })
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <AttentionProvider>
            <Terminal />
          </AttentionProvider>
        </I18nextProvider>
      )
    })
    // flush async createTerminal → terminalReady → auto connectWs
    await act(async () => {})
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  /** Simulate an established connection dropping (idle/network). */
  async function dropConnection(ws: FakeWebSocket) {
    await act(async () => {
      ws.readyState = FakeWebSocket.OPEN
      ws.onopen?.()
    })
    await act(async () => {
      ws.readyState = FakeWebSocket.CLOSED
      ws.onclose?.()
    })
  }

  async function clickReconnect() {
    const btn = findReconnectButton(host)
    expect(btn).toBeTruthy()
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // flush terminal re-creation + auto-connect effect
    await act(async () => {})
  }

  it('a late error event from a superseded socket does not bring the overlay back', async () => {
    expect(FakeWebSocket.instances.length).toBe(1)
    const ws1 = FakeWebSocket.instances[0]
    await dropConnection(ws1)
    expect(findReconnectButton(host)).toBeTruthy()

    // First click: terminal was torn down, so it re-creates and auto-connects (ws2).
    await clickReconnect()
    const ws2 = FakeWebSocket.instances[1]
    expect(ws2).toBeTruthy()

    // The overlay gives no "connecting" feedback, so an impatient user clicks
    // again while ws2 is still CONNECTING. connectWs closes ws2 (which will
    // fire a late error event) and opens ws3.
    await clickReconnect()
    const ws3 = FakeWebSocket.instances[2]
    expect(ws3).toBeTruthy()

    // ws3 connects successfully — overlay disappears.
    await act(async () => {
      ws3.readyState = FakeWebSocket.OPEN
      ws3.onopen?.()
    })
    expect(findReconnectButton(host)).toBeUndefined()

    // The browser now delivers the pending error event of the aborted ws2.
    // It must NOT flip the healthy connection back to "disconnected".
    await act(async () => {
      ws2.onerror?.()
    })
    expect(useAppStore.getState().terminalDisconnected).toBe(false)
    expect(findReconnectButton(host)).toBeUndefined()
  })

  it('terminal survives reconnect followed by a session roundtrip (session → none → session)', async () => {
    const ws1 = FakeWebSocket.instances[0]
    await dropConnection(ws1)

    // Reconnect via the overlay button and let ws2 open.
    await clickReconnect()
    const ws2 = FakeWebSocket.instances[1]
    expect(ws2).toBeTruthy()
    await act(async () => {
      ws2.readyState = FakeWebSocket.OPEN
      ws2.onopen?.()
    })
    expect(findReconnectButton(host)).toBeUndefined()

    // User deselects the session (empty state) and selects it again.
    await act(async () => {
      useAppStore.setState({ activeSessionId: null })
    })
    await act(async () => {
      useAppStore.setState({ activeSessionId: 'sess-1' })
    })
    await act(async () => {})

    // The visible panel must host a live terminal — with the lost-cleanup bug
    // the xterm instance stays attached to the OLD (unmounted) container and
    // the new panel stays black until a full page refresh.
    const panel = host.querySelector('.terminal-panel-pixel')
    expect(panel).toBeTruthy()
    expect(panel!.querySelector('.xterm')).toBeTruthy()
  })
})
