import { create } from 'zustand'
import { useGitStore } from './gitStore'

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

// �����嵥��todos / task list������ ACP ��׼���塪���� agent ˽��Լ��
// ��OpenCode �ù��ߵ��� + JSON ������أ����� agent ������Ƕ�ı����Զ���֪ͨ����
// �ʰ� ��8 ��ʵ�ּ����ԣ���������̬ʶ�𣬶� status/priority ����ʽ���ˣ����󶨵�һʵ�֡�
export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type TodoPriority = 'low' | 'medium' | 'high'

export interface TodoEntry {
  content: string
  status: TodoStatus
  priority: TodoPriority
}

export interface TodoBlock {
  type: 'todo'
  /** ��ѡ���⣨�� agent �����嵥������ȱʧʱ UI �ü������ס� */
  title?: string
  entries: TodoEntry[]
}

export interface SystemBlock {
  type: 'system'
  label: string
}

// F03 图片附件：用户消息内联 base64 图片（对应 ACP `ContentBlock::Image`）。
export interface ImageBlock {
  type: 'image'
  mimeType: string
  /** Base64 数据（不含 data URI 前缀）。 */
  data: string
}

export type ContentBlock = TextBlock | ThoughtBlock | ToolCallBlock | PlanBlock | TodoBlock | SystemBlock | ImageBlock

// --- Agent terminal activity (from ACP `terminal/create`) ---
// Surfaces commands the agent runs in background terminals so they aren't silent.

export interface TerminalActivity {
  id: string
  command: string
  args: string[]
  status: 'created' | 'exited'
  exit_code: number | null
}

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
  toolKind?: string
  /** 预览文本：unified diff 或工具入参（来自 toolCall.content / rawInput），缺省时 banner 降级为纯文本 */
  content?: string
  locations?: string[]
}

// --- Replay batching ---
//
// 重放（replay）期间后端会把历史记录逐帧以大批量 `session_update` 推回。若前端�?
// 每一帧各调一�? store action，数百条消息 = 数百次整列表重渲染，导致重放极慢�?
// 因此提供 `applyReplayBatch`：前端把一帧内（或一动画帧内攒下的）多条重放帧先
// 分类�? `SessionUpdateAction`，再一次性提交，store 内部只做一�? state 变换 +
// 一次重渲染，把重放成本�? O(N 次渲�?) 降到 O(渲染帧数)�?

export type SessionUpdateAction =
  | { kind: 'appendText'; text: string }
  | { kind: 'appendThought'; text: string }
  | { kind: 'setMode'; mode: string }
  | { kind: 'upsertTool'; toolCallId: string; title?: string; status?: string; toolKind?: string; content?: string; locations?: string[] }
  | { kind: 'setPlan'; entries: PlanEntry[] }
  | { kind: 'setTodos'; title?: string; entries: TodoEntry[] }
  | { kind: 'setUsage'; usage: Record<string, unknown> }
  | { kind: 'setCommands'; commands: SlashCommand[] }
  | { kind: 'setConfigOptions'; options: ConfigOption[] }
  | { kind: 'addUserMessage'; text: string; messageId?: string }
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
  /** Plain-text accumulator �? kept for persistence hydration compatibility. */
  text: string
  /** Structured content blocks for rich rendering. */
  blocks: ContentBlock[]
  createdAt: number
  streaming?: boolean
  /**
   * True for queued follow-up messages that were lost on disconnect (see
   * `addUndeliveredMessage`). Renders with a visual marker so the user knows
   * the text is recorded but was never delivered to the agent. Never persisted
   * to DB (filtered out in `useAcpChat.syncToDb`); lives only in the
   * in-memory chatStore until the session unmounts.
   */
  undelivered?: boolean
  /**
   * True when the user re-sent an edited copy of this message (F02). ACP has
   * no "edit history" concept — the original stays in place with this marker
   * and the edited text goes out as a brand-new prompt. In-memory only (not
   * persisted; lost on refresh, which is acceptable since both messages are).
   */
  edited?: boolean
}

interface ChatSessionState {
  messages: ChatMessage[]
  sending: boolean
  error: string | null
  mode: string | null
  sessionEnded: boolean
  /** 正在从后端重放历史记录（replay_start �? replay_end 之间），�? UI 显示恢复指示�? */
  replaying: boolean
  pendingPermission: PendingPermission | null
  usage: Record<string, unknown> | null
  commands: SlashCommand[]
  configOptions: ConfigOption[]
  terminalEvents: TerminalActivity[]
  /** 当前待办列表看板数据（独立于 messages，固定在输入框上方展示）。 */
  todos: TodoEntry[]
  todosTitle: string | undefined
  /**
   * Queued follow-up message — N=1 single-slot buffer for the next user prompt
   * to send after the current in-flight prompt finishes. Drained automatically
   * by `useAcpChat` on `prompt_done`; never crosses the WS on its own. Cleared
   * by `clearQueuedMessage` (chip ✕ click) or overwritten by the next
   * `enqueueMessage`. Mirrored to `sessionStorage` so F5 in the same tab does
   * not drop the user's next message.
   */
  queuedMessage: string | null
  /**
   * F03: agent 是否声明 `promptCapabilities.image`（后端 capabilities 帧下发）。
   * undefined = 尚未收到声明，UI 按不支持处理（保守降级）。
   */
  imageSupported?: boolean
}

interface ChatActions {
  appendChunk: (sessionId: string, chunk: string) => void
  /** 重放批量提交：一次性把多条重放帧合并进 state，只触发一次重渲染�? */
  applyReplayBatch: (sessionId: string, actions: SessionUpdateAction[]) => void
  appendThought: (sessionId: string, chunk: string) => void
  upsertToolCall: (sessionId: string, entry: ToolCallUpdate) => void
  setPlan: (sessionId: string, entries: PlanEntry[]) => void
  setTodos: (sessionId: string, title: string | undefined, entries: TodoEntry[]) => void
  pushSystemEvent: (sessionId: string, label: string) => void
  addUserMessage: (sessionId: string, text: string, images?: ImageBlock[]) => void
  /** Add a queued message that was lost on disconnect (e.g. WS closed before `prompt_done`).
   *  Renders as a normal user message with `undelivered: true` so the user can see what
   *  they tried to send. Not persisted to DB; cleared on session remount. */
  addUndeliveredMessage: (sessionId: string, text: string) => void
  /** Mark a user message as superseded by an edited resend (F02). */
  markEdited: (sessionId: string, messageId: string) => void
  markDone: (sessionId: string) => void
  markError: (sessionId: string, message: string) => void
  beginPrompt: (sessionId: string) => void
  /** Store the next user message in the N=1 queue slot. Trimmed; empty text is a no-op.
   *  Mirrored to sessionStorage. */
  enqueueMessage: (sessionId: string, text: string) => void
  /** Clear the queue slot (called on chip ✕ click or after successful drain). Removes
   *  the sessionStorage mirror as well. */
  clearQueuedMessage: (sessionId: string) => void
  /** Hydrate the queue slot from sessionStorage on ChatInput mount. No-op if the slot
   *  is already populated (a fresh `enqueueMessage` should win over a stale cache). */
  hydrateQueuedMessage: (sessionId: string, text: string) => void
  setMode: (sessionId: string, mode: string) => void
  setError: (sessionId: string, message: string | null) => void
  hydrate: (sessionId: string, messages: ChatMessage[]) => void
  markEnded: (sessionId: string) => void
  clearEnded: (sessionId: string) => void
  setPermission: (sessionId: string, permission: PendingPermission) => void
  clearPermission: (sessionId: string) => void
  setReplaying: (sessionId: string, replaying: boolean) => void
  finalizeReplay: (sessionId: string) => void
  setUsage: (sessionId: string, usage: Record<string, unknown>) => void
  setCommands: (sessionId: string, commands: SlashCommand[]) => void
  setConfigOptions: (sessionId: string, options: ConfigOption[]) => void
  /** F03: 记录 agent 是否支持图片 prompt（后端 capabilities 帧）。 */
  setImageSupported: (sessionId: string, supported: boolean) => void
  patchConfigOptionValue: (sessionId: string, configId: string, value: string) => void
  upsertTerminalActivity: (sessionId: string, event: TerminalActivity) => void
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
  terminalEvents: [],
  todos: [],
  todosTitle: undefined,
  queuedMessage: null,
}

const QUEUE_STORAGE_PREFIX = 'omniterm_chat_queue:'
const queueStorageKey = (sessionId: string) => `${QUEUE_STORAGE_PREFIX}${sessionId}`

/** Best-effort sessionStorage read — swallows quota / private-mode errors. */
function readQueuedFromStorage(sessionId: string): string | null {
  try {
    return sessionStorage.getItem(queueStorageKey(sessionId))
  } catch {
    return null
  }
}

/** Best-effort sessionStorage write — swallows quota / private-mode errors. */
function writeQueuedToStorage(sessionId: string, text: string): void {
  try {
    sessionStorage.setItem(queueStorageKey(sessionId), text)
  } catch {
    // Ignore storage errors (quota, private mode, etc.)
  }
}

/** Best-effort sessionStorage clear. */
function removeQueuedFromStorage(sessionId: string): void {
  try {
    sessionStorage.removeItem(queueStorageKey(sessionId))
  } catch {
    // Ignore storage errors
  }
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
 * 纯函数：把多条重放帧合并进现�? messages（追加文�? / 合并 tool / plan / thought
 * 等），返回新�? messages 数组。语义与 `appendChunk` 等单�? action 一致，但只�?
 * 一次全量浅拷贝。重放的历史回合视为已完成，新追加的 assistant 消息 `streaming`
 * 保持 true（由 `finalizeReplay` �? `replay_end` 时统一�? false）�?
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
      // ADR-4: 编辑类工具完成 → 提示 git 面板刷新
      if (action.status === 'completed') {
        const lastMsg = next[next.length - 1]
        const prevBlock = lastMsg?.blocks.find(
          (b) => b.type === 'tool_call' && b.toolCallId === action.toolCallId,
        ) as ToolCallBlock | undefined
        const k = action.toolKind ?? prevBlock?.kind
        if (k === 'edit' || k === 'delete' || k === 'move') {
          useGitStore.getState().notifyExternalChange()
        }
      }
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
    } else if (action.kind === 'setTodos') {
      const last = next[next.length - 1]
      if (last && last.role === 'assistant') {
        const blocks = [...last.blocks]
        const idx = blocks.findIndex((b) => b.type === 'todo')
        if (idx >= 0) {
          blocks[idx] = { type: 'todo', title: action.title, entries: action.entries }
        } else {
          blocks.push({ type: 'todo', title: action.title, entries: action.entries })
        }
        next[next.length - 1] = { ...last, blocks }
      }
    } else if (action.kind === 'addUserMessage') {
      // 按 messageId 去重（重复 restore 不会重复添加）
      if (action.messageId) {
        const dup = next.find((m) => m.role === 'user' && m.text === action.text)
        if (dup) continue
      }
      next.push({
        id: genId(),
        role: 'user',
        text: action.text,
        blocks: [{ type: 'text', text: action.text }],
        createdAt: Date.now(),
      })
    } else if (action.kind === 'pushSystem') {
      next.push({
        id: genId(),
        role: 'system',
        text: `[${action.label}]`,
        blocks: [{ type: 'system', label: action.label }],
        createdAt: Date.now(),
      })
    }
    // drop / setMode / setUsage / setCommands / setConfigOptions 不进 messages�?
    // 由下�? applyReplayBatch 在顶层字段处理�?
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

  setTodos: (sessionId, title, entries) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = [...current.messages]
      const last = messages[messages.length - 1]
      if (last && last.role === 'assistant' && last.streaming) {
        const blocks = [...last.blocks]
        const idx = blocks.findIndex((b) => b.type === 'todo')
        if (idx >= 0) {
          blocks[idx] = { type: 'todo', title, entries }
        } else {
          blocks.push({ type: 'todo', title, entries })
        }
        messages[messages.length - 1] = { ...last, blocks }
      }
      return patch(state, sessionId, { messages, todos: entries, todosTitle: title })
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

  addUserMessage: (sessionId, text, images) =>
    set((state) => {
      const current = get(state, sessionId)
      // 纯图片消息不塞空 text block（渲染与落库都无意义）。
      const blocks: ContentBlock[] = text !== '' || !images?.length
        ? [{ type: 'text' as const, text }]
        : []
      if (images) blocks.push(...images)
      return patch(state, sessionId, {
        messages: [
          ...current.messages,
          {
            id: genId(),
            role: 'user',
            text,
            blocks,
            createdAt: Date.now(),
          },
        ],
      })
    }),

  addUndeliveredMessage: (sessionId, text) =>
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
            undelivered: true,
          },
        ],
      })
    }),

  markEdited: (sessionId, messageId) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = current.messages.map((m) =>
        m.id === messageId && m.role === 'user' && !m.edited ? { ...m, edited: true } : m,
      )
      return patch(state, sessionId, { messages })
    }),

  enqueueMessage: (sessionId, text) =>
    set((state) => {
      const trimmed = text.trim()
      if (!trimmed) return state
      writeQueuedToStorage(sessionId, trimmed)
      return patch(state, sessionId, { queuedMessage: trimmed })
    }),

  clearQueuedMessage: (sessionId) =>
    set((state) => {
      const current = get(state, sessionId)
      if (current.queuedMessage === null) return state
      removeQueuedFromStorage(sessionId)
      return patch(state, sessionId, { queuedMessage: null })
    }),

  hydrateQueuedMessage: (sessionId, text) =>
    set((state) => {
      const trimmed = text.trim()
      if (!trimmed) return state
      // 不覆盖已存在的值：活跃的 enqueueMessage 永远比 sessionStorage 缓存新
      const current = get(state, sessionId)
      if (current.queuedMessage !== null) return state
      return patch(state, sessionId, { queuedMessage: trimmed })
    }),

  applyReplayBatch: (sessionId, actions) =>
    set((state) => {
      if (actions.length === 0) return state
      const current = get(state, sessionId)
      const messages = applyActionsToMessages(current.messages, actions)
      // 顶层字段（mode/usage/commands/configOptions/todos）一次性合并
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
        } else if (action.kind === 'setTodos') {
          next = patch(next, sessionId, { todos: action.entries, todosTitle: action.title })
        }
      }
      return next
    }),

  // 重放结束：把残留�? streaming assistant 消息标记为已完成，清掉光标态�?
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
      // 扫描最后一条消息，提取最后一个 TodoBlock 作为看板数据
      let todos: TodoEntry[] = []
      let todosTitle: string | undefined
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role === 'assistant' && m.blocks) {
          for (let j = m.blocks.length - 1; j >= 0; j--) {
            const b = m.blocks[j]
            if (b.type === 'todo') {
              todos = b.entries
              todosTitle = b.title
              break
            }
          }
          if (todos.length > 0) break
        }
      }
      return patch(state, sessionId, { messages, todos, todosTitle })
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

  setImageSupported: (sessionId, supported) =>
    set((state) => patch(state, sessionId, { imageSupported: supported })),

  patchConfigOptionValue: (sessionId, configId, value) =>
    set((state) => {
      const current = get(state, sessionId)
      const configOptions = current.configOptions.map((o) =>
        o.id === configId ? { ...o, currentValue: value } : o,
      )
      return patch(state, sessionId, { configOptions })
    }),

  upsertTerminalActivity: (sessionId, event) =>
    set((state) => {
      const current = get(state, sessionId)
      const terminalEvents = current.terminalEvents.map((e) =>
        e.id === event.id ? { ...e, ...event } : e,
      )
      if (!terminalEvents.some((e) => e.id === event.id)) {
        terminalEvents.push(event)
      }
      return patch(state, sessionId, { terminalEvents })
    }),

  reset: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.states)) return state
      const next = { ...state.states }
      delete next[sessionId]
      // 同步清掉 sessionStorage 里残留的 queue 缓存（防止 F5 后 stale 数据复活）
      removeQueuedFromStorage(sessionId)
      return { states: next }
    }),
}))

export const selectChatState = (sessionId: string | null) => (s: ChatStore) =>
  sessionId ? s.states[sessionId] ?? EMPTY : EMPTY

/**
 * Read the queued message from sessionStorage for the given session. Used by
 * `ChatInput` on mount to restore the queue after a page refresh. Returns
 * `null` if no cached value or if sessionStorage is unavailable.
 */
export function readQueuedFromStorageForSession(sessionId: string): string | null {
  return readQueuedFromStorage(sessionId)
}

/** Shape of each message entry in the `/sessions/{id}/messages/sync` POST body. */
export interface SyncMessagePayload {
  role: string
  text: string
  blocks?: string
}

/**
 * Convert a chat message list to the sync payload the backend
 * `/sessions/{id}/messages/sync` endpoint expects. Pure function so it can be
 * unit-tested without mocking `fetch` or rendering the WS hook.
 *
 * Rules:
 * - Only `user` and `assistant` roles sync (system events are UI-only).
 * - `undelivered: true` messages are skipped — they are in-memory only,
 *   representing messages the user tried to send but the WS lost before
 *   `prompt_done`. Persisting them would pollute DB history with text the
 *   agent never received.
 * - `blocks` is stringified when non-empty; omitted when empty so the
 *   backend's `(session, role, text)` dedup has stable rows.
 */
export function messagesToSyncPayload(
  messages: readonly ChatMessage[],
): SyncMessagePayload[] {
  const payload: SyncMessagePayload[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (m.undelivered) continue
    const entry: SyncMessagePayload = { role: m.role, text: m.text }
    if (m.blocks.length) {
      entry.blocks = JSON.stringify(m.blocks)
    }
    payload.push(entry)
  }
  return payload
}
