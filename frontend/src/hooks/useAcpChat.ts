import { useEffect, useRef, useCallback, useState } from 'react'
import { useChatStore, type PlanEntry } from '../stores/chatStore'

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

const VENDOR_AGENT_PHASE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['codebuddy.ai/agentPhase', 'phase'],
]

const SESSION_UPDATE_ADAPTERS: ReadonlyArray<{
  match: (obj: Record<string, unknown>) => boolean
  rewrite: (obj: Record<string, unknown>) => Record<string, unknown>
}> = [
  {
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

function extractContentText(content: unknown): string | null {
  if (!content || typeof content !== 'object') return null
  const c = content as Record<string, unknown>
  const textObj = c['Text'] ?? c['text']
  if (textObj && typeof textObj === 'object') {
    const t = (textObj as Record<string, unknown>)['text']
    if (typeof t === 'string') return t
  }
  if (typeof c['text'] === 'string') return c['text']
  return null
}

function getVariantInner(obj: Record<string, unknown>, variant: string): Record<string, unknown> | null {
  const inner = obj[variant]
  if (inner && typeof inner === 'object') return inner as Record<string, unknown>
  return null
}

// --- Classifier ---

type SessionUpdateAction =
  | { kind: 'appendText'; text: string }
  | { kind: 'appendThought'; text: string }
  | { kind: 'setMode'; mode: string }
  | { kind: 'upsertTool'; toolCallId: string; title: string; status: string; toolKind?: string; content?: string; locations?: string[] }
  | { kind: 'setPlan'; entries: PlanEntry[] }
  | { kind: 'pushSystem'; label: string }
  | { kind: 'drop' }

const DROP_VARIANTS: ReadonlySet<string> = new Set([
  'SessionInfoUpdate', 'session_info_update',
  'UsageUpdate', 'usage_update',
  'AvailableCommandsUpdate', 'available_commands_update',
  'ConfigOptionUpdate', 'config_option_update',
])

const TOOL_VARIANTS: ReadonlySet<string> = new Set([
  'ToolCall', 'tool_call',
  'ToolCallUpdate', 'tool_call_update',
])

const THOUGHT_VARIANTS: ReadonlySet<string> = new Set([
  'AgentThoughtChunk', 'agent_thought_chunk',
])

function classifySessionUpdate(update: unknown): SessionUpdateAction {
  if (!update || typeof update !== 'object') return { kind: 'drop' }
  const obj = update as Record<string, unknown>

  // AgentMessageChunk → text
  const msgChunk = getVariantInner(obj, 'AgentMessageChunk')
  if (msgChunk) {
    const text = extractContentText(msgChunk['content']) ?? (typeof msgChunk['text'] === 'string' ? msgChunk['text'] : null)
    if (text !== null) return { kind: 'appendText', text }
  }

  // AgentThoughtChunk → thought
  const keys = Object.keys(obj)
  const variant = keys.length === 1 ? keys[0] : 'update'
  if (THOUGHT_VARIANTS.has(variant)) {
    const inner = getVariantInner(obj, variant) ?? obj
    const text = extractContentText(inner['content']) ?? (typeof inner['text'] === 'string' ? inner['text'] : null)
    if (text !== null) return { kind: 'appendThought', text }
  }

  // Vendor meta → mode
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

  // CurrentModeUpdate
  if (variant === 'CurrentModeUpdate' || variant === 'current_mode_update') {
    const inner = getVariantInner(obj, variant)
    const mode = inner ? inner['mode'] : undefined
    if (typeof mode === 'string') return { kind: 'setMode', mode }
  }

  // ToolCall / ToolCallUpdate
  if (TOOL_VARIANTS.has(variant)) {
    const inner = getVariantInner(obj, variant) ?? obj
    const title = inner['title'] ?? inner['name'] ?? inner['toolName']
    if (typeof title === 'string' && title) {
      const toolCallId = typeof inner['toolCallId'] === 'string' ? inner['toolCallId'] : title
      const statusRaw = inner['status']
      const status = typeof statusRaw === 'string' ? statusRaw
        : variant === 'ToolCallUpdate' || variant === 'tool_call_update' ? 'updating'
        : 'running'
      const toolKind = typeof inner['kind'] === 'string' ? inner['kind'] : undefined
      const content = typeof inner['content'] === 'string' ? inner['content'] : undefined
      const locations = Array.isArray(inner['locations'])
        ? (inner['locations'] as unknown[]).filter((l): l is string => typeof l === 'string')
        : undefined
      return { kind: 'upsertTool', toolCallId, title, status, toolKind, content, locations }
    }
  }

  // Plan
  if (variant === 'Plan' || variant === 'plan') {
    const inner = getVariantInner(obj, variant) ?? obj
    const rawEntries = inner['entries']
    if (Array.isArray(rawEntries)) {
      const entries: PlanEntry[] = rawEntries
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map((e) => ({
          content: typeof e['content'] === 'string' ? e['content'] : String(e['content'] ?? ''),
          status: e['status'] === 'completed' ? 'completed'
            : e['status'] === 'in_progress' ? 'in_progress'
            : 'pending',
        }))
      if (entries.length > 0) return { kind: 'setPlan', entries }
    }
  }

  if (DROP_VARIANTS.has(variant)) return { kind: 'drop' }

  return { kind: 'pushSystem', label: variant }
}

// --- Hook ---

export function useAcpChat({ sessionId }: UseAcpChatOptions): UseAcpChatResult {
  const [connectionState, setConnectionState] = useState<AcpConnectionState>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId
  const isReplaying = useRef(false)
  const suppressReplay = useRef(false)

  useEffect(() => {
    if (!sessionId) {
      setConnectionState('disconnected')
      return
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${proto}//${window.location.host}/api/v1/ws/acp/${encodeURIComponent(sessionId)}`

    setConnectionState('connecting')
    const store = useChatStore.getState()
    store.setError(sessionId, null)

    const ws = new WebSocket(url)
    wsRef.current = ws
    let disposed = false

    ws.onopen = () => {
      if (disposed) { ws.close(); return }
      setConnectionState('connected')
      const sid = sessionIdRef.current
      if (sid) useChatStore.getState().setError(sid, null)
    }

    ws.onmessage = (ev) => {
      const sid = sessionIdRef.current
      if (!sid) return
      let frame: ServerFrame
      try {
        frame = typeof ev.data === 'string'
          ? JSON.parse(ev.data)
          : { type: 'error', message: 'non-text frame' }
      } catch {
        useChatStore.getState().setError(sid, 'malformed frame')
        return
      }
      if (import.meta.env.DEV) console.debug('[ACP RX]', frame.type, ev.data)

      const s = useChatStore.getState()
      switch (frame.type) {
        case 'session_update': {
          if (isReplaying.current && suppressReplay.current) break
          const canonical = normalizeSessionUpdate(frame.data?.update)
          const action = classifySessionUpdate(canonical)
          switch (action.kind) {
            case 'appendText':
              s.appendChunk(sid, action.text)
              break
            case 'appendThought':
              s.appendThought(sid, action.text)
              break
            case 'setMode':
              s.setMode(sid, action.mode)
              break
            case 'upsertTool':
              s.upsertToolCall(sid, {
                toolCallId: action.toolCallId,
                title: action.title,
                status: action.status as 'running' | 'completed' | 'failed' | 'updating',
                kind: action.toolKind,
                content: action.content,
                locations: action.locations,
              })
              break
            case 'setPlan':
              s.setPlan(sid, action.entries)
              break
            case 'pushSystem':
              s.pushSystemEvent(sid, action.label)
              break
            case 'drop':
              if (import.meta.env.DEV) console.debug('[ACP drop]', frame.data?.update)
              break
          }
          break
        }
        case 'prompt_done':
          s.markDone(sid)
          break
        case 'prompt_error':
          s.markError(sid, frame.message ?? 'prompt failed')
          break
        case 'error':
          if (frame.code === 'session_not_found') {
            s.markEnded(sid)
          } else {
            s.setError(sid, frame.message ?? 'server error')
          }
          break
        case 'replay_start': {
          isReplaying.current = true
          const msgs = s.states[sid]?.messages
          suppressReplay.current = !!(msgs && msgs.length > 0)
          break
        }
        case 'replay_end':
          isReplaying.current = false
          suppressReplay.current = false
          s.clearEnded(sid)
          break
      }
    }

    ws.onerror = () => {
      if (wsRef.current !== ws) return
      const sid = sessionIdRef.current
      if (sid) useChatStore.getState().setError(sid, 'WebSocket error')
      setConnectionState('error')
    }

    ws.onclose = () => {
      if (wsRef.current === ws) {
        setConnectionState('disconnected')
        wsRef.current = null
      }
    }

    return () => {
      disposed = true
      if (ws.readyState === WebSocket.OPEN) ws.close()
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [sessionId])

  const sendPrompt = useCallback((text: string) => {
    const ws = wsRef.current
    const sid = sessionIdRef.current
    const trimmed = text.trim()
    if (!ws || ws.readyState !== WebSocket.OPEN || !sid || !trimmed) return
    const s = useChatStore.getState()
    s.beginPrompt(sid)
    s.addUserMessage(sid, trimmed)
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
