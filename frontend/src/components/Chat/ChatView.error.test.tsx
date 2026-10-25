import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import { useChatStore } from '../../stores/chatStore'
import {
  SESSION_ID,
  setupChatViewStores,
  resetChatViewStores,
  installResizeObserverSpy,
} from './ChatView.testUtils'

// 顶部错误条：错误写入 store 后常驻，关闭按钮是唯一不依赖后续事件的收敛路径
// （发送 prompt 会清 error，但配置项设置失败后用户可能不再发送）。

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  installResizeObserverSpy()
  setupChatViewStores()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) }),
  )
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetChatViewStores()
  vi.unstubAllGlobals()
})

describe('ChatView error bar', () => {
  it('dismisses a sticky error via the ✕ button', async () => {
    await act(async () => {
      root.render(<ChatView />)
    })
    await act(async () => {})

    act(() => {
      useChatStore.getState().setError(SESSION_ID, '配置项 mode 设置失败: Internal error')
    })
    expect(container.querySelector('.chat-error-bar')?.textContent).toContain(
      '配置项 mode 设置失败',
    )

    const dismiss = container.querySelector<HTMLButtonElement>('.chat-error-dismiss')
    expect(dismiss).not.toBeNull()
    expect(dismiss!.getAttribute('aria-label')).toBeTruthy()

    act(() => dismiss!.click())
    expect(useChatStore.getState().states[SESSION_ID].error).toBeNull()
    expect(container.querySelector('.chat-error-bar')).toBeNull()
  })
})
