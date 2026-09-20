import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import {
  FakeWebSocket,
  mountTerminal,
  unmountTerminal,
  dropConnection,
  findReconnectButton,
} from './Terminal.testUtils'
import i18n from '../../i18n'
import { useAppStore } from '../../stores/appStore'

// xterm / addon 的 jsdom mock 与 FakeWebSocket 都在 Terminal.testUtils.tsx
//（reconnect-flow 与 autoReconnect 测试共用脚手架，勿在此重复声明）。

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
    ;({ host, root } = await mountTerminal())
  })

  afterEach(() => {
    unmountTerminal(root)
    vi.unstubAllGlobals()
  })

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
