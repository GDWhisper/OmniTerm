import { create } from 'zustand'
import { useGitStore } from './gitStore'
import { beginTurn, endTurn, setTurnWaiting } from '../utils/turnClock'
import type { ImageThumb } from '../utils/imageAttachment'

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
  /** 缩略图（落库/渲染用）；无则渲染原图（旧数据或后端回退存了原图）。 */
  thumb?: ImageThumb
}

// 文件附件：用户消息的普通文件（对应 ACP `ContentBlock::Resource` 的 blob 形态）。
// 只保留元数据——文件内容不落库（历史气泡只需文件名 chip），与图片只落缩略图同理。
export interface FileBlock {
  type: 'file'
  name: string
  mimeType: string
  /** 原始字节数，chip 展示用。 */
  size: number
}

export type ContentBlock = TextBlock | ThoughtBlock | ToolCallBlock | PlanBlock | TodoBlock | SystemBlock | ImageBlock | FileBlock

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

/** 未决审批队列上限（防无界累积红线）：超限丢弃新到达项并 warn——实践中 agent
 *  并发审批数远小于此值，触发即上游异常，保留已展示的旧项比静默丢新项更安全。 */
export const MAX_PENDING_PERMISSIONS = 16

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

/**
 * 一个 turn 定稿结算出的时长，随 WS `prompt_done` 帧下发（`duration` 字段）：
 * `workMs` = agent 工作时间，`waitMs` = 其中等真人审批的时间。
 */
export interface TurnDuration {
  workMs: number
  waitMs: number
}

export interface ChatMessage {
  id: string
  /**
   * The real `chat_messages.id` row id, when known. Set for hydrated messages
   * (`GET /messages` returns row ids) and for the in-progress turn once the
   * backend pushes its `row_id` down (`turn_snapshot` / `prompt_done`). Absent
   * for messages the frontend minted itself (live streaming before any snapshot,
   * replay reconstruction) — their `id` is a local `genId()` value that does not
   * exist in the DB.
   *
   * Why a separate field instead of reusing `id`: the sync endpoint treats a
   * supplied id as authoritative and updates exactly that row, so claiming a
   * local id is a DB id would silently target nothing. See
   * `messagesToSyncPayload` and `chat_persistence::sync_messages`.
   */
  dbId?: string
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
   * True when this row's `blocks` came from the backend accumulator's raw-frame
   * wrapper (`{"v":1,"frames":[...]}`) and decoded to a non-empty structure.
   * Set only by the hydrate conversion (`ChatView.toChatMessages`); used by
   * `useAcpChat`'s hydrate-settled effect to write the cooked blocks back with
   * the real `dbId` (see `storedRawRowToSyncPayload`). Rows whose frames
   * decoded to nothing are left unmarked — overwriting them with the text
   * fallback would destroy frames a future classifier could interpret.
   */
  rawStored?: boolean
  /**
   * 该 turn 的**结算**工作时长（ms，已扣除 `waitMs`）。来源只有两个：hydrate 路径
   * （`GET /messages`）与 `markDone` 收到的 `prompt_done` 帧载荷。定稿值恒由后端算。
   *
   * 流式期间气泡底部跳动的数字是另一回事：`utils/turnClock` 的本地估算，只渲染、
   * 不入库、不参与定稿，`prompt_done` 一到即被本字段原位取代。
   *
   * `undefined` = 未知（迁移前的历史行、或尚未定稿的在建消息），
   * 语义上区别于 `0`（确实零时长）。
   */
  durationMs?: number | null
  /** 该 turn 内等真人审批的挂起时长（ms）。同上，`undefined` = 未知。 */
  waitMs?: number | null
}

interface ChatSessionState {
  messages: ChatMessage[]
  sending: boolean
  error: string | null
  mode: string | null
  sessionEnded: boolean
  /** 正在从后端重放历史记录（replay_start �? replay_end 之间），�? UI 显示恢复指示�? */
  replaying: boolean
  /**
   * 未决审批队列（按到达序；UI 只显示队首，应答后出队露出下一个）。
   * 后端 PermissionManager 支持并发多个 request_permission，单槽会互相覆盖
   * 导致被覆盖项无 UI 入口、会话卡死。权威清除路径只有 permission_resolved
   * 帧、permissions_synced 对账与 markError（turn 出错 / 连接死亡）。
   */
  pendingPermissions: PendingPermission[]
  usage: Record<string, unknown> | null
  commands: SlashCommand[]
  configOptions: ConfigOption[]
  /**
   * 配置栏置灰只读标志：true = 当前 configOptions 来自 hydrate 注入的快照
   * （GET /messages 下发，会话已结束无活 agent），仅作展示、不可交互。
   * 解除的唯一路径是后续任一 live/replay 的 setConfigOptions 配置帧
   * （applyTopLevelActions 合并时一并置 false）——恢复会话后配置栏自动点亮。
   */
  configReadOnly?: boolean
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
  /**
   * agent 是否声明 `promptCapabilities.embeddedContext`（后端 capabilities 帧下发）。
   * 文件附件的门控（@path 引用共用此能力，但那条链在缺失时降级内联）。undefined =
   * 尚未收到声明，UI 按不支持处理（保守降级）。
   */
  embeddedContextSupported?: boolean
  /** 当前会话所用 agent 的 display_name，用于聊天气泡显示 agent 身份（后端 capabilities 帧下发）。 */
  agentName?: string
  /**
   * ChatView 的 GET /messages hydrate 是否已落定。useAcpChat 据此放行
   * preHydrateBuffer：落定前会改动消息列表的帧先缓冲，避免抢跑 hydrate 丢历史。
   */
  hydrated?: boolean
  /**
   * 历史分页游标（后端 `nextCursor`）：指向比已加载的最旧一条更早的那页。
   * `null`/`undefined` = 已到历史开头，不再上拉加载。唯一信号源，不另存 hasMore。
   */
  historyCursor?: string | null
  /** 上拉加载更早历史的 in-flight 标志（防重入 + 顶部加载指示）。 */
  loadingHistory?: boolean
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
  addUserMessage: (sessionId: string, text: string, images?: ImageBlock[], files?: FileBlock[]) => void
  /** Add a queued message that was lost on disconnect (e.g. WS closed before `prompt_done`).
   *  Renders as a normal user message with `undelivered: true` so the user can see what
   *  they tried to send. Not persisted to DB; cleared on session remount. */
  addUndeliveredMessage: (sessionId: string, text: string) => void
  markDone: (sessionId: string, timing?: TurnDuration) => void
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
  hydrate: (sessionId: string, messages: ChatMessage[], historyCursor?: string | null) => void
  /** 上拉加载更早历史：置 in-flight 标志（防重入）。 */
  beginLoadHistory: (sessionId: string) => void
  /** 前插更早的一页历史并推进游标，同时清 in-flight 标志（单次 set 原子提交）。
   *  消息为空时仍推游标（可能整页被后端去重/过滤），避免上拉卡死。 */
  prependMessages: (
    sessionId: string,
    messages: ChatMessage[],
    historyCursor: string | null,
  ) => void
  /** 置会话 hydrate 落定标志：ChatView 的 GET /messages 落定后调用，放行 useAcpChat 缓冲。 */
  setHydrated: (sessionId: string, hydrated: boolean) => void
  /** 重连续接：用进行中 turn 的快照（已解码 blocks）按 rowId 替换/收编在建 assistant
   *  消息，无匹配则收编末尾 streaming assistant，再无则追加。置 streaming 供 live 帧续接。 */
  applyTurnSnapshot: (
    sessionId: string,
    snapshot: { rowId: string; text: string; blocks: ContentBlock[] },
  ) => void
  /** D7「引用到输入框」通道：写入待插入文本，ChatInput 挂载时按 sessionId 消费。 */
  requestInsert: (sessionId: string, text: string) => void
  /** 消费 pendingInsert（ChatInput 用掉后立即清空，避免切会话后旧引用复活）。 */
  consumeInsert: () => void
  markEnded: (sessionId: string) => void
  clearEnded: (sessionId: string) => void
  /** 审批入队（upsert）：id 已存在则原位替换（重放/重发不产生重复项），否则追加。 */
  setPermission: (sessionId: string, permission: PendingPermission) => void
  /** 按 id 出队（permission_resolved / 用户应答）。 */
  removePermission: (sessionId: string, id: string) => void
  /** 对账：只保留 id 在集合内的审批（permissions_synced 帧携带后端权威 pending 集合）。 */
  reconcilePermissions: (sessionId: string, ids: ReadonlySet<string>) => void
  setReplaying: (sessionId: string, replaying: boolean) => void
  /** 双缓冲原子提交：用攒齐的重放帧从空白状态重建会话，staged 为空时不动现有状态。
   *  等价「清空 + 重放 + finalize」，但不存在清空后无回填的空窗。 */
  commitReplay: (sessionId: string, actions: SessionUpdateAction[]) => void
  setUsage: (sessionId: string, usage: Record<string, unknown>) => void
  setCommands: (sessionId: string, commands: SlashCommand[]) => void
  /**
   * 注入 hydrate 快照（GET /messages 的 configOptions 字段）：已结束会话的
   * 最后已知配置状态。readOnly=true 时配置栏置灰只读；活会话刷新（agentLive）
   * 也注入值以消除配置栏空窗，但不置灰。live/replay 配置帧经
   * applyTopLevelActions 覆盖时自动解除只读，无独立 setConfigOptions setter
   * （防绕过不变式；原零调用的独立 setter 已删，live 路径一直走 applyReplayBatch）。
   */
  setConfigSnapshot: (sessionId: string, options: ConfigOption[], readOnly: boolean) => void
  /** F03: 记录 agent 是否支持图片 prompt（后端 capabilities 帧）。 */
  setImageSupported: (sessionId: string, supported: boolean) => void
  /** 记录 agent 是否支持 embeddedContext（文件附件门控，后端 capabilities 帧）。 */
  setEmbeddedContextSupported: (sessionId: string, supported: boolean) => void
  /** 设置当前会话 agent 的显示名（后端 capabilities 帧下发）。 */
  setAgentName: (sessionId: string, name: string) => void
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
  pendingPermissions: [],
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
  /**
   * D7「引用到输入框」：跨会话一次性插入信号。ChatInput 挂载时以 effect 消费
   * （仅当 sessionId 匹配自身），随后置 null。放顶层而非 per-session，因为它
   * 是「注入输入框」的显式信号，不是会话状态的一部分。
   */
  pendingInsert: { sessionId: string; text: string } | null
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
    ...state,
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
 * 本次 prompt 的计时锚点（本地 epoch）。本地发起时在建 assistant 行还不存在 → 就是此刻；
 * 刷新/重连接回一个仍在跑的 turn 时，末尾已有 hydrate 还原的 streaming 行，其 `createdAt`
 * 是后端**首次防抖 flush 建行**的时刻（略晚于 turn 真实起点，见 chat_persistence.rs），
 * 取它与此刻较早的一个，免得计时器从 0 起跳再一次性追上真实值——宁可少算一段思考期，
 * 也不虚报。`Math.min` 同时兜住服务端时钟超前的情形。
 */
const turnAnchorMs = (state: ChatStoreState, sessionId: string): number => {
  const now = Date.now()
  const last = get(state, sessionId).messages.at(-1)
  return last && last.role === 'assistant' && last.streaming ? Math.min(now, last.createdAt) : now
}

/** 流式 prose（正文/思考）块类型；它们之间可跨类型累积，见 appendProseBlock。 */
type ProseKind = 'text' | 'thought'

/**
 * 把一段流式正文（text）或思考（thought）追加进当前消息的 blocks。
 *
 * 合并策略是「同一 prose 区域内按类型累积」，**不是**「只与紧邻块合并」：
 * 部分 ACP 实现（实测 codebuddy）把同一 turn 的 reasoning 与 message 两条逻辑流
 * 按 token 粒度交错下发——`agent_thought_chunk` 与 `agent_message_chunk` 逐词交替，
 * 且两条流共用同一 `messageId`。只跟紧邻块比较时，一段连续思考会被切成成百上千个
 * 「◆ thinking」块（tps 越高交错越密，用户报告的现象），并在中间夹出大量短正文块。
 * 按类型累积后，一段思考 = 一个 thinking 块（现有调用方的 append 路径共用本函数，
 * 保证 live / replay / hydrate 三条路径渲染一致）。
 *
 * prose 区域 = 连续的 text/thought 块；遇到 tool_call / plan / todo / system / image
 * 等结构化块即终止。**跨区域不合并**：工具调用前后的推理是彼此独立的段落，合并会
 * 打乱「想→做→想」的转录顺序（差异只针对已确证的这类交错，见 AGENTS.md 工程准则 8）。
 *
 * 空串/纯空白 chunk：区域内已有同类块则照常追加（保留流式正文里的空格与换行）；
 * 没有同类块承接时丢弃——追加空串本就是 no-op，独立成块只会渲染成空气泡，并把
 * 前后思考切断（这正是「思考被分段」的另一条成因）。
 *
 * 返回同一数组引用表示「无变化」（调用方据此做整体 no-op）。
 */
const appendProseBlock = (blocks: ContentBlock[], kind: ProseKind, chunk: string): ContentBlock[] => {
  let idx = blocks.length - 1
  while (idx >= 0) {
    const b = blocks[idx]
    if (b.type !== 'text' && b.type !== 'thought') break
    if (b.type === kind) {
      const merged = [...blocks]
      merged[idx] = { ...b, text: b.text + chunk }
      return merged
    }
    idx--
  }
  if (chunk.trim() === '') return blocks
  return [...blocks, { type: kind, text: chunk }]
}

/**
 * 把一段流式正文/思考追加到消息列表末尾的在建 assistant 消息（`streaming`），
 * 没有则新建一条。合并语义见 appendProseBlock；结果与 `appendChunk` /
 * `appendThought` 单块 action 完全一致，三个入口共用，避免策略漂移。
 */
const appendProseToMessages = (
  messages: ChatMessage[],
  kind: ProseKind,
  chunk: string,
): ChatMessage[] => {
  if (chunk === '') return messages
  const next = [...messages]
  const last = next[next.length - 1]
  if (last && last.role === 'assistant' && last.streaming) {
    const blocks = appendProseBlock(last.blocks, kind, chunk)
    if (blocks === last.blocks) return messages
    next[next.length - 1] = kind === 'text'
      ? { ...last, text: last.text + chunk, blocks }
      : { ...last, blocks }
    return next
  }
  const blocks = appendProseBlock([], kind, chunk)
  if (blocks.length === 0) return messages
  next.push({
    id: genId(),
    role: 'assistant',
    text: kind === 'text' ? chunk : '',
    blocks,
    createdAt: Date.now(),
    streaming: true,
  })
  return next
}

/**
 * 纯函数：把多条重放帧合并进现�? messages（追加文�? / 合并 tool / plan / thought
 * 等），返回新�? messages 数组。语义与 `appendChunk` 等单�? action 一致，但只�?
 * 一次全量浅拷贝。重放的历史回合视为已完成，新追加的 assistant 消息 `streaming`
 * 保持 true（重放提交时由 `commitReplay` 统一置 false）。
 */
const applyActionsToMessages = (
  messages: ChatMessage[],
  actions: SessionUpdateAction[],
): ChatMessage[] => {
  // 浅拷贝一次兜底：非 prose 分支就地改 `next`，prose 分支则整段替换为新数组。
  let next = [...messages]
  for (const action of actions) {
    if (action.kind === 'appendText') {
      next = appendProseToMessages(next, 'text', action.text)
    } else if (action.kind === 'appendThought') {
      next = appendProseToMessages(next, 'thought', action.text)
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
      if (last && last.role === 'assistant' && last.streaming) {
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
      if (last && last.role === 'assistant' && last.streaming) {
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
      if (last && last.role === 'assistant' && last.streaming) {
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

/** 纯函数：从空白消息列表重建重放结果。双缓冲提交前用于判断 staged 是否为空。 */
export const buildReplayMessages = (actions: SessionUpdateAction[]): ChatMessage[] =>
  applyActionsToMessages([], actions)

/** 把 mode/usage/commands/configOptions/todos 等顶层字段 action 合并进 state。 */
const applyTopLevelActions = (
  state: ChatStoreState,
  sessionId: string,
  actions: SessionUpdateAction[],
): ChatStoreState => {
  let next = state
  for (const action of actions) {
    if (action.kind === 'setMode') {
      next = patch(next, sessionId, { mode: action.mode })
    } else if (action.kind === 'setUsage') {
      next = patch(next, sessionId, { usage: action.usage })
    } else if (action.kind === 'setCommands') {
      next = patch(next, sessionId, { commands: action.commands })
    } else if (action.kind === 'setConfigOptions') {
      // live/replay 配置帧是权威来源：覆盖值的同时解除快照只读态。
      next = patch(next, sessionId, { configOptions: action.options, configReadOnly: false })
    } else if (action.kind === 'setTodos') {
      next = patch(next, sessionId, { todos: action.entries, todosTitle: action.title })
    }
  }
  return next
}

export const useChatStore = create<ChatStore>((set) => ({
  states: {},
  pendingInsert: null,

  appendChunk: (sessionId, chunk) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = appendProseToMessages(current.messages, 'text', chunk)
      if (messages === current.messages) return state
      return patch(state, sessionId, { messages })
    }),

  appendThought: (sessionId, chunk) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = appendProseToMessages(current.messages, 'thought', chunk)
      if (messages === current.messages) return state
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

  addUserMessage: (sessionId, text, images, files) =>
    set((state) => {
      const current = get(state, sessionId)
      // 纯附件消息不塞空 text block（渲染与落库都无意义）。
      const blocks: ContentBlock[] = text !== '' || (!images?.length && !files?.length)
        ? [{ type: 'text' as const, text }]
        : []
      if (images) blocks.push(...images)
      if (files) blocks.push(...files)
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
      return applyTopLevelActions(patch(state, sessionId, { messages }), sessionId, actions)
    }),

  commitReplay: (sessionId, actions) =>
    set((state) => {
      const messages = applyActionsToMessages([], actions).map((m) =>
        m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
      )
      // staged 为空不提交：保留现有消息（agent 可能不重放历史），由调用方回退。
      if (messages.length === 0) return state
      const prev = state.states[sessionId]
      // 从空白状态重建（等价旧「reset + 重放」语义），但保留连接期已到达的
      // capabilities 信息（imageSupported/embeddedContextSupported/agentName
      // 不随重放下发）。
      const cleared = { ...state.states }
      delete cleared[sessionId]
      removeQueuedFromStorage(sessionId)
      const base = patch({ ...state, states: cleared }, sessionId, {
        messages,
        imageSupported: prev?.imageSupported,
        embeddedContextSupported: prev?.embeddedContextSupported,
        agentName: prev?.agentName,
        hydrated: prev?.hydrated,
        // usage 与上面几项同类：agent 按 turn 推送、不随 session/load 重放。
        // 不保留的话每次重放（恢复进程 / 重连 / 刷新后拉历史）都把用量圆环抹掉，
        // 直到下一个 turn 才重新出现（用户观感「时有时无」）。重放帧真带了
        // usage 更新时，下面的 applyTopLevelActions 会用新值覆盖这里的旧值。
        usage: prev?.usage,
        // 重放是 agent 侧的完整历史，重建后已无「更早一页」可取；显式置 null
        // 而非靠 delete 后的 undefined，以免误读为遗漏。
        historyCursor: null,
      })
      return applyTopLevelActions(base, sessionId, actions)
    }),

  markDone: (sessionId, timing) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = current.messages.map((m) =>
        m.role === 'assistant' && m.streaming
          ? {
              ...m,
              streaming: false,
              // 后端定稿即随 prompt_done 下发耗时，让数字当场出现（不等刷新 hydrate）。
              durationMs: timing?.workMs ?? m.durationMs,
              waitMs: timing?.waitMs ?? m.waitMs,
            }
          : m,
      )
      // 不清 pendingPermissions：turn 结束不代表未决审批失效——审批可能属于仍挂在
      // request_permission 上的更早 turn（后端会持续重放它）。未决审批的权威在
      // 后端 PermissionManager，合法清除路径只有 permission_resolved 广播
      // （resolve / cancel_all）、permissions_synced 对账与 markError（turn 出错 /
      // 连接死亡）。曾在 markDone 清除导致重放 banner 被抹掉、会话卡死无法应答。
      // turn 已定稿：本地实时计时到此为止，此后只呈现后端结算值。
      endTurn(sessionId)
      return patch(state, sessionId, { messages, sending: false })
    }),

  markError: (sessionId, message) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = current.messages.map((m) =>
        m.role === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
      )
      endTurn(sessionId)
      return patch(state, sessionId, { messages, sending: false, error: message, pendingPermissions: [] })
    }),

  beginPrompt: (sessionId) =>
    set((state) => {
      // 计时器与 sending 同生命周期，故在同一次状态变换里起表（见 utils/turnClock）。
      beginTurn(sessionId, turnAnchorMs(state, sessionId))
      return patch(state, sessionId, { sending: true, error: null })
    }),

  setMode: (sessionId, mode) =>
    set((state) => patch(state, sessionId, { mode })),

  setError: (sessionId, message) =>
    set((state) => patch(state, sessionId, { error: message })),

  hydrate: (sessionId, messages, historyCursor) =>
    set((state) => {
      const current = get(state, sessionId)
      if (current.messages.length > 0 || current.replaying) return state
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
      return patch(state, sessionId, { messages, todos, todosTitle, historyCursor })
    }),

  beginLoadHistory: (sessionId) => set((state) => patch(state, sessionId, { loadingHistory: true })),

  prependMessages: (sessionId, messages, historyCursor) =>
    set((state) => {
      const current = get(state, sessionId)
      // 按 id 去重：live 帧或上一页可能已带来同一条（重放/并发场景）。
      const known = new Set(current.messages.map((m) => m.id))
      const older = messages.filter((m) => !known.has(m.id))
      return patch(state, sessionId, {
        messages: older.length > 0 ? [...older, ...current.messages] : current.messages,
        historyCursor,
        loadingHistory: false,
      })
    }),

  setHydrated: (sessionId, hydrated) =>
    set((state) => patch(state, sessionId, { hydrated })),

  applyTurnSnapshot: (sessionId, { rowId, text, blocks }) =>
    set((state) => {
      const current = get(state, sessionId)
      const messages = [...current.messages]
      const idx = messages.findIndex((m) => m.id === rowId)
      const prevCreatedAt =
        idx >= 0
          ? messages[idx].createdAt
          : messages[messages.length - 1]?.role === 'assistant' &&
              messages[messages.length - 1]?.streaming
            ? messages[messages.length - 1].createdAt
            : Date.now()
      const msg: ChatMessage = {
        id: rowId,
        dbId: rowId,
        role: 'assistant',
        text,
        blocks,
        createdAt: prevCreatedAt,
        streaming: true,
      }
      if (idx >= 0) {
        messages[idx] = msg
      } else {
        const lastIdx = messages.length - 1
        const last = messages[lastIdx]
        if (last && last.role === 'assistant' && last.streaming) {
          // 收编末尾 live streaming 消息，统一 id=rowId 供后续快照匹配。
          messages[lastIdx] = msg
        } else {
          messages.push(msg)
        }
      }
      // 看板同步：快照 blocks 可能含最新 todo，扫描并更新（与 hydrate 一致）。
      let todos = current.todos
      let todosTitle = current.todosTitle
      for (let j = blocks.length - 1; j >= 0; j--) {
        const b = blocks[j]
        if (b.type === 'todo') {
          todos = b.entries
          todosTitle = b.title
          break
        }
      }
      return patch(state, sessionId, { messages, todos, todosTitle })
    }),

  markEnded: (sessionId) =>
    set((state) => {
      endTurn(sessionId)
      return patch(state, sessionId, { sessionEnded: true, sending: false })
    }),

  clearEnded: (sessionId) =>
    set((state) => patch(state, sessionId, { sessionEnded: false })),

  setPermission: (sessionId, permission) =>
    set((state) => {
      const current = get(state, sessionId)
      const queue = current.pendingPermissions
      const idx = queue.findIndex((p) => p.id === permission.id)
      // 入队后队列必然非空（含满队列丢弃：既有项仍挂着）→ 本 turn 进入审批等待，
      // 计时暂停。无在建 turn 时 setTurnWaiting 自身 no-op，与后端 turn 门控同构。
      setTurnWaiting(sessionId, true)
      if (idx >= 0) {
        // 原位替换：重连重放/后端重发同一审批不产生重复项
        const next = [...queue]
        next[idx] = permission
        return patch(state, sessionId, { pendingPermissions: next })
      }
      if (queue.length >= MAX_PENDING_PERMISSIONS) {
        console.warn(
          `[ACP] pending permission queue full (${MAX_PENDING_PERMISSIONS}); dropping request ${permission.id}`,
        )
        return state
      }
      return patch(state, sessionId, { pendingPermissions: [...queue, permission] })
    }),

  removePermission: (sessionId, id) =>
    set((state) => {
      const current = get(state, sessionId)
      const next = current.pendingPermissions.filter((p) => p.id !== id)
      // 队列见底才恢复计时（多个并发审批时只 resolve 一个仍算挂着，镜像 wait_depth）
      setTurnWaiting(sessionId, next.length > 0)
      if (next.length === current.pendingPermissions.length) return state
      return patch(state, sessionId, { pendingPermissions: next })
    }),

  reconcilePermissions: (sessionId, ids) =>
    set((state) => {
      const current = get(state, sessionId)
      const kept = current.pendingPermissions.filter((p) => ids.has(p.id))
      setTurnWaiting(sessionId, kept.length > 0)
      if (kept.length === current.pendingPermissions.length) return state
      return patch(state, sessionId, { pendingPermissions: kept })
    }),

  setReplaying: (sessionId, replaying) =>
    set((state) => patch(state, sessionId, { replaying })),

  setUsage: (sessionId, usage) =>
    set((state) => patch(state, sessionId, { usage })),

  setCommands: (sessionId, commands) =>
    set((state) => patch(state, sessionId, { commands })),

  setImageSupported: (sessionId, supported) =>
    set((state) => patch(state, sessionId, { imageSupported: supported })),

  setEmbeddedContextSupported: (sessionId, supported) =>
    set((state) => patch(state, sessionId, { embeddedContextSupported: supported })),

  setAgentName: (sessionId, name) =>
    set((state) => patch(state, sessionId, { agentName: name })),

  patchConfigOptionValue: (sessionId, configId, value) =>
    set((state) => {
      const current = get(state, sessionId)
      const configOptions = current.configOptions.map((o) =>
        o.id === configId ? { ...o, currentValue: value } : o,
      )
      return patch(state, sessionId, { configOptions })
    }),

  setConfigSnapshot: (sessionId, options, readOnly) =>
    set((state) => patch(state, sessionId, { configOptions: options, configReadOnly: readOnly })),

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
      // 会话状态整条抹掉：计时器必须跟着停表，否则条目永久留在 turnClock 里。
      endTurn(sessionId)
      // 同步清掉 sessionStorage 里残留的 queue 缓存（防止 F5 后 stale 数据复活）
      removeQueuedFromStorage(sessionId)
      return { ...state, states: next }
    }),

  requestInsert: (sessionId, text) =>
    set({ pendingInsert: { sessionId, text } }),

  consumeInsert: () =>
    set({ pendingInsert: null }),
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
  /** Authoritative DB row id when known — backend updates exactly that row. */
  id?: string
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
 * - `id` is forwarded **only** from `ChatMessage.dbId` (a real row id), never
 *   from the local `id`. With an id the backend updates that one row and
 *   inserts nothing; without one it falls back to text matching. Passing a
 *   local id would match no row and silently drop the write.
 */
/**
 * 落库形态的 blocks：图片只保留缩略图。
 *
 * 原图不进库——历史气泡的显示尺寸只有 240×200，存原图会让分页预算和首屏为一张图
 * 付出上百倍体积。后端落库同样只存缩略图（见 src/ws/acp.rs），这里保证前端回写
 * （hydrate 后的 cooked blocks）不会把原图再塞回去。
 */
function toPersistedBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.map((b) => {
    if (b.type !== 'image') return b
    return b.thumb
      ? { type: 'image', mimeType: b.thumb.mimeType, data: b.thumb.data }
      : { type: 'image', mimeType: b.mimeType, data: b.data }
  })
}

export function messagesToSyncPayload(
  messages: readonly ChatMessage[],
): SyncMessagePayload[] {
  const payload: SyncMessagePayload[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (m.undelivered) continue
    const entry: SyncMessagePayload = { role: m.role, text: m.text }
    if (m.dbId) {
      entry.id = m.dbId
    }
    if (m.blocks.length) {
      entry.blocks = JSON.stringify(toPersistedBlocks(m.blocks))
    }
    payload.push(entry)
  }
  return payload
}

/**
 * Build the sync payload for a turn that just finished, targeting the single DB row the
 * backend accumulator created for it (`rowId`).
 *
 * Must be called **before `markDone`**: the turn's messages are identified by the
 * `streaming` flag, which `markDone` clears.
 *
 * - Multiple messages collapse into one entry — the backend keeps one row per turn, and
 *   hydrating that row yields one message again.
 * - `text` is a placeholder: the id-carrying path never writes `text` (its authority is
 *   the backend accumulator), it only replaces the raw-frame `blocks` with cooked ones.
 * - Empty `blocks` → empty payload: nothing to converge, and a blank write would only
 *   destroy the raw frames the backend already stored.
 */
export function turnToSyncPayload(
  messages: readonly ChatMessage[],
  rowId: string,
): SyncMessagePayload[] {
  const live = messages.filter((m) => m.role === 'assistant' && m.streaming)
  const blocks = live.flatMap((m) => m.blocks)
  if (blocks.length === 0) return []
  return [
    {
      id: rowId,
      role: 'assistant',
      text: live.map((m) => m.text).join(''),
      blocks: JSON.stringify(blocks),
    },
  ]
}

/**
 * Build the sync payload that converges a RAW-stored row left behind by a turn whose
 * `prompt_done` never reached a live frontend (user switched away / closed the page).
 * The row's `blocks` are still the raw-frame wrapper; hydrate decoded them to cooked
 * blocks, and writing those back with the real `dbId` updates exactly that row and
 * inserts nothing (id path in `chat_persistence::sync_messages`).
 *
 * Skipped cases:
 * - streaming rows — the backend accumulator is still writing raw frames for the
 *   in-progress turn; `prompt_done`'s `turnToSyncPayload` covers them once it ends.
 * - empty cooked `blocks` — a blank write would only destroy the raw frames (same
 *   rule as `turnToSyncPayload`).
 */
export function storedRawRowToSyncPayload(m: ChatMessage): SyncMessagePayload | null {
  if (!m.rawStored || !m.dbId) return null
  if (m.streaming) return null
  if (m.blocks.length === 0) return null
  return {
    id: m.dbId,
    role: m.role,
    text: m.text,
    blocks: JSON.stringify(toPersistedBlocks(m.blocks)),
  }
}
