import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  NOTIFY_CHANNEL_NAME,
  desktopNotificationReady,
  detectNotificationCapability,
  notificationBlockReason,
  resetDesktopNotificationState,
  sendDesktopNotification,
  type NotifyClaim,
} from './desktopNotification'

/**
 * 桌面通知工具的测试（F07 / 计划 `2026-10-21-browser-desktop-notification.md`）。
 *
 * jsdom 没有 `Notification` 实现（`window.isSecureContext` 也是 `undefined`），
 * 故按计划 Phase 4 的要求 stub 全局；能力判定的**判据顺序**（先看构造器在不在，
 * 再看权限，`isSecureContext` 只用于解释原因）正是这里要钉住的东西。
 */

class MockNotification {
  static permission: NotificationPermission = 'default'
  static instances: MockNotification[] = []
  /** 构造时抛错（模拟浏览器拒绝/环境异常）。 */
  static throwOnConstruct = false

  title: string
  body: string

  constructor(title: string, options?: NotificationOptions) {
    if (MockNotification.throwOnConstruct) throw new Error('notification blocked')
    this.title = title
    this.body = options?.body ?? ''
    MockNotification.instances.push(this)
  }
}

function stubNotification(permission: NotificationPermission) {
  MockNotification.permission = permission
  MockNotification.instances = []
  MockNotification.throwOnConstruct = false
  vi.stubGlobal('Notification', MockNotification)
}

describe('desktopNotification', () => {
  beforeEach(() => {
    resetDesktopNotificationState()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetDesktopNotificationState()
  })

  describe('能力探测（D3：判据顺序不可颠倒）', () => {
    it('环境没有 Notification 构造器 → blocked', () => {
      // jsdom 默认就没有 Notification（此断言同时守住「非安全上下文」场景：
      // 真实浏览器在非安全上下文里同样不暴露构造器）。
      expect('Notification' in window).toBe(false)
      expect(detectNotificationCapability()).toBe('blocked')
    })

    it('权限已授予 → supported', () => {
      stubNotification('granted')
      expect(detectNotificationCapability()).toBe('supported')
      expect(desktopNotificationReady()).toBe(true)
    })

    it('用户已拒绝 → denied', () => {
      stubNotification('denied')
      expect(detectNotificationCapability()).toBe('denied')
      expect(desktopNotificationReady()).toBe(false)
    })

    it('尚未表态 → default', () => {
      stubNotification('default')
      expect(detectNotificationCapability()).toBe('default')
      expect(desktopNotificationReady()).toBe(false)
    })

    it('isSecureContext 只用于解释原因，不作独立否决', () => {
      stubNotification('granted')
      Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
      // 构造器在 → 仍判 supported（只有浏览器真的会不提供时才 blocked）。
      expect(detectNotificationCapability()).toBe('supported')
      expect(notificationBlockReason(detectNotificationCapability())).toBeNull()
    })

    it('blocked 时给出原因：非安全上下文 vs 环境不支持', () => {
      Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
      expect(notificationBlockReason('blocked')).toBe('insecure-context')
      Object.defineProperty(window, 'isSecureContext', { value: undefined, configurable: true })
      expect(notificationBlockReason('blocked')).toBe('unsupported')
      expect(notificationBlockReason('denied')).toBeNull()
    })
  })

  describe('发送', () => {
    it('权限未授予时不构造通知（静默降级，不打断主链路）', async () => {
      stubNotification('default')
      const sent = await sendDesktopNotification({ title: '会话', body: '已完成', dedupKey: 's1|done' })
      expect(sent).toBe(false)
      expect(MockNotification.instances).toHaveLength(0)
    })

    it('已授权时发出通知，标题与正文按传入内容', async () => {
      stubNotification('granted')
      const sent = await sendDesktopNotification({ title: '我的会话', body: 'OmniTerm · 已完成', dedupKey: 's1|done' })
      expect(sent).toBe(true)
      expect(MockNotification.instances).toHaveLength(1)
      expect(MockNotification.instances[0].title).toBe('我的会话')
      expect(MockNotification.instances[0].body).toBe('OmniTerm · 已完成')
    })

    it('构造器抛错 → 记日志并静默跳过（D9），不影响调用方', async () => {
      stubNotification('granted')
      MockNotification.throwOnConstruct = true
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const sent = await sendDesktopNotification({ title: '会话', body: '出错', dedupKey: 's1|error' })
      expect(sent).toBe(false)
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('去重（D5）', () => {
    it('同一去重键在短窗口内只发一次', async () => {
      stubNotification('granted')
      const first = await sendDesktopNotification({ title: '会话', body: '已完成', dedupKey: 's1|done' })
      const second = await sendDesktopNotification({ title: '会话', body: '已完成', dedupKey: 's1|done' })
      expect(first).toBe(true)
      expect(second).toBe(false)
      expect(MockNotification.instances).toHaveLength(1)
    })

    it('不同去重键互不影响', async () => {
      stubNotification('granted')
      await sendDesktopNotification({ title: '会话', body: '已完成', dedupKey: 's1|done' })
      const other = await sendDesktopNotification({ title: '会话', body: '出错', dedupKey: 's1|error' })
      expect(other).toBe(true)
      expect(MockNotification.instances).toHaveLength(2)
    })

    it('别的标签页先声明 → 本标签页静默（先到者发、后到者静默）', async () => {
      stubNotification('granted')
      // 先发一次把频道建起来（频道是惰性创建的，后建的频道收不到历史消息）。
      await sendDesktopNotification({ title: '会话', body: '已完成', dedupKey: 'warm|done' })
      // 模拟另一个标签页：更早的声明（同键）。
      const peer = new BroadcastChannel(NOTIFY_CHANNEL_NAME)
      const claim: NotifyClaim = { kind: 'claim', key: 's1|done', ts: Date.now() - 500, id: 'peer-tab' }
      peer.postMessage(claim)
      const sent = await sendDesktopNotification({ title: '会话', body: '已完成', dedupKey: 's1|done' })
      peer.close()
      expect(sent).toBe(false)
      expect(MockNotification.instances).toHaveLength(1) // 只有预热那一条
    })
  })
})
