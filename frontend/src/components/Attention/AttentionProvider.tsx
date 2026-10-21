import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'

// ── Types ──────────────────────────────────────────────

export type AttentionReason = 'decision' | 'done' | 'error'

export interface AttentionAlert {
  targetId: string
  sessionKey: string // "<sessionId>" or "<tmuxName>" — unique per session
  reason: AttentionReason
}

export interface AttentionContextValue {
  /** Active alerts map: sessionKey → reason */
  alerts: Map<string, AttentionAlert>
  /** Fire an attention notification for a session */
  fire: (targetId: string, sessionKey: string, reason: AttentionReason) => void
  /** Clear an alert for a specific session */
  clearAlert: (sessionKey: string) => void
  /** Mark a session as being actively viewed (clears its alert) */
  setActive: (sessionKey: string) => void
  /** Check if a session has an active reason */
  reasonFor: (sessionKey: string) => AttentionReason | undefined
}

import { AttentionContext } from '../../hooks/useAttention'
import { playPing } from '../../utils/audioFeedback'
import { useAppStore } from '../../stores/appStore'
import { useAgentStore } from '../../stores/agentStore'
import { sessionDisplayName } from '../../utils/sessionDisplayName'
import { findSessionById } from '../../utils/sessionLookup'
import {
  desktopNotificationReady,
  sendDesktopNotification,
} from '../../utils/desktopNotification'

// ── Tab title flash ────────────────────────────────────

const NORMAL_TITLE = document.title
const ALERT_TITLE = '\u{1F514} OmniTerm'

let flashInterval: ReturnType<typeof setInterval> | null = null
let flashActive = false

function startTabFlash() {
  if (flashActive) return
  flashActive = true

  let toggle = false
  flashInterval = setInterval(() => {
    if (!document.hidden) {
      stopTabFlash()
      return
    }
    document.title = toggle ? ALERT_TITLE : NORMAL_TITLE
    toggle = !toggle
  }, 1000)
}

function stopTabFlash() {
  if (flashInterval) {
    clearInterval(flashInterval)
    flashInterval = null
  }
  flashActive = false
  document.title = NORMAL_TITLE
}

// Listen for visibility changes
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      stopTabFlash()
    }
  })
}

// ── Desktop notification (F07) ───────────────────────────

/**
 * 桌面通知的文案组装 + 发送（计划 `2026-10-21-browser-desktop-notification.md`）。
 *
 * 放在组件外：`fire` 的 deps 为空（长寿命回调），语言 / 会话表 / agent 注册表
 * 都必须在**调用那一刻**现读——闭包捕获会拿到旧值（语言切换后仍发旧语言的文案）。
 *
 * 内容口径（D2）：标题=会话显示名，正文=「OmniTerm · 事件类型」——
 * **不含 agent 回复正文**（OS 通知在锁屏明文显示，正文可能含代码/路径/凭据）。
 */
function notifyDesktop(
  targetId: string,
  reason: AttentionReason,
  t: (key: string, params?: Record<string, unknown>) => string,
): void {
  const appState = useAppStore.getState()
  const session = findSessionById(appState.sessions, targetId)
  const agents = useAgentStore.getState().agents
  const unnamed = t('sidebar.unnamed')
  const title = session ? sessionDisplayName(session, agents, unnamed) : unnamed
  const body = t('notification.body', { event: t(`notification.event.${reason}`) })
  void sendDesktopNotification({ title, body, dedupKey: `${targetId}|${reason}` })
}

// ── Provider ───────────────────────────────────────────

export function AttentionProvider({ children }: { children: ReactNode }) {
  const [alertsMap, setAlertsMap] = useState<Map<string, AttentionAlert>>(
    new Map()
  )
  // Track which sessions the user has acknowledged
  const activeSessionsRef = useRef<Set<string>>(new Set())
  // Suppress sound for the active session
  const activeSessionKeyRef = useRef<string | null>(null)
  // 桌面通知文案要用当前界面语言，但 `fire` 是长寿命回调（deps 为空）——
  // 闭包捕获的 `t` 会随语言切换变旧，故用 ref 存最新值（同 useFileDrag 的 optsRef 范式）。
  const { t } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t

  const fire = useCallback(
    (targetId: string, sessionKey: string, reason: AttentionReason) => {
      setAlertsMap((prev) => {
        const next = new Map(prev)
        next.set(sessionKey, { targetId, sessionKey, reason })
        return next
      })

      // Sound + tab flash (unless this is the active session)
      //
      // 桌面通知（F07 / 计划 D6、D7）：
      // - D6：只对「用户当前不在看的会话」发——**判定以「用户是否在眼前」为准**：
      //   ① 非当前会话（他在看别的会话）；② 当前会话但**标签页隐藏**（他切到别的
      //   应用/窗口了，标题闪的目标签栏在别的窗口里根本看不见）。
      //   只用「非当前会话」一条会误杀主场景：ACP 的 WS 只连当前会话（切换会话即
      //   拆除），故 ACP 回合的 done/decision 事件**只在用户正看着该会话时到达**，
      //   而「用户正看着会话」时桌面通知又被 D6 字面判据挡掉——功能在主场景里
      //   等于永不触发。`document.hidden` 正是本仓既有的「用户不在眼前」信号
      //   （tab 标题闪烁用的就是它），故在此开口子。
      // - D7：桌面通知自带系统音效，**已启用且已授权时不再叠加自己的 ping**（双响）；
      //   未启用/未授权时维持现状铃声。
      // 开关（用户意图，读 store）与权限（浏览器状态，现读不缓存）都要满足。
      const desktopReady =
        useAppStore.getState().desktopNotificationEnabled && desktopNotificationReady()
      const isActiveSession = activeSessionKeyRef.current === sessionKey
      if (isActiveSession) {
        // 当前会话：既有语义不响 ping（他在看，无需打扰）。
        if (document.hidden && desktopReady) {
          void notifyDesktop(targetId, reason, tRef.current)
        }
      } else if (desktopReady) {
        void notifyDesktop(targetId, reason, tRef.current)
      } else {
        playPing()
      }
      if (document.hidden) {
        startTabFlash()
      }
    },
    []
  )

  const clearAlert = useCallback((sessionKey: string) => {
    setAlertsMap((prev) => {
      // 无此项时原样返回（引用不变）：focus / visibilitychange 每个来回都会走到
      // 清除路径，无 guard 时每次都造新 Map，触发整个 App 的无谓重渲染。
      if (!prev.has(sessionKey)) return prev
      const next = new Map(prev)
      next.delete(sessionKey)
      return next
    })
  }, [])

  const setActive = useCallback((sessionKey: string) => {
    activeSessionKeyRef.current = sessionKey
    activeSessionsRef.current.add(sessionKey)
    // Clear alert when user views the session
    clearAlert(sessionKey)
  }, [clearAlert])

  // 用户「回到正在查看的会话」时清除该会话的提醒：提醒的语义是「把用户叫回来」，
  // 页面重新可见（切标签页 / 切回浏览器窗口）或窗口重新聚焦（双屏焦点在别窗）时
  // 呼叫已送达——与 tab 标题闪烁在 visible 时立即停止同一口径（2026-08-06 起
  // 「发送新 prompt 即清」同属「用户已知晓最新状况」）。此前只有点击侧栏会话行 /
  // 发消息 / 响应审批能清提醒：用户不切换会话（切走窗口再回来）时，提醒没有任何
  // 清除路径，永久挂在侧栏。
  useEffect(() => {
    const clearCurrentOnReturn = () => {
      if (document.hidden) return
      const st = useAppStore.getState()
      // 移动端只有 terminal 页签渲染会话视图；sessions/files 页签下用户在看
      // 列表 / 文件面板，并未查看该会话内容，回来时不得替他「已读」。
      if (st.isMobile && st.activeTab !== 'terminal') return
      if (st.activeSessionId) clearAlert(st.activeSessionId)
    }
    document.addEventListener('visibilitychange', clearCurrentOnReturn)
    window.addEventListener('focus', clearCurrentOnReturn)
    return () => {
      document.removeEventListener('visibilitychange', clearCurrentOnReturn)
      window.removeEventListener('focus', clearCurrentOnReturn)
    }
  }, [clearAlert])

  const reasonFor = useCallback(
    (sessionKey: string): AttentionReason | undefined => {
      return alertsMap.get(sessionKey)?.reason
    },
    [alertsMap]
  )

  // Stop tab flash when alerts are all cleared
  useEffect(() => {
    if (alertsMap.size === 0) {
      stopTabFlash()
    }
  }, [alertsMap.size])

  const value: AttentionContextValue = {
    alerts: alertsMap,
    fire,
    clearAlert,
    setActive,
    reasonFor,
  }

  return (
    <AttentionContext.Provider value={value}>
      {children}
    </AttentionContext.Provider>
  )
}

// ── Hook ───────────────────────────────────────────────
// useAttention is defined in src/hooks/useAttention.ts (kept out of this
// component file so react-refresh fast-refresh works on the provider).
