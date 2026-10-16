import {
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from 'react'

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

// ── Provider ───────────────────────────────────────────

export function AttentionProvider({ children }: { children: ReactNode }) {
  const [alertsMap, setAlertsMap] = useState<Map<string, AttentionAlert>>(
    new Map()
  )
  // Track which sessions the user has acknowledged
  const activeSessionsRef = useRef<Set<string>>(new Set())
  // Suppress sound for the active session
  const activeSessionKeyRef = useRef<string | null>(null)

  const fire = useCallback(
    (targetId: string, sessionKey: string, reason: AttentionReason) => {
      setAlertsMap((prev) => {
        const next = new Map(prev)
        next.set(sessionKey, { targetId, sessionKey, reason })
        return next
      })

      // Sound + tab flash (unless this is the active session)
      if (activeSessionKeyRef.current !== sessionKey) {
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
