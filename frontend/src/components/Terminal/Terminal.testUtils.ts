import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { Terminal } from './Terminal'
import { AttentionProvider } from '../Attention/AttentionProvider'
import { FakeXterm } from './fakeXterm'
export { FakeXterm }

// Mock xterm so terminal creation is deterministic in jsdom (real xterm
// needs canvas). The fake appends a `.xterm` element to the container it
// was opened on, so tests can assert WHICH container hosts the terminal.
// 类本体在 ./fakeXterm.ts：工厂先于一切模块体执行、无法引用外部变量，
// 故在工厂内动态 import 与测试代码共享同一个类身份。
vi.mock('@xterm/xterm', async () => {
  const { FakeXterm: FakeTerminal } = await import('./fakeXterm')
  return { Terminal: FakeTerminal }
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

export class FakeWebSocket {
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

export function findReconnectButton(host: HTMLElement) {
  return Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '重连')
}

/** 按当前 store 状态渲染终端面板并 flush 异步 createTerminal →
 *  terminalReady → auto connectWs。store 状态由各测试在调用前 setState。 */
export async function mountTerminal(): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement('div')
  Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true })
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    // createElement 而非 JSX：本文件保持 .ts（react-refresh 规则不检 .ts，
    // 与 ChatView.testUtils.ts 同款约定）
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AttentionProvider, null, createElement(Terminal)),
      ),
    )
  })
  await act(async () => {})
  return { host, root }
}

export function unmountTerminal(root: Root) {
  act(() => {
    root.unmount()
  })
  document.body.innerHTML = ''
}

/** Simulate an established connection dropping (idle/network). */
export async function dropConnection(ws: FakeWebSocket) {
  await act(async () => {
    ws.readyState = FakeWebSocket.OPEN
    ws.onopen?.()
  })
  await act(async () => {
    ws.readyState = FakeWebSocket.CLOSED
    ws.onclose?.()
  })
}

/** jsdom 的 document.hidden 是 Document.prototype getter，实例上 defineProperty
 *  遮蔽之；restore 用 delete 归还原型 getter。 */
export function setDocumentHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  Object.defineProperty(document, 'visibilityState', {
    value: hidden ? 'hidden' : 'visible',
    configurable: true,
  })
}

export function restoreDocumentVisibility() {
  delete (document as { hidden?: unknown }).hidden
  delete (document as { visibilityState?: unknown }).visibilityState
}
