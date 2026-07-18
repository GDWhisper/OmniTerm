import { create } from 'zustand'

/**
 * Chat store — per-session accumulated chat state for ACP-backed sessions.
 *
 * The backend ACP adapter broadcasts `SessionNotification` events over a
 * per-session WebSocket (`/api/v1/ws/acp/{session_id}`). The `useAcpChat`
 * hook consumes those frames and calls store actions to accumulate them
 * into `ChatMessage` items keyed by session id.
 *
 * The store is state-only — it has no WebSocket or HTTP dependencies. The
 * hook owns the connection lifecycle and translates protocol events into
 * these actions. This split keeps the store trivially testable and lets
 * multiple ChatView instances (desktop + mobile) share one state source
 * without duplicating sockets.
 *
 * Phase 4 scope: only `AgentMessageChunk` (text streaming) and a coarse
 * fallback for the other `SessionUpdate` variants. `ToolCall`, `Plan`,
 * `CurrentModeUpdate`, permission requests, and markdown rendering land
 * in Phase 4b / Phase 5.
 */

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  /** Millisecond timestamp — for UI sorting, not persisted. */
  createdAt: number
  /**
   * Raw `SessionUpdate` objects that contributed to this message. Kept for
   * the Phase 5 render pass (tool call cards, plan steps, etc.) — Phase 4
   * only consumes `AgentMessageChunk.text` deltas.
   */
  updates: unknown[]
  /**
   * Set when the assistant message is still streaming (we've seen at least
   * one chunk but no `prompt_done` yet). Cleared on `prompt_done`.
   */
  streaming?: boolean
}

interface ChatSessionState {
  messages: ChatMessage[]
  /** True from the moment a prompt is sent until `prompt_done` / `prompt_error`. */
  sending: boolean
  /** Last error surfaced by the hook (connection drop, prompt_error, etc.). */
  error: string | null
  /** Current ACP `mode` if the agent ever reports one (e.g. "plan" / "act"). */
  mode: string | null
  /**
   * Id of the in-flight "tool activity" system message that aggregates
   * ToolCall / ToolCallUpdate events for the current prompt cycle. Reset
   * on `beginPrompt`. Null when no tool events have been observed yet.
   */
  toolActivityMessageId: string | null
  /**
   * Latest known status per tool name for the current prompt cycle. Used
   * to rebuild the aggregated block's text on each upsert without fan-out.
   */
  toolActivity: Record<string, string>
}

interface ChatActions {
  /** Append a streamed text delta to the in-flight assistant message (or open a new one). */
  appendChunk: (sessionId: string, chunk: string, rawUpdate: unknown) => void
  /** Push a non-text update (plan / mode change / misc) as a system message. */
  pushSystemEvent: (sessionId: string, kind: string, rawUpdate: unknown) => void
  /**
   * Record a tool-call lifecycle event in the per-prompt tool-activity
   * block. Creates the block on first call; same-name updates overwrite
   * the existing line rather than appending a new one.
   */
  upsertToolActivity: (sessionId: string, name: string, status: string) => void
  /** Record a user-sent prompt in the history. */
  addUserMessage: (sessionId: string, text: string) => void
  /** Mark the in-flight assistant message as complete (prompt_done). */
  markDone: (sessionId: string) => void
  /** Record a prompt_error and clear `sending`. */
  markError: (sessionId: string, message: string) => void
  /** Flip `sending` true and clear any prior error before a new prompt. */
  beginPrompt: (sessionId: string) => void
  /** Update the current ACP mode chip (CurrentModeUpdate variant). */
  setMode: (sessionId: string, mode: string) => void
  /** Set the connection / protocol error banner. */
  setError: (sessionId: string, message: string | null) => void
  /** Drop all state for a session (called on session delete / unmount). */
  reset: (sessionId: string) => void
}

const EMPTY: ChatSessionState = {
  messages: [],
  sending: false,
  error: null,
  mode: null,
  toolActivityMessageId: null,
  toolActivity: {},
}

interface ChatStoreState {
  states: Record<string, ChatSessionState>
}

type ChatStore = ChatStoreState & ChatActions

const get = (state: ChatStoreState, sessionId: string): ChatSessionState =>
  state.states[sessionId] ?? EMPTY

const patch = (
  state: ChatStoreState,
  sessionId: string,
  next: Partial<ChatSessionState>,
): ChatStoreState => {
  const current = get(state, sessionId)
  return {
    states: {
      ...state.states,
      [sessionId]: { ...current, ...next },
    },
  }
}

const genId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

export const useChatStore = create<ChatStore>((set) => ({
  states: {},

  appendChunk: (sessionId, chunk, rawUpdate) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = [...current.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        messages[messages.length - 1] = {
          ...last,
          text: last.text + chunk,
          updates: [...last.updates, rawUpdate],
        }
      } else {
        messages.push({
          id: genId(),
          role: 'assistant',
          text: chunk,
          createdAt: Date.now(),
          updates: [rawUpdate],
          streaming: true,
        })
      }
      return patch(state, sessionId, { messages })
    }),

  pushSystemEvent: (sessionId, kind, rawUpdate) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = [
        ...current.messages,
        {
          id: genId(),
          role: 'system' as const,
          text: `[${kind}]`,
          createdAt: Date.now(),
          updates: [rawUpdate],
        },
      ]
      return patch(state, sessionId, { messages })
    }),

  upsertToolActivity: (sessionId, name, status) =>
    set((state) => {
      const current = get(state, sessionId)
      const activity = { ...current.toolActivity, [name]: status }
      const header = '🛠 工具活动'
      const body = Object.entries(activity)
        .map(([n, s]) => `· ${n}  ${s}`)
        .join('\n')
      const text = `${header}\n${body}`
      const messages = [...current.messages]
      const existingIdx = current.toolActivityMessageId
        ? messages.findIndex((m) => m.id === current.toolActivityMessageId)
        : -1
      let toolActivityMessageId = current.toolActivityMessageId
      if (existingIdx >= 0) {
        messages[existingIdx] = { ...messages[existingIdx], text }
      } else {
        const id = genId()
        messages.push({
          id,
          role: 'system' as const,
          text,
          createdAt: Date.now(),
          updates: [],
        })
        toolActivityMessageId = id
      }
      return patch(state, sessionId, { messages, toolActivityMessageId, toolActivity: activity })
    }),

  addUserMessage: (sessionId, text) =>
    set((state) => {
      const current = get(state, sessionId)
      return patch(state, sessionId, {
        messages: [
          ...current.messages,
          {
            id: genId(),
            role: 'user',
            text,
            createdAt: Date.now(),
            updates: [],
          },
        ],
      })
    }),

  markDone: (sessionId) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = current.messages.map((m) =>
        m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
      )
      return patch(state, sessionId, { messages, sending: false })
    }),

  markError: (sessionId, message) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = current.messages.map((m) =>
        m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
      )
      return patch(state, sessionId, { messages, sending: false, error: message })
    }),

  beginPrompt: (sessionId) =>
    set((state) =>
      patch(state, sessionId, {
        sending: true,
        error: null,
        toolActivityMessageId: null,
        toolActivity: {},
      }),
    ),

  setMode: (sessionId, mode) =>
    set((state) => patch(state, sessionId, { mode })),

  setError: (sessionId, message) =>
    set((state) => patch(state, sessionId, { error: message })),

  reset: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.states)) return state
      const next = { ...state.states }
      delete next[sessionId]
      return { states: next }
    }),
}))

/** Selector: read a single session's state (returns EMPTY-like defaults if missing). */
export const selectChatState = (sessionId: string | null) => (s: ChatStore) =>
  sessionId ? s.states[sessionId] ?? EMPTY : EMPTY
