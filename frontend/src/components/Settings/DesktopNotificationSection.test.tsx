import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { DesktopNotificationSection } from './DesktopNotificationSection'
import { useAppStore } from '../../stores/appStore'
import en from '../../locales/en/translation.json'
import zh from '../../locales/zh/translation.json'

/**
 * 设置 → 通知 → 桌面通知区块（F07）。
 *
 * 面板的核心职责是**不欺骗**：能力/权限态如实展示，不可用时写明原因
 * （如「当前以 http 访问非本机地址」），而不是让用户开了开关却收不到通知。
 */

class MockNotification {
  static permission: NotificationPermission = 'default'
  static requestPermission = vi.fn(async () => MockNotification.permission)
  title: string
  body: string
  constructor(title: string, options?: NotificationOptions) {
    this.title = title
    this.body = options?.body ?? ''
  }
}

describe('DesktopNotificationSection（桌面通知开关）', () => {
  let container: HTMLDivElement
  let root: Root

  function mount() {
    act(() => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <DesktopNotificationSection />
        </I18nextProvider>,
      )
    })
  }

  function buttons(): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll('button'))
  }

  function toggleButton(): HTMLButtonElement {
    const btn = buttons().find((b) => {
      const text = (b.textContent || '').trim()
      return text === en['settings.on'] || text === en['settings.off'] || text === zh['settings.on'] || text === zh['settings.off']
    })
    if (!btn) throw new Error('未找到开关按钮')
    return btn
  }

  function text(): string {
    return container.textContent || ''
  }

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    MockNotification.permission = 'default'
    MockNotification.requestPermission = vi.fn(async () => MockNotification.permission)
    vi.stubGlobal('Notification', MockNotification)
    useAppStore.setState({ desktopNotificationEnabled: false })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mount()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('环境不提供通知能力 → 开关置灰并写明原因', () => {
    vi.unstubAllGlobals() // jsdom 无 Notification 构造器 = 环境不提供
    act(() => root.unmount())
    root = createRoot(container)
    mount()
    expect(toggleButton().disabled).toBe(true)
    expect(text()).toContain(en['settings.desktopNotificationState.unsupported'])
  })

  it('非安全上下文 → 写明「http 非本机地址」的原因', () => {
    vi.unstubAllGlobals()
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    act(() => root.unmount())
    root = createRoot(container)
    mount()
    expect(toggleButton().disabled).toBe(true)
    expect(text()).toContain(en['settings.desktopNotificationState.insecure'])
    Object.defineProperty(window, 'isSecureContext', { value: undefined, configurable: true })
  })

  it('权限被拒 → 如实显示「已拒绝」并给重新请求入口', () => {
    MockNotification.permission = 'denied'
    act(() => root.unmount())
    root = createRoot(container)
    mount()
    expect(text()).toContain(en['settings.desktopNotificationState.denied'])
    expect(buttons().some((b) => (b.textContent || '').trim() === en['settings.desktopNotificationRequest'])).toBe(true)
  })

  it('已授权 → 显示已授权状态', () => {
    MockNotification.permission = 'granted'
    act(() => root.unmount())
    root = createRoot(container)
    mount()
    expect(text()).toContain(en['settings.desktopNotificationState.supported'])
  })

  it('开启开关时在用户手势内请求权限，并记录用户意图', async () => {
    // 挂载时权限尚未表态（capability = 'default'）→ 点击开关要弹权限框（D4）。
    MockNotification.requestPermission = vi.fn(async () => {
      MockNotification.permission = 'granted'
      return 'granted' as NotificationPermission
    })
    await act(async () => {
      toggleButton().click()
    })
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().desktopNotificationEnabled).toBe(true)
    expect(text()).toContain(en['settings.desktopNotificationState.supported'])
  })

  it('权限被拒时开关仍记为用户意图，但状态行如实显示「已拒绝」', async () => {
    MockNotification.permission = 'denied'
    MockNotification.requestPermission = vi.fn(async () => 'denied' as NotificationPermission)
    act(() => root.unmount())
    root = createRoot(container)
    mount()
    await act(async () => {
      toggleButton().click()
    })
    expect(useAppStore.getState().desktopNotificationEnabled).toBe(true)
    expect(text()).toContain(en['settings.desktopNotificationState.denied'])
  })

  it('关闭开关即取消用户意图', async () => {
    useAppStore.setState({ desktopNotificationEnabled: true })
    act(() => root.unmount())
    root = createRoot(container)
    mount()
    await act(async () => {
      toggleButton().click()
    })
    expect(useAppStore.getState().desktopNotificationEnabled).toBe(false)
  })
})
