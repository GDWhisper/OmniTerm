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
  restore: () => void
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
  type: 'session_update' | 'prompt_done' | 'prompt_error' | 'error' | 'replay_start' | 'replay_end'
  code?: string
  data?: SessionUpdateFrame
  stop_reason?: string
  message?: string
}

/**
 * Vendor-specific meta keys that carry agent-phase info. Kept at module
 * scope so adding a second vendor (claude-agent-acp, etc.) is a local
 * change instead of branches scattered through `onmessage`.
 */
const VENDOR_AGENT_PHASE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['codebuddy.ai/agentPhase', 'phase'],
]

/**
 * Vendor wire-format → canonical shape adapters. Each entry matches one
 * flat-discriminator pattern and rewrites it to the externally-tagged
 * `{ VariantName: { ...fields } }` shape that `extractTextChunk` / the
 * classifier expect. New ACP-speaking agents add one entry here.
 */
const SESSION_UPDATE_ADAPTERS: ReadonlyArray<{
  match: (obj: Record<string, unknown>) => boolean
  rewrite: (obj: Record<string, unknown>) => Record<string, unknown>
}> = [
  {
    // Codebuddy: `{ sessionUpdate: "agent_message_chunk", content, messageId }`
    match: (obj) => typeof obj['sessionUpdate'] === 'string',
    rewrite: (obj) => {
      const variant = String(obj['sessionUpdate'])
      const canonicalKey = snakeToPascal(variant)
      const fields: Record<string, unknown> = {}
      for (const k of Object.keys(obj)) if (k !== 'sessionUpdate') fields[k] = obj[k]
      return { [canonicalKey]: fields }
    },
  },
]

function snakeToPascal(s: string): string {
  return s
    .split('_')
    .map((p) => (p ? p[0].toUpperCase() + p.slice(1) : p))
    .join('')
}

function normalizeSessionUpdate(update: unknown): unknown {
  if (!update || typeof update !== 'object') return update
  const obj = update as Record<string, unknown>
  for (const { match, rewrite } of SESSION_UPDATE_ADAPTERS) {
    if (match(obj)) return rewrite(obj)
  }
  return update
}

/**
 * Extract text delta from a canonical SessionUpdate when it's an
 * `AgentMessageChunk` variant, or null for other variants. Assumes the
 * input has already been routed through `normalizeSessionUpdate`.
 */
function extractTextChunk(update: unknown): string | null {
  if (!update || typeof update !== 'object') return null
  const obj = update as Record<string, unknown>
  const chunk = obj['AgentMessageChunk']
  if (!chunk || typeof chunk !== 'object') return null
  const content = (chunk as Record<string, unknown>)['content']
  if (content && typeof content === 'object') {
    const textObj =
      (content as Record<string, unknown>)['Text'] ??
      (content as Record<string, unknown>)['text']
    if (textObj && typeof textObj === 'object') {
      const text = (textObj as Record<string, unknown>)['text']
      if (typeof text === 'string') return text
    }
    const text = (content as Record<string, unknown>)['text']
    if (typeof text === 'string') return text
  }
  const flatText = (chunk as Record<string, unknown>)['text']
  return typeof flatText === 'string' ? flatText : null
}

type SessionUpdateAction =
  | { kind: 'appendText'; text: string }
  | { kind: 'setMode'; mode: string }
  | { kind: 'upsertTool'; name: string; status: string }
  | { kind: 'pushSystem'; label: string }
  | { kind: 'drop' }

const DROP_VARIANTS: ReadonlySet<string> = new Set([
  'SessionInfoUpdate', 'session_info_update',
  'UsageUpdate', 'usage_update',
  'AvailableCommandsUpdate', 'available_commands_update',
])

const TOOL_VARIANTS: ReadonlySet<string> = new Set([
  'ToolCall', 'tool_call',
  'ToolCallUpdate', 'tool_call_update',
])

function extractToolInfo(update: unknown, variant: string): { name: string; status: string } | null {
  if (!update || typeof update !== 'object') return null
  const obj = update as Record<string, unknown>
  const inner = obj[variant]
  const source = inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : obj
  const name = source['title'] ?? source['name'] ?? source['toolName']
  if (typeof name !== 'string' || !name) return null
  const statusRaw = source['status']
  const status = typeof statusRaw === 'string' ? statusRaw
    : variant === 'ToolCallUpdate' || variant === 'tool_call_update' ? 'updating'
    : 'running'
  return { name, status }
}

/**
 * Decide what the chat store should do with a canonical SessionUpdate.
 *
 * - `appendText` — AgentMessageChunk text delta
 * - `setMode` — agent-phase / CurrentModeUpdate → mode chip
 * - `upsertTool` — ToolCall / ToolCallUpdate → aggregated "tool activity" block
 * - `pushSystem` — render as `[label]` system event (Plan, …)
 * - `drop` — low-signal noise (usage counters, title bumps); the hook
 *   still emits a `console.debug` in dev so nothing is silently lost
 */
function classifySessionUpdate(update: unknown): SessionUpdateAction {
  if (!update || typeof update !== 'object') return { kind: 'drop' }
  const obj = update as Record<string, unknown>

  const text = extractTextChunk(update)
  if (text !== null) return { kind: 'appendText', text }

  const meta = obj['_meta']
  if (meta && typeof meta === 'object') {
    for (const [metaKey, phaseField] of VENDOR_AGENT_PHASE_KEYS) {
      const block = (meta as Record<string, unknown>)[metaKey]
      if (block && typeof block === 'object') {
        const phase = (block as Record<string, unknown>)[phaseField]
        if (typeof phase === 'string') return { kind: 'setMode', mode: phase }
      }
    }
  }

  const keys = Object.keys(obj)
  const variant = keys.length === 1 ? keys[0] : 'update'
  if (variant === 'CurrentModeUpdate' || variant === 'current_mode_update') {
    const inner = obj[variant]
    const mode = inner && typeof inner === 'object' ? (inner as Record<string, unknown>)['mode'] : undefined
    if (typeof mode === 'string') return { kind: 'setMode', mode }
  }

  if (TOOL_VARIANTS.has(variant)) {
    const info = extractToolInfo(update, variant)
    if (info) return { kind: 'upsertTool', name: info.name, status: info.status }
  }

  if (DROP_VARIANTS.has(variant)) return { kind: 'drop' }

  return { kind: 'pushSystem', label: variant }
}

export function useAcpChat({ sessionId }: UseAcpChatOptions): UseAcpChatResult {
  const [connectionState, setConnectionState] = useState<AcpConnectionState>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  // Stable session ref avoids effect re-runs when the caller re-renders
  // with the same id.
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId
  const isReplaying = useRef(false)
  const suppressReplay = useRef(false)

  const appendChunk = useChatStore((s) => s.appendChunk)
  const pushSystemEvent = useChatStore((s) => s.pushSystemEvent)
  const upsertToolActivity = useChatStore((s) => s.upsertToolActivity)
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

    setConnectionState('connecting')
    setError(sessionId, null)

    const ws = new WebSocket(url)
    wsRef.current = ws
    let disposed = false

    ws.onopen = () => {
      if (disposed) {
        ws.close()
        return
      }
      setConnectionState('connected')
      const sid = sessionIdRef.current
      if (sid) setError(sid, null)
    }

    ws.onmessage = (ev) => {
      const sid = sessionIdRef.current
      if (!sid) return
      let frame: ServerFrame
      try {
        frame =
          typeof ev.data === 'string'
            ? JSON.parse(ev.data)
            : { type: 'error', message: 'non-text frame' }
      } catch {
        setError(sid, 'malformed frame')
        return
      }
      if (import.meta.env.DEV) {
        console.debug('[ACP RX]', frame.type, ev.data)
      }
      switch (frame.type) {
        case 'session_update': {
          if (isReplaying.current && suppressReplay.current) break
          const raw = frame.data?.update
          const canonical = normalizeSessionUpdate(raw)
          const action = classifySessionUpdate(canonical)
          switch (action.kind) {
            case 'appendText':
              appendChunk(sid, action.text, raw)
              break
            case 'setMode':
              useChatStore.getState().setMode(sid, action.mode)
              break
            case 'upsertTool':
              upsertToolActivity(sid, action.name, action.status)
              break
            case 'pushSystem':
              pushSystemEvent(sid, action.label, raw)
              break
            case 'drop':
              if (import.meta.env.DEV) console.debug('[ACP drop]', raw)
              break
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
          if (frame.code === 'session_not_found') {
            useChatStore.getState().markEnded(sid)
          } else {
            setError(sid, frame.message ?? 'server error')
          }
          break
        case 'replay_start': {
          isReplaying.current = true
          const msgs = useChatStore.getState().states[sid]?.messages
          suppressReplay.current = !!(msgs && msgs.length > 0)
          break
        }
        case 'replay_end':
          isReplaying.current = false
          suppressReplay.current = false
          useChatStore.getState().clearEnded(sid)
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
      }
    }

    return () => {
      disposed = true
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
      if (wsRef.current === ws) {
        wsRef.current = null
      }
    }
  }, [sessionId, appendChunk, pushSystemEvent, upsertToolActivity, markDone, markError, setError])

  const sendPrompt = useCallback((text: string) => {
    const ws = wsRef.current
    const sid = sessionIdRef.current
    const trimmed = text.trim()
    if (!ws || ws.readyState !== WebSocket.OPEN || !sid || !trimmed) return
    useChatStore.getState().beginPrompt(sid)
    useChatStore.getState().addUserMessage(sid, trimmed)
    ws.send(JSON.stringify({ type: 'prompt', text: trimmed }))
  }, [])

  const cancel = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'cancel' }))
  }, [])

  const restore = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'load_session' }))
  }, [])

  return { connectionState, sendPrompt, cancel, restore }
}
