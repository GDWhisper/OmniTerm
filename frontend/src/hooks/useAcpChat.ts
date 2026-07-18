import { useEffect, useRef, useCallback, useState } from 'react'
import { useChatStore } from '../stores/chatStore'

/**
 * Hook owning the ACP chat WebSocket lifecycle for a single session.
 *
 * Responsibilities:
 *   - Open `/api/v1/ws/acp/{session_id}` on mount / session change
 *   - Close on unmount
 *   - Translate server frames into `chatStore` actions
 *   - Expose `sendPrompt` / `cancel` / `connected` to the view
 *
 * The store (`chatStore`) is state-only; this hook owns the socket and
 * is the only writer for that session's slice. This separation lets the
 * view render against the store without re-opening the socket on every
 * re-render, and lets future permission-request flows (Phase 4b) hook
 * in here without disturbing state accumulation.
 *
 * Phase 4a: consumes `session_update` (only `AgentMessageChunk` handled
 * specifically; other variants pushed as generic system events) and
 * `prompt_done` / `prompt_error` / `error`. `permission_request` is a
 * Phase 4b addition.
 */

export type AcpConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

interface UseAcpChatOptions {
  sessionId: string | null
}

interface UseAcpChatResult {
  connectionState: AcpConnectionState
  sendPrompt: (text: string) => void
  cancel: () => void
}

/**
 * Shape of a `session_update` frame's `data` field — a serde-serialized
 * `SessionNotification` from the `agent-client-protocol` crate. The
 * exact JSON representation depends on the crate's tagged-enum serde,
 * which we discover at runtime (hence the loose `unknown` typing for
 * the inner update). Phase 5 will tighten this once we have fixture
 * captures from a real agent.
 */
interface SessionUpdateFrame {
  session_id?: unknown
  update?: unknown
}

interface ServerFrame {
  type: 'session_update' | 'prompt_done' | 'prompt_error' | 'error'
  data?: SessionUpdateFrame
  stop_reason?: string
  message?: string
}

/**
 * Extract the text delta from a SessionUpdate when it's an
 * `AgentMessageChunk` variant. Returns null for other variants. The
 * crate's serde emits externally-tagged enums by default:
 * `{ "AgentMessageChunk": { "content": { "Text": { "text": "..." } } } }`
 * — we try both the nested shape and a flat `text` field so Phase 4
 * doesn't block on pinning the exact wire format.
 */
function extractTextChunk(update: unknown): string | null {
  if (!update || typeof update !== 'object') return null
  const obj = update as Record<string, unknown>

  // Flat discriminator (codebuddy): { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "..." } }
  if (obj['sessionUpdate'] === 'agent_message_chunk') {
    const content = obj['content']
    if (content && typeof content === 'object') {
      const c = content as Record<string, unknown>
      if (c['type'] === 'text' && typeof c['text'] === 'string') return c['text']
      // Looser fallback: any string `text` regardless of `type`
      if (typeof c['text'] === 'string') return c['text']
    }
  }

  // Externally-tagged: { "AgentMessageChunk": { ... } }
  const chunk = obj['AgentMessageChunk'] ?? obj['agent_message_chunk']
  if (chunk && typeof chunk === 'object') {
    const content = (chunk as Record<string, unknown>)['content']
    if (content && typeof content === 'object') {
      const textObj = (content as Record<string, unknown>)['Text']
        ?? (content as Record<string, unknown>)['text']
      if (textObj && typeof textObj === 'object') {
        const text = (textObj as Record<string, unknown>)['text']
        if (typeof text === 'string') return text
      }
    }
    const flatText = (chunk as Record<string, unknown>)['text']
    if (typeof flatText === 'string') return flatText
  }

  // Flat shape fallback
  const flatText = obj['text']
  return typeof flatText === 'string' ? flatText : null
}

/**
 * Pull a coarse discriminator out of a SessionUpdate for the system-
 * event fallback path. Used so the chat log can at least label a
 * ToolCall / Plan / CurrentModeUpdate even before Phase 5 renders
 * them as rich cards.
 */
function classifyUpdate(update: unknown): string {
  if (!update || typeof update !== 'object') return 'unknown'
  const obj = update as Record<string, unknown>
  // Flat discriminator (codebuddy): `sessionUpdate` names the variant
  if (typeof obj['sessionUpdate'] === 'string') return obj['sessionUpdate']
  const keys = Object.keys(obj)
  if (keys.length === 0) return 'unknown'
  // Externally-tagged enum: single key whose name is the variant
  if (keys.length === 1) return keys[0]
  return 'update'
}

/**
 * Pull the codebuddy agent-phase string out of a `session_info_update`
 * (`_meta["codebuddy.ai/agentPhase"].phase`), or null if absent. Used to
 * drive the mode chip without flooding the chat with system events.
 */
function extractAgentPhase(update: unknown): string | null {
  if (!update || typeof update !== 'object') return null
  const obj = update as Record<string, unknown>
  if (obj['sessionUpdate'] !== 'session_info_update') return null
  const meta = obj['_meta']
  if (!meta || typeof meta !== 'object') return null
  const phaseBlock = (meta as Record<string, unknown>)['codebuddy.ai/agentPhase']
  if (!phaseBlock || typeof phaseBlock !== 'object') return null
  const phase = (phaseBlock as Record<string, unknown>)['phase']
  return typeof phase === 'string' ? phase : null
}

export function useAcpChat({ sessionId }: UseAcpChatOptions): UseAcpChatResult {
  const [connectionState, setConnectionState] = useState<AcpConnectionState>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  // Stable session ref avoids effect re-runs when the caller re-renders
  // with the same id.
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId

  const appendChunk = useChatStore((s) => s.appendChunk)
  const pushSystemEvent = useChatStore((s) => s.pushSystemEvent)
  const markDone = useChatStore((s) => s.markDone)
  const markError = useChatStore((s) => s.markError)
  const setError = useChatStore((s) => s.setError)

  useEffect(() => {
    if (!sessionId) {
      setConnectionState('disconnected')
      return
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/api/v1/ws/acp/${encodeURIComponent(sessionId)}`

    console.info('[ACP effect] START sessionId=', sessionId, 'url=', url)
    setConnectionState('connecting')
    setError(sessionId, null)

    const ws = new WebSocket(url)
    wsRef.current = ws
    console.info('[ACP effect] wsRef assigned readyState=', ws.readyState)

    ws.onopen = () => {
      setConnectionState('connected')
      // Clear any error state accumulated from a prior (StrictMode-killed)
      // mount's `onerror`. Successful open is the authoritative signal that
      // the connection is healthy.
      const sid = sessionIdRef.current
      if (sid) setError(sid, null)
    }

    ws.onmessage = (ev) => {
      const sid = sessionIdRef.current
      if (!sid) return
      console.info('[ACP RX] frame=', typeof ev.data === 'string' ? ev.data.slice(0, 240) : ev.data)
      let frame: ServerFrame
      try {
        frame = typeof ev.data === 'string' ? JSON.parse(ev.data) : { type: 'error', message: 'non-text frame' }
      } catch {
        setError(sid, 'malformed frame')
        return
      }
      switch (frame.type) {
        case 'session_update': {
          const update = frame.data?.update
          const text = extractTextChunk(update)
          if (text) {
            appendChunk(sid, text, update)
          } else {
            const kind = classifyUpdate(update)
            const phase = extractAgentPhase(update)
            if (phase) {
              // Codebuddy emits frequent `session_info_update` frames with
              // `_meta.codebuddy.ai/agentPhase.phase` (idle / preparing /
              // model_requesting / model_streaming / model_done). Routing
              // them to the mode chip keeps the chat stream readable.
              useChatStore.getState().setMode(sid, phase)
            } else if (kind === 'CurrentModeUpdate' || kind === 'current_mode_update') {
              // Phase 4 coarse: pull mode name if present
              const inner = update && typeof update === 'object'
                ? (update as Record<string, unknown>)[Object.keys(update as Record<string, unknown>)[0]]
                : null
              const modeName = inner && typeof inner === 'object'
                ? ((inner as Record<string, unknown>)['mode'] as string | undefined)
                : undefined
              if (modeName) {
                useChatStore.getState().setMode(sid, modeName)
              }
              pushSystemEvent(sid, kind, update)
            } else if (kind !== 'session_info_update' && kind !== 'usage_update') {
              // Skip noisy-but-low-signal frames (title bumps, usage
              // counters). Richer variants (tool_call, plan) still render.
              pushSystemEvent(sid, kind, update)
            }
          }
          break
        }
        case 'prompt_done':
          markDone(sessionIdRef.current ?? '')
          break
        case 'prompt_error':
          markError(sessionIdRef.current ?? '', frame.message ?? 'prompt failed')
          break
        case 'error':
          setError(sid, frame.message ?? 'server error')
          break
      }
    }

    ws.onerror = () => {
      // Only attribute errors to the current socket. StrictMode's killed
      // first-mount socket fires onerror asynchronously AFTER the second
      // mount has replaced wsRef.current — we must not poison the new
      // socket's error state.
      if (wsRef.current !== ws) return
      const sid = sessionIdRef.current
      if (sid) setError(sid, 'WebSocket error')
      setConnectionState('error')
    }

    ws.onclose = () => {
      // Same StrictMode guard as onerror: only the socket that currently
      // owns wsRef may clear it. A late onclose from the killed first-
      // mount socket must not clobber the live second-mount socket.
      if (wsRef.current === ws) {
        setConnectionState('disconnected')
        wsRef.current = null
      } else {
        console.info('[ACP onclose] stale socket ignored (wsRef points at newer socket)')
      }
    }

    return () => {
      console.info('[ACP effect] CLEANUP ws.readyState=', ws.readyState, 'wsRef.current===ws?', wsRef.current === ws)
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
      if (wsRef.current === ws) {
        wsRef.current = null
      }
    }
  }, [sessionId, appendChunk, pushSystemEvent, markDone, markError, setError])

  const sendPrompt = useCallback(
    (text: string) => {
      const ws = wsRef.current
      const sid = sessionIdRef.current
      const trimmed = text.trim()
      console.info(
        '[ACP TX] sendPrompt called text=', trimmed.slice(0, 80),
        'sid=', sid,
        'ws=', ws ? 'present' : 'null',
        'readyState=', ws?.readyState,
      )
      if (!ws || ws.readyState !== WebSocket.OPEN || !sid) {
        console.warn('[ACP TX] bail: ws missing / not OPEN / no sid')
        return
      }
      if (!trimmed) return
      useChatStore.getState().beginPrompt(sid)
      useChatStore.getState().addUserMessage(sid, trimmed)
      ws.send(JSON.stringify({ type: 'prompt', text: trimmed }))
      console.info('[ACP TX] sent')
    },
    [],
  )

  const cancel = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'cancel' }))
  }, [])

  return { connectionState, sendPrompt, cancel }
}
