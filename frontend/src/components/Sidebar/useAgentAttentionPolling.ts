import { useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useAttention, type AttentionReason } from '../../hooks/useAttention'
import { api } from '../../api/client'

export function useAgentAttentionPolling(activeProjectId: string | null) {
  const setSessions = useAppStore((s) => s.setSessions)
  const attention = useAttention()

  // ── Smart diff: session polling + attention detection ──
  const lastAgentEventRef = useRef<Map<string, string>>(new Map())
  const decisionCandidatesRef = useRef<Set<string>>(new Set())
  const firedWaitingRef = useRef<Set<string>>(new Set())
  const prevAgentStateRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    // 每 3 秒轮询：服务 **tmux** 会话的 agent_state / attention_reason 检测
    // （tmux 无 WS 推送，仍需轮询）。注意：ACP 会话的 `acp_process_alive`
    // 已由后端 WS 的 `process_alive` 事件驱动即时更新（见 useAcpChat），
    // 不再依赖本轮询回流；轮询整体覆盖时 ACP 的 alive 值与推送最终一致，无副作用。
    const interval = setInterval(async () => {
      if (!activeProjectId) return
      try {
        const freshSessions = await api.listSessions(activeProjectId)
        const currentSessionKeys = new Set<string>()

        for (const s of freshSessions) {
          const sessionKey = s.id
          currentSessionKeys.add(sessionKey)

          // Build event key from agent state fields
          const eventKey = [
            s.agent_kind ?? '',
            s.agent_state ?? '',
            s.attention_reason ?? '',
            s.agent_event ?? '',
            s.agent_nonce ?? '',
          ].join(':')

          const lastKey = lastAgentEventRef.current.get(sessionKey)
          if (eventKey && eventKey !== lastKey) {
            lastAgentEventRef.current.set(sessionKey, eventKey)

            const state = s.agent_state
            const reason = s.attention_reason as AttentionReason | undefined
            const prevState = prevAgentStateRef.current.get(sessionKey)

            if (state === 'idle' && reason === 'done') {
              // Done — fire immediately
              attention.fire(s.id, sessionKey, 'done')
            } else if (state === 'idle' && reason === 'error') {
              // Error — fire immediately
              attention.fire(s.id, sessionKey, 'error')
            } else if (state === 'idle' && !reason && prevState === 'running') {
              // 屏幕检测：running → idle 转变即完成（done = idle + 未查看，
              // 查看会话时 AttentionProvider.setActive 清除）
              attention.fire(s.id, sessionKey, 'done')
            } else if (state === 'running') {
              // Running — clear any alert
              attention.clearAlert(sessionKey)
            }
          }

          // Decision debounce（eventKey 不变也要推进：屏幕检测的 waiting 无 nonce 变化）：
          // 连续两轮 waiting 才告警；每个 waiting 周期只告警一次
          if (s.agent_state === 'waiting') {
            if (!firedWaitingRef.current.has(sessionKey)) {
              if (decisionCandidatesRef.current.has(sessionKey)) {
                attention.fire(s.id, sessionKey, 'decision')
                decisionCandidatesRef.current.delete(sessionKey)
                firedWaitingRef.current.add(sessionKey)
              } else {
                decisionCandidatesRef.current.add(sessionKey)
              }
            }
          } else {
            decisionCandidatesRef.current.delete(sessionKey)
            firedWaitingRef.current.delete(sessionKey)
          }

          if (s.agent_state) {
            prevAgentStateRef.current.set(sessionKey, s.agent_state)
          }
        }

        // Clear alerts for sessions that disappeared
        for (const key of lastAgentEventRef.current.keys()) {
          if (!currentSessionKeys.has(key)) {
            attention.clearAlert(key)
            lastAgentEventRef.current.delete(key)
            decisionCandidatesRef.current.delete(key)
            firedWaitingRef.current.delete(key)
            prevAgentStateRef.current.delete(key)
          }
        }

        setSessions(activeProjectId, freshSessions)
      } catch {
        // Quietly ignore poll errors
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [activeProjectId, setSessions, attention])
}
