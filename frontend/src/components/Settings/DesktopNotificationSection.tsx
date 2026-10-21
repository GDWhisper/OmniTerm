import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import {
  detectNotificationCapability,
  notificationBlockReason,
  type DesktopNotificationCapability,
} from '../../utils/desktopNotification'
import { SectionTitle } from './toggleRow'
import { btnBase } from './settingsStyles'

/**
 * 设置 → 通知 → 桌面通知开关（F07）。
 *
 * 面板承担两件事，**必须分开陈述**，否则就是「用户以为开了、其实没生效」：
 *
 * 1. **开关 = 用户意图**（localStorage，`appStore.desktopNotificationEnabled`）：
 *    要不要收桌面通知。开启时在**用户手势内**请求浏览器权限（D4）——浏览器只在
 *    交互上下文里允许弹权限框，自动在启动时请求会被直接忽略。
 * 2. **状态行 = 现实**（浏览器权限，每次现读不缓存）：能力 / 权限态如实展示，
 *    被拒时给「重新请求」入口，环境不提供时写明原因（如「当前以 http 访问非本机
 *    地址，浏览器只在安全上下文提供桌面通知」）。
 *
 * 能力探测口径见 `utils/desktopNotification.ts`（D3：判据以 `'Notification' in
 * window` 为主，`isSecureContext` 只用于解释原因）。
 */
export function DesktopNotificationSection() {
  const { t } = useTranslation()
  const enabled = useAppStore((s) => s.desktopNotificationEnabled)
  const setEnabled = useAppStore((s) => s.setDesktopNotificationEnabled)
  const [capability, setCapability] = useState<DesktopNotificationCapability>(() =>
    detectNotificationCapability(),
  )

  // 权限可能在浏览器里被改（用户在站点设置里放行/撤销）——面板挂载时现读一次，
  // 交互后再读一次（下面的 handler）。
  useEffect(() => {
    setCapability(detectNotificationCapability())
  }, [])

  const blocked = capability === 'blocked'
  const denied = capability === 'denied'

  /** 开启开关：在用户手势内请求权限（D4）。拒绝不吞——状态行如实展示。 */
  const handleToggle = async () => {
    if (enabled) {
      setEnabled(false)
      return
    }
    if (capability === 'default') {
      try {
        await Notification.requestPermission()
      } catch (err) {
        console.warn('[desktopNotification] 请求通知权限失败:', err)
      }
    }
    setCapability(detectNotificationCapability())
    // 开关表达用户意图：即便权限被拒也记为「用户想要」，由状态行如实告知
    // 「浏览器已拒绝」——把开关强行弹回 OFF 只会让用户更困惑。
    setEnabled(true)
  }

  /** 权限被拒后的重试入口（D4）：浏览器可能仍不弹框（Chrome denied 后不再询问），
   *  此时状态行会引导用户去站点设置手动放行。 */
  const handleRequestPermission = async () => {
    try {
      await Notification.requestPermission()
    } catch (err) {
      console.warn('[desktopNotification] 重新请求通知权限失败:', err)
    }
    setCapability(detectNotificationCapability())
  }

  const statusKey = (() => {
    if (capability === 'supported') return 'settings.desktopNotificationState.supported'
    if (capability === 'denied') return 'settings.desktopNotificationState.denied'
    if (capability === 'default') return 'settings.desktopNotificationState.default'
    return notificationBlockReason(capability) === 'insecure-context'
      ? 'settings.desktopNotificationState.insecure'
      : 'settings.desktopNotificationState.unsupported'
  })()

  return (
    <section className="space-y-2">
      <SectionTitle>{t('settings.desktopNotification')}</SectionTitle>
      <button
        onClick={handleToggle}
        disabled={blocked}
        style={{
          ...btnBase,
          fontSize: 12,
          padding: '5px 8px',
          display: 'flex', alignItems: 'center', gap: 6,
          ...(enabled ? { borderColor: 'var(--accent)', color: 'var(--accent)', background: 'var(--accent-10)' } : {}),
          ...(blocked ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
        }}
      >
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: enabled ? 'var(--success)' : 'var(--text-dim)',
          transition: 'background 0.15s ease',
        }} />
        {enabled ? t('settings.on') : t('settings.off')}
      </button>
      <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
        {t('settings.desktopNotificationHint')}
      </p>
      <p
        style={{
          fontSize: 11,
          lineHeight: 1.5,
          color: denied || blocked ? 'var(--danger)' : 'var(--text-faint)',
        }}
      >
        {t(statusKey)}
      </p>
      {denied && (
        <>
          <button
            onClick={handleRequestPermission}
            style={{ ...btnBase, fontSize: 12, padding: '5px 8px' }}
          >
            {t('settings.desktopNotificationRequest')}
          </button>
          <p style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.5 }}>
            {t('settings.desktopNotificationDeniedHint')}
          </p>
        </>
      )}
    </section>
  )
}
