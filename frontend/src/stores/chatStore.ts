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
  title?: string
  status: 'running' | 'completed' | 'failed' | 'updating'
  kind?: string
  content?: string
  locations?: string[]
}

/** Partial tool-call event; undefined fields preserve the existing card's values. */
export interface ToolCallUpdate {
  toolCallId: string
  title?: string
  status?: ToolCallBlock['status']
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

// --- Replay batching ---
//
// 重放（replay）期间后端会把历史记录逐帧以大批量 `session_update` 推回。若前端对
// 每一帧各调一次 store action，数百条消息 = 数百次整列表重渲染，导致重放极慢。
// 因此提供 `applyReplayBatch`：前端把一帧内（或一动画帧内攒下的）多条重放帧先
// 分类成 `SessionUpdateAction`，再一次性提交，store 内部只做一次 state 变换 +
// 一次重渲染，把重放成本从 O(N 次渲染) 降到 O(渲染帧数)。

export type SessionUpdateAction =
  | { kind: 'appendText'; text: string }
  | { kind: 'appendThought'; text: string }
  | { kind: 'setMode'; mode: string }
  | { kind: 'upsertTool'; toolCallId: string; title?: string; status?: string; toolKind?: string; content?: string; locations?: string[] }
  | { kind: 'setPlan'; entries: PlanEntry[] }
  | { kind: 'setUsage'; usage: Record<string, unknown> }
  | { kind: 'setCommands'; commands: SlashCommand[] }
  | { kind: 'setConfigOptions'; options: ConfigOption[] }
  | { kind: 'pushSystem'; label: string }
  | { kind: 'drop' }

// --- Config options (mode / model / thinking level selectors) ---

export interface ConfigSelectOption {
  value: string
  name: string
}

export interface ConfigOption {
  id: string
  name: string
  category: string
  currentValue: string
  options: ConfigSelectOption[]
}

// --- Slash commands (agent-advertised via AvailableCommandsUpdate) ---

export interface SlashCommand {
  name: string
  description: string
  hint?: string
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
  /** 正在从后端重放历史记录（replay_start … replay_end 之间），供 UI 显示恢复指示。 */
  replaying: boolean
  pendingPermission: PendingPermission | null
  usage: Record<string, unknown> | null
  commands: SlashCommand[]
  configOptions: ConfigOption[]
}

interface ChatActions {
  appendChunk: (sessionId: string, chunk: string) => void
  /** 重放批量提交：一次性把多条重放帧合并进 state，只触发一次重渲染。 */
  applyReplayBatch: (sessionId: string, actions: SessionUpdateAction[]) => void
  appendThought: (sessionId: string, chunk: string) => void
  upsertToolCall: (sessionId: string, entry: ToolCallUpdate) => void
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
  setReplaying: (sessionId: string, replaying: boolean) => void
  setUsage: (sessionId: string, usage: Record<string, unknown>) => void
  setCommands: (sessionId: string, commands: SlashCommand[]) => void
  setConfigOptions: (sessionId: string, options: ConfigOption[]) => void
  patchConfigOptionValue: (sessionId: string, configId: string, value: string) => void
  reset: (sessionId: string) => void
}

const EMPTY: ChatSessionState = {
  messages: [],
  sending: false,
  error: null,
  mode: null,
  sessionEnded: false,
  replaying: false,
  pendingPermission: null,
  usage: null,
  commands: [],
  configOptions: [],
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

/**
 * 纯函数：把多条重放帧合并进现有 messages（追加文本 / 合并 tool / plan / thought
 * 等），返回新的 messages 数组。语义与 `appendChunk` 等单条 action 一致，但只做
 * 一次全量浅拷贝。重放的历史回合视为已完成，新追加的 assistant 消息 `streaming`
 * 保持 true（由 `finalizeReplay` 在 `replay_end` 时统一置 false）。
 */
const applyActionsToMessages = (
  messages: ChatMessage[],
  actions: SessionUpdateAction[],
): ChatMessage[] => {
  const next = [...messages]
  for (const action of actions) {
    if (action.kind === 'appendText') {
      const last = next[next.length - 1]
      if (last && last.role === 'assistant') {
        const blocks = [...last.blocks]
        const lastBlock = blocks[blocks.length - 1]
        if (lastBlock && lastBlock.type === 'text') {
          blocks[blocks.length - 1] = { ...lastBlock, text: lastBlock.text + action.text }
        } else {
          blocks.push({ type: 'text', text: action.text })
        }
        next[next.length - 1] = { ...last, text: last.text + action.text, blocks }
      } else {
        next.push({
          id: genId(),
          role: 'assistant',
          text: action.text,
          blocks: [{ type: 'text', text: action.text }],
          createdAt: Date.now(),
          streaming: true,
        })
      }
    } else if (action.kind === 'appendThought') {
      const last = next[next.length - 1]
      if (last && last.role === 'assistant') {
        const blocks = [...last.blocks]
        const lastBlock = blocks[blocks.length - 1]
        if (lastBlock && lastBlock.type === 'thought') {
          blocks[blocks.length - 1] = { ...lastBlock, text: lastBlock.text + action.text }
        } else {
          blocks.push({ type: 'thought', text: action.text })
        }
        next[next.length - 1] = { ...last, blocks }
      } else {
        next.push({
          id: genId(),
          role: 'assistant',
          text: '',
          blocks: [{ type: 'thought', text: action.text }],
          createdAt: Date.now(),
          streaming: true,
        })
      }
    } else if (action.kind === 'upsertTool') {
      const last = next[next.length - 1]
      if (last && last.role === 'assistant') {
        const toBlock = (prev?: ToolCallBlock): ToolCallBlock => ({
          type: 'tool_call',
          toolCallId: action.toolCallId,
          title: action.title ?? prev?.title,
          status: (action.status as ToolCallBlock['status']) ?? prev?.status ?? 'running',
          kind: action.toolKind ?? prev?.kind,
          content: action.content ?? prev?.content,
          locations: action.locations ?? prev?.locations,
        })
        const blocks = [...last.blocks]
        const idx = blocks.findIndex(
          (b) => b.type === 'tool_call' && b.toolCallId === action.toolCallId,
        )
        if (idx >= 0) {
          blocks[idx] = toBlock(blocks[idx] as ToolCallBlock)
        } else {
          blocks.push(toBlock())
        }
        next[next.length - 1] = { ...last, blocks }
      } else {
        next.push({
          id: genId(),
          role: 'assistant',
          text: '',
          blocks: [
            {
              type: 'tool_call',
              toolCallId: action.toolCallId,
              title: action.title,
              status: (action.status as ToolCallBlock['status']) ?? 'running',
              kind: action.toolKind,
              content: action.content,
              locations: action.locations,
            },
          ],
          createdAt: Date.now(),
          streaming: true,
        })
      }
    } else if (action.kind === 'setPlan') {
      const last = next[next.length - 1]
      if (last && last.role === 'assistant') {
        const blocks = [...last.blocks]
        const idx = blocks.findIndex((b) => b.type === 'plan')
        if (idx >= 0) {
          blocks[idx] = { type: 'plan', entries: action.entries }
        } else {
          blocks.push({ type: 'plan', entries: action.entries })
        }
        next[next.length - 1] = { ...last, blocks }
      }
    } else if (action.kind === 'pushSystem') {
      next.push({
        id: genId(),
        role: 'system',
        text: `[${action.label}]`,
        blocks: [{ type: 'system', label: action.label }],
        createdAt: Date.now(),
      })
    }
    // drop / setMode / setUsage / setCommands / setConfigOptions 不进 messages，
    // 由下方 applyReplayBatch 在顶层字段处理。
  }
  return next
}

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
      const toBlock = (prev?: ToolCallBlock): ToolCallBlock => ({
        type: 'tool_call',
        toolCallId: entry.toolCallId,
        title: entry.title ?? prev?.title,
        status: entry.status ?? prev?.status ?? 'running',
        kind: entry.kind ?? prev?.kind,
        content: entry.content ?? prev?.content,
        locations: entry.locations ?? prev?.locations,
      })
      if (last && last.role === 'assistant' && last.streaming) {
        const blocks = [...last.blocks]
        const idx = blocks.findIndex(
          (b) => b.type === 'tool_call' && b.toolCallId === entry.toolCallId,
        )
        if (idx >= 0) {
          blocks[idx] = toBlock(blocks[idx] as ToolCallBlock)
        } else {
          blocks.push(toBlock())
        }
        messages[messages.length - 1] = { ...last, blocks }
      } else {
        messages.push({
          id: genId(),
          role: 'assistant',
          text: '',
          blocks: [toBlock()],
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

  applyReplayBatch: (sessionId, actions) =>
    set((state) => {
      if (actions.length === 0) return state
      const current = get(state, sessionId)
      const messages = applyActionsToMessages(current.messages, actions)
      // 顶层字段（mode/usage/commands/configOptions）一次性合并
      let next = patch(state, sessionId, { messages })
      for (const action of actions) {
        if (action.kind === 'setMode') {
          next = patch(next, sessionId, { mode: action.mode })
        } else if (action.kind === 'setUsage') {
          next = patch(next, sessionId, { usage: action.usage })
        } else if (action.kind === 'setCommands') {
          next = patch(next, sessionId, { commands: action.commands })
        } else if (action.kind === 'setConfigOptions') {
          next = patch(next, sessionId, { configOptions: action.options })
        }
      }
      return next
    }),

  // 重放结束：把残留的 streaming assistant 消息标记为已完成，清掉光标态。
  finalizeReplay: (sessionId) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = current.messages.map((m) =>
        m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
      )
      return patch(state, sessionId, { messages })
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

  setReplaying: (sessionId, replaying) =>
    set((state) => patch(state, sessionId, { replaying })),

  setUsage: (sessionId, usage) =>
    set((state) => patch(state, sessionId, { usage })),

  setCommands: (sessionId, commands) =>
    set((state) => patch(state, sessionId, { commands })),

  setConfigOptions: (sessionId, options) =>
    set((state) => patch(state, sessionId, { configOptions: options })),

  patchConfigOptionValue: (sessionId, configId, value) =>
    set((state) => {
      const current = get(state, sessionId)
      const configOptions = current.configOptions.map((o) =>
        o.id === configId ? { ...o, currentValue: value } : o,
      )
      return patch(state, sessionId, { configOptions })
    }),

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
