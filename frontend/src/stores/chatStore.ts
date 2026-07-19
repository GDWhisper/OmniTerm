import { create } from 'zustand'

// --- Content block types (Phase 7 structured rendering) ---

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThoughtBlock {
  type: 'thought'
  text: string
}

export interface ToolCallBlock {
  type: 'tool_call'
  toolCallId: string
  title: string
  status: 'running' | 'completed' | 'failed' | 'updating'
  kind?: string
  content?: string
  locations?: string[]
}

export interface PlanEntry {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface PlanBlock {
  type: 'plan'
  entries: PlanEntry[]
}

export interface SystemBlock {
  type: 'system'
  label: string
}

export type ContentBlock = TextBlock | ThoughtBlock | ToolCallBlock | PlanBlock | SystemBlock

// --- Permission request (ephemeral, not persisted as a message block) ---

export interface PermissionOption {
  option_id: string
  kind: string
  name?: string
}

export interface PendingPermission {
  id: string
  options: PermissionOption[]
  toolName?: string
}

// --- Message model ---

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  /** Plain-text accumulator — kept for persistence hydration compatibility. */
  text: string
  /** Structured content blocks for rich rendering. */
  blocks: ContentBlock[]
  createdAt: number
  streaming?: boolean
}

interface ChatSessionState {
  messages: ChatMessage[]
  sending: boolean
  error: string | null
  mode: string | null
  sessionEnded: boolean
  pendingPermission: PendingPermission | null
  usage: Record<string, unknown> | null
  commands: string[]
}

interface ChatActions {
  appendChunk: (sessionId: string, chunk: string) => void
  appendThought: (sessionId: string, chunk: string) => void
  upsertToolCall: (sessionId: string, entry: Omit<ToolCallBlock, 'type'>) => void
  setPlan: (sessionId: string, entries: PlanEntry[]) => void
  pushSystemEvent: (sessionId: string, label: string) => void
  addUserMessage: (sessionId: string, text: string) => void
  markDone: (sessionId: string) => void
  markError: (sessionId: string, message: string) => void
  beginPrompt: (sessionId: string) => void
  setMode: (sessionId: string, mode: string) => void
  setError: (sessionId: string, message: string | null) => void
  hydrate: (sessionId: string, messages: ChatMessage[]) => void
  markEnded: (sessionId: string) => void
  clearEnded: (sessionId: string) => void
  setPermission: (sessionId: string, permission: PendingPermission) => void
  clearPermission: (sessionId: string) => void
  setUsage: (sessionId: string, usage: Record<string, unknown>) => void
  setCommands: (sessionId: string, commands: string[]) => void
  reset: (sessionId: string) => void
}

const EMPTY: ChatSessionState = {
  messages: [],
  sending: false,
  error: null,
  mode: null,
  sessionEnded: false,
  pendingPermission: null,
  usage: null,
  commands: [],
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

  appendChunk: (sessionId, chunk) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = [...current.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        const blocks = [...last.blocks]
        const lastBlock = blocks[blocks.length - 1]
        if (lastBlock && lastBlock.type === 'text') {
          blocks[blocks.length - 1] = { ...lastBlock, text: lastBlock.text + chunk }
        } else {
          blocks.push({ type: 'text', text: chunk })
        }
        messages[messages.length - 1] = {
          ...last,
          text: last.text + chunk,
          blocks,
        }
      } else {
        messages.push({
          id: genId(),
          role: 'assistant',
          text: chunk,
          blocks: [{ type: 'text', text: chunk }],
          createdAt: Date.now(),
          streaming: true,
        })
      }
      return patch(state, sessionId, { messages })
    }),

  appendThought: (sessionId, chunk) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = [...current.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        const blocks = [...last.blocks]
        const lastBlock = blocks[blocks.length - 1]
        if (lastBlock && lastBlock.type === 'thought') {
          blocks[blocks.length - 1] = { ...lastBlock, text: lastBlock.text + chunk }
        } else {
          blocks.push({ type: 'thought', text: chunk })
        }
        messages[messages.length - 1] = { ...last, blocks }
      } else {
        messages.push({
          id: genId(),
          role: 'assistant',
          text: '',
          blocks: [{ type: 'thought', text: chunk }],
          createdAt: Date.now(),
          streaming: true,
        })
      }
      return patch(state, sessionId, { messages })
    }),

  upsertToolCall: (sessionId, entry) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = [...current.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        const blocks = [...last.blocks]
        const idx = blocks.findIndex(
          (b) => b.type === 'tool_call' && b.toolCallId === entry.toolCallId,
        )
        if (idx >= 0) {
          blocks[idx] = { type: 'tool_call', ...entry }
        } else {
          blocks.push({ type: 'tool_call', ...entry })
        }
        messages[messages.length - 1] = { ...last, blocks }
      } else {
        messages.push({
          id: genId(),
          role: 'assistant',
          text: '',
          blocks: [{ type: 'tool_call', ...entry }],
          createdAt: Date.now(),
          streaming: true,
        })
      }
      return patch(state, sessionId, { messages })
    }),

  setPlan: (sessionId, entries) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = [...current.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        const blocks = [...last.blocks]
        const idx = blocks.findIndex((b) => b.type === 'plan')
        if (idx >= 0) {
          blocks[idx] = { type: 'plan', entries }
        } else {
          blocks.push({ type: 'plan', entries })
        }
        messages[messages.length - 1] = { ...last, blocks }
      }
      return patch(state, sessionId, { messages })
    }),

  pushSystemEvent: (sessionId, label) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = [
        ...current.messages,
        {
          id: genId(),
          role: 'system' as const,
          text: `[${label}]`,
          blocks: [{ type: 'system' as const, label }],
          createdAt: Date.now(),
        },
      ]
      return patch(state, sessionId, { messages })
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
            blocks: [{ type: 'text' as const, text }],
            createdAt: Date.now(),
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
      patch(state, sessionId, { sending: true, error: null }),
    ),

  setMode: (sessionId, mode) =>
    set((state) => patch(state, sessionId, { mode })),

  setError: (sessionId, message) =>
    set((state) => patch(state, sessionId, { error: message })),

  hydrate: (sessionId, messages) =>
    set((state) => {
      const current = get(state, sessionId)
      if (current.messages.length > 0) return state
      return patch(state, sessionId, { messages })
    }),

  markEnded: (sessionId) =>
    set((state) => patch(state, sessionId, { sessionEnded: true, sending: false })),

  clearEnded: (sessionId) =>
    set((state) => patch(state, sessionId, { sessionEnded: false })),

  setPermission: (sessionId, permission) =>
    set((state) => patch(state, sessionId, { pendingPermission: permission })),

  clearPermission: (sessionId) =>
    set((state) => patch(state, sessionId, { pendingPermission: null })),

  setUsage: (sessionId, usage) =>
    set((state) => patch(state, sessionId, { usage })),

  setCommands: (sessionId, commands) =>
    set((state) => patch(state, sessionId, { commands })),

  reset: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.states)) return state
      const next = { ...state.states }
      delete next[sessionId]
      return { states: next }
    }),
}))

export const selectChatState = (sessionId: string | null) => (s: ChatStore) =>
  sessionId ? s.states[sessionId] ?? EMPTY : EMPTY
