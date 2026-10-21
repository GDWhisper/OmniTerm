import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { AttentionProvider } from './AttentionProvider'
import { useAttention, type AttentionContextValue } from '../../hooks/useAttention'
import { useAppStore } from '../../stores/appStore'
import { resetDesktopNotificationState } from '../../utils/desktopNotification'
import type { Session } from '../../api/client'

/**
 * 桌面通知与 attention 的接线测试（F07）。
 *
 * 覆盖计划的三条判定：
 * - D6：用户正盯着这个会话时**不弹**通知（判定与既有 ping 同源）。
 * - D7：桌面通知已启用且已授权时**不再叠加** OmniTerm 自己的 ping 声。
 * - D2：通知内容只有会话名 + 事件类型，**不含 agent 回复正文**。
 *
 * 既有 `AttentionProvider.test.tsx` 把逻辑在测试里内联复刻了一遍（测的是复刻版），
 * 故这里另起文件测**真实 provider**。
 */

const { playPingMock } = vi.hoisted(() => ({ playPingMock: vi.fn() }))
vi.mock('../../utils/audioFeedback', () => ({ playPing: playPingMock }))

class MockNotification {
  static permission: NotificationPermission = 'default'
  static instances: MockNotification[] = []
  title: string
  body: string
  constructor(title: string, options?: NotificationOptions) {
    this.title = title
    this.body = options?.body ?? ''
    MockNotification.instances.push(this)
  }
}

const SESSION: Session = {
  id: 's1',
  project_id: 'p1',
  workspace_path: '/repo',
  name: '我的会话',
  tmux_session_name: 'omni-s1',
  hook_enabled: false,
  created_at: '2026-10-21T00:00:00Z',
  runtime_kind: 'acp',
}

describe('AttentionProvider → 桌面通知', () => {
  let container: HTMLDivElement
  let root: Root
  let attention: AttentionContextValue | null = null

  function Consumer() {
    attention = useAttention()
    return null
  }

  function mount() {
    act(() => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <AttentionProvider>
            <Consumer />
          </AttentionProvider>
        </I18nextProvider>,
      )
    })
  }

  beforeEach(async () => {
    await i18n.changeLanguage('en')
    playPingMock.mockClear()
    MockNotification.permission = 'granted'
    MockNotification.instances = []
    vi.stubGlobal('Notification', MockNotification)
    resetDesktopNotificationState()
    useAppStore.setState({
      desktopNotificationEnabled: true,
      sessions: { p1: [SESSION] },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    attention = null
    mount()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    resetDesktopNotificationState()
  })

  it('非当前会话的事件 → 发桌面通知，内容只有会话名 + 事件类型', async () => {
    act(() => attention!.fire('s1', 's1', 'done'))
    await vi.waitFor(() => expect(MockNotification.instances).toHaveLength(1))
    expect(MockNotification.instances[0].title).toBe('我的会话')
    expect(MockNotification.instances[0].body).toBe('OmniTerm · Finished')
    // D2：不含 agent 回复正文（这里只发会话名与事件类型）。
    expect(MockNotification.instances[0].body).not.toContain('reply')
  })

  it('D7：桌面通知已启用且已授权时不再叠加自己的 ping 声', async () => {
    act(() => attention!.fire('s1', 's1', 'done'))
    await vi.waitFor(() => expect(MockNotification.instances).toHaveLength(1))
    expect(playPingMock).not.toHaveBeenCalled()
  })

  it('D6：用户正盯着该会话时不发通知（也不响 ping）', () => {
    act(() => attention!.setActive('s1'))
    act(() => attention!.fire('s1', 's1', 'done'))
    expect(MockNotification.instances).toHaveLength(0)
    expect(playPingMock).not.toHaveBeenCalled()
  })

  it('标签页隐藏时（用户已切到别的应用）即便会话是当前会话也发通知', async () => {
    // ACP 的 WS 只连当前会话 —— 回合结束的到达时刻，用户往往正看着该会话，
    // 但标签页已隐藏（他去了别的应用）。此时「非当前会话」判据会误杀主场景。
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    try {
      act(() => attention!.setActive('s1'))
      act(() => attention!.fire('s1', 's1', 'done'))
      await vi.waitFor(() => expect(MockNotification.instances).toHaveLength(1))
      expect(MockNotification.instances[0].title).toBe('我的会话')
    } finally {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true })
    }
  })

  it('未启用开关时维持现状：响 ping、不发桌面通知', () => {
    useAppStore.setState({ desktopNotificationEnabled: false })
    act(() => attention!.fire('s1', 's1', 'done'))
    expect(playPingMock).toHaveBeenCalledTimes(1)
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('浏览器未授权时降级为只有 ping（不假装通知可用）', () => {
    MockNotification.permission = 'default'
    act(() => attention!.fire('s1', 's1', 'error'))
    expect(playPingMock).toHaveBeenCalledTimes(1)
    expect(MockNotification.instances).toHaveLength(0)
  })
})
