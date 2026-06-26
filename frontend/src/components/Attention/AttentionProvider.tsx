import React, {
  createContext,
  useContext,
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

const AttentionContext = createContext<AttentionContextValue | null>(null)

// ── Sound playback ─────────────────────────────────────

let audioCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (audioCtx && audioCtx.state !== 'closed') return audioCtx
  try {
    audioCtx = new AudioContext()
    return audioCtx
  } catch {
    return null
  }
}

/** Play a short sine-wave ping (880 Hz, 300ms decay) */
function playPing() {
  const ctx = getAudioContext()
  if (!ctx) return

  // Resume if suspended (autoplay policy)
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }

  try {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.3, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.3)
  } catch {
    // Web Audio not available
  }
}

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

export function useAttention(): AttentionContextValue {
  const ctx = useContext(AttentionContext)
  if (!ctx) {
    throw new Error('useAttention must be used within an AttentionProvider')
  }
  return ctx
}
