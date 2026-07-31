import { useEffect, useRef, useCallback, useState } from 'react'
import { useChatStore, messagesToSyncPayload, buildReplayMessages, type PlanEntry, type ConfigOption, type SlashCommand, type SessionUpdateAction, type PendingPermission, type ContentBlock } from '../stores/chatStore'
import { useAttention } from '../hooks/useAttention'
import { useAppStore } from '../stores/appStore'
import type { ImageAttachment } from '../utils/imageAttachment'

export type AcpConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error'

interface UseAcpChatOptions {
  sessionId: string | null
}

interface UseAcpChatResult {
  connectionState: AcpConnectionState
  sendPrompt: (text: string, images?: ImageAttachment[]) => void
  cancel: () => void
  restore: () => void
  respondPermission: (id: string, optionId: string) => void
  setConfigOption: (configId: string, value: string) => void
}

interface SessionUpdateFrame {
  session_id?: unknown
  update?: unknown
}

interface ServerFrame {
  type: 'session_update' | 'prompt_done' | 'prompt_error' | 'error' | 'replay_start' | 'replay_end' | 'permission_request' | 'process_alive' | 'terminal_activity' | 'capabilities' | 'turn_snapshot' | 'turn_state'
  code?: string
  data?: SessionUpdateFrame
  stop_reason?: string
  message?: string
  id?: string
  request?: Record<string, unknown>
  alive?: boolean
  command?: string
  args?: string[]
  status?: string
  exit_code?: number | null
  image?: boolean
  agent_name?: string
  /** session_update: turn 内单调 seq（config/commands/重放帧无此字段），用于重连去重。 */
  seq?: number
  /** turn_state: 连接时是否有进行中的 assistant turn。 */
  active?: boolean
  /** turn_snapshot: 进行中 turn 的 DB 行 id（= assistant 消息 id），供按 id 续接替换。 */
  row_id?: string
  /** turn_snapshot: 已累积的纯文本；blocks 为 `{"v":1,"frames":[...]}` 原始帧包裹 JSON。 */
  text?: string
  blocks?: string
}

// hydrate 落定前需缓冲的帧：这些会改动消息列表，若抢在 GET /messages 之前建消息，
// 会让 hydrate 因 messages 非空而 bail（丢历史）。其余帧不触碰 hydrate 守卫。
const HYDRATE_GATED_FRAMES: ReadonlySet<ServerFrame['type']> = new Set([
  'session_update',
  'turn_snapshot',
  'turn_state',
  'prompt_done',
  'prompt_error',
])

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

// 工具调用详情严格按 ACP v1 `ToolCall` 协议结构解析（见 agent-client-protocol
// schema v1::tool_call）：`content` 是 ToolCallContent 数组（content / diff /
// terminal），另有 `raw_input` / `raw_output` 原始 JSON。OpenCode 等客户端把
// 文件改动放在 content[].diff（path/oldText/newText），把命令参数放在
// raw_input——这些都不是「content 字符串」，此前漏读导致卡片只剩标题。
// 按 §8 多实现兼容性：依据协议真实字段解析，不臆测上游结构。
function extractToolContent(inner: Record<string, unknown>): string | undefined {
  const parts: string[] = []

  const content = inner['content']
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const c = item as Record<string, unknown>
      if (c['type'] === 'diff') {
        parts.push(synthUnifiedDiff(c))
      } else if (c['type'] === 'content') {
        const text = extractContentText(c['content'])
        if (text) parts.push(text)
      } else {
        // 未知 content 变体，兜底序列化其有效载荷
        const payload = c['content'] ?? c['text']
        if (payload && typeof payload === 'object') {
          parts.push(JSON.stringify(payload, null, 2))
        }
      }
    }
  } else if (typeof content === 'string' && content) {
    // 非标准但兼容：个别实现直接给字符串 content
    parts.push(content)
  }

  // diff 优先展示；无 diff 时兜底显示 raw_input / raw_output（工具入参/结果）。
  // 键名同时覆盖 snake_case 与 camelCase：ACP schema serde rename 为 camelCase
  // （permission request 透传即此形态），个别实现/中转层用 snake_case。
  if (parts.length === 0) {
    for (const key of ['raw_input', 'rawInput', 'raw_output', 'rawOutput', 'input', 'arguments', 'params']) {
      const v = inner[key]
      if (v && typeof v === 'object') {
        try {
          parts.push(JSON.stringify(v, null, 2))
        } catch {
          parts.push(String(v))
        }
      }
    }
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined
}

// 把 ACP Diff（path / oldText / newText）合成标准 unified diff 文本，
// 交给已有的 DiffView 彩色渲染。oldText 缺省视为新建文件。
function synthUnifiedDiff(d: Record<string, unknown>): string {
  const path = typeof d['path'] === 'string' ? d['path'] : 'file'
  const oldText = typeof d['oldText'] === 'string' ? d['oldText'] : ''
  const newText = typeof d['newText'] === 'string' ? d['newText'] : ''
  const oldLines = oldText.length ? oldText.split('\n') : []
  const newLines = newText.length ? newText.split('\n') : []
  const oldName = oldLines.length ? path : '/dev/null'
  const newName = newLines.length ? path : '/dev/null'
  const header = `--- ${oldName}\n+++ ${newName}`
  // 极简 unified diff：逐行 +/-，无 hunk 行号（DiffView 仅靠 +/- 着色，
  // 不依赖 @@ 即可识别，见 looksLikeDiff）。
  const body = [
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ].join('\n')
  return `${header}\n${body}`
}

// ToolCallLocation 按 ACP schema 是 { path, line? } 对象；个别实现直接给
// 字符串路径。两种形态统一归一为路径字符串数组（§8 多实现兼容性）。
function extractLocations(inner: Record<string, unknown>): string[] | undefined {
  const raw = inner['locations']
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  for (const l of raw) {
    if (typeof l === 'string') {
      out.push(l)
    } else if (l && typeof l === 'object') {
      const p = (l as Record<string, unknown>)['path']
      if (typeof p === 'string') out.push(p)
    }
  }
  return out.length > 0 ? out : undefined
}

// 解析 RequestPermissionRequest（后端 serde_json::to_value 全量透传）。
// 标准 v1 结构：{ sessionId, toolCall: ToolCallUpdate, options: [...] }，
// toolCall 与 session_update 的 ToolCallUpdate 同构，故复用 extractToolContent
// 提取 diff / content / rawInput 预览；tool_call（snake_case）与顶层
// tool_name/toolName 为非标准实现的回退路径。无预览数据时字段缺省，
// banner 降级为纯文本展示（F01 设计决策 §3.1）。
export function parsePermissionRequest(req: Record<string, unknown>): Omit<PendingPermission, 'id'> {
  const rawOptions = Array.isArray(req['options']) ? req['options'] : []
  const options = rawOptions
    .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
    .map((o) => ({
      option_id: String(o['optionId'] ?? o['option_id'] ?? ''),
      kind: String(o['kind'] ?? ''),
      name: typeof o['name'] === 'string' ? o['name'] : undefined,
    }))
  const tcRaw = req['toolCall'] ?? req['tool_call']
  const toolCall = tcRaw && typeof tcRaw === 'object' ? (tcRaw as Record<string, unknown>) : null
  const title = typeof toolCall?.['title'] === 'string' && toolCall['title'] ? (toolCall['title'] as string) : undefined
  const toolName = title
    ?? (typeof req['tool_name'] === 'string' ? (req['tool_name'] as string) : undefined)
    ?? (typeof req['toolName'] === 'string' ? (req['toolName'] as string) : undefined)
  const toolKind = typeof toolCall?.['kind'] === 'string' ? (toolCall['kind'] as string) : undefined
  const content = toolCall ? extractToolContent(toolCall) : undefined
  const locations = toolCall ? extractLocations(toolCall) : undefined
  return { options, toolName, toolKind, content, locations }
}

// --- Todo / task-list detection (非 ACP 标准，各 agent 私有约定) ---
//
// 按 §8 多实现兼容性：不绑定某个 agent 的字段名，而是按「内容形态」识别，
// 并对 status / priority 做显式回退，以兼容不同上游的差异：
//   - OpenCode 把 todos 当作工具调用，payload 为 JSON 数组，元素含
//     { content, status: in_progress|pending, priority: high|medium }；
//   - 其它 agent 可能把数组放在 todos / tasks / items / raw_input / raw_output，
//     或用不同的 status 文案（doing / done）。均在此统一归一。
import type { TodoEntry, TodoStatus, TodoPriority } from '../stores/chatStore'

const TODO_ARRAY_FIELDS = ['todos', 'tasks', 'items', 'todo_list', 'task_list', 'content', 'raw_input', 'raw_output']

function normalizeTodoStatus(raw: unknown): TodoStatus {
  if (typeof raw !== 'string') return 'pending'
  const s = raw.toLowerCase().trim()
  if (s === 'in_progress' || s === 'in progress' || s === 'active' || s === 'doing' || s === 'started') return 'in_progress'
  if (s === 'completed' || s === 'done' || s === 'finished' || s === 'complete') return 'completed'
  return 'pending'
}

function normalizeTodoPriority(raw: unknown): TodoPriority {
  if (typeof raw !== 'string') return 'medium'
  const p = raw.toLowerCase().trim()
  if (p === 'high' || p === 'urgent' || p === 'critical') return 'high'
  if (p === 'low' || p === 'minor') return 'low'
  return 'medium'
}

// 从任意值里尝试解析出 todo 数组；识别不出返回 null（调用方回落为普通工具卡片）。
function parseTodoEntries(value: unknown): TodoEntry[] | null {
  if (Array.isArray(value)) {
    // value is already an array, proceed below
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    // 形如 "3 todos" 的计数描述不是清单，跳过；只解析 JSON 数组。
    if (!trimmed.startsWith('[')) return null
    try {
      const parsed = JSON.parse(trimmed)
      if (!Array.isArray(parsed)) return null
      value = parsed
    } catch {
      return null
    }
  } else {
    return null
  }
  const arr = value as unknown[]
  if (arr.length === 0) return null
  // 必须至少有一个元素具备 todo 形态（content 字符串 + status 字段），否则不算 todo。
  const looksLikeTodo = (arr as unknown[]).some(
    (e) => !!e && typeof e === 'object' && typeof (e as Record<string, unknown>)['content'] === 'string' && 'status' in (e as Record<string, unknown>),
  )
  if (!looksLikeTodo) return null
  return (arr as unknown[])
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
    .map((e) => ({
      content: typeof e['content'] === 'string' ? e['content'] : String(e['content'] ?? ''),
      status: normalizeTodoStatus(e['status']),
      priority: normalizeTodoPriority(e['priority'] ?? e['importance']),
    }))
}

function extractTodoList(inner: Record<string, unknown>): TodoEntry[] | null {
  // 先把所有候选字段(含 content/raw_input/raw_output)尝试直接解析。
  for (const field of TODO_ARRAY_FIELDS) {
    const v = inner[field]
    if (v === undefined || v === null) continue
    const entries = parseTodoEntries(v)
    if (entries) return entries
  }
  // 候选字段若本身是对象（如 raw_input: { todos: [...] }），递归一层找数组值，
  // 以兼容把 todo 数组包在入参对象里的上游（不绑定字段名）。
  for (const field of ['raw_input', 'raw_output', 'input', 'arguments', 'params', 'content']) {
    const v = inner[field]
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const val of Object.values(v as Record<string, unknown>)) {
        const entries = parseTodoEntries(val)
        if (entries) return entries
      }
    }
  }
  // 兜底：直接是数组（不带外层字段名）。
  return parseTodoEntries(inner)
}

// --- Classifier ---

// `SessionUpdateAction` 类型已移至 chatStore（供 applyReplayBatch 复用）。

const DROP_VARIANTS: ReadonlySet<string> = new Set([
  'SessionInfoUpdate', 'session_info_update',
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

  // UserMessageChunk → user message (ACP replay)
  const userMsgChunk = getVariantInner(obj, 'UserMessageChunk')
  if (userMsgChunk) {
    const text = extractContentText(userMsgChunk['content']) ?? (typeof userMsgChunk['text'] === 'string' ? userMsgChunk['text'] : null)
    const messageId = typeof userMsgChunk['messageId'] === 'string' ? userMsgChunk['messageId'] : undefined
    if (text !== null) return { kind: 'addUserMessage', text, messageId }
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

  // ToolCall / ToolCallUpdate — both upsert by toolCallId. ToolCallUpdate is a
  // partial event: title/status are usually absent, so emit them as undefined and
  // let the store merge into the existing card rather than fan out into
  // [ToolCallUpdate] system chips.
  if (TOOL_VARIANTS.has(variant)) {
    const inner = getVariantInner(obj, variant) ?? obj
    const titleRaw = inner['title'] ?? inner['name'] ?? inner['toolName']
    const title = typeof titleRaw === 'string' && titleRaw ? titleRaw : undefined
    const idRaw = inner['toolCallId']
    const toolCallId = typeof idRaw === 'string' && idRaw ? idRaw : title
    if (toolCallId) {
      const statusRaw = inner['status']
      const status = typeof statusRaw === 'string' ? statusRaw : undefined
      const toolKind = typeof inner['kind'] === 'string' ? inner['kind'] : undefined
      const content = extractToolContent(inner)
      const locations = extractLocations(inner)
      // 工具调用内容若形如任务清单（todos / tasks），语义化为 TodoBlock，
      // 而非把 JSON 数组塞进普通工具卡片。识别失败则回落为普通工具调用。
      const todos = extractTodoList(inner)
      if (todos) {
        return { kind: 'setTodos', title, entries: todos }
      }
      // DEV 诊断：标题疑似 todo（"N todos"）却未识别，打印原始结构定位字段。
      if (import.meta.env.DEV && title && /\btodos?\b/i.test(title)) {
        console.debug('[ACP todo?] raw inner keys:', Object.keys(inner), '| sample:', JSON.stringify(inner).slice(0, 600))
      }
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

  // UsageUpdate
  if (variant === 'UsageUpdate' || variant === 'usage_update') {
    const inner = getVariantInner(obj, variant) ?? obj
    return { kind: 'setUsage', usage: inner }
  }

  // AvailableCommandsUpdate
  if (variant === 'AvailableCommandsUpdate' || variant === 'available_commands_update') {
    const inner = getVariantInner(obj, variant) ?? obj
    const rawCmds = inner['commands'] ?? inner['availableCommands']
    if (Array.isArray(rawCmds)) {
      const commands: SlashCommand[] = rawCmds
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c) => {
          const input = c['input'] as Record<string, unknown> | undefined
          return {
            name: String(c['name'] ?? ''),
            description: String(c['description'] ?? ''),
            hint: input && typeof input['hint'] === 'string' ? (input['hint'] as string) : undefined,
          }
        })
        .filter((c) => c.name)
      return { kind: 'setCommands', commands }
    }
    return { kind: 'drop' }
  }

  // ConfigOptionUpdate — ACP flattens `kind` (tag="type") into the option object,
  // so a select reads { id, name, category, type:"select", currentValue, options }.
  if (variant === 'ConfigOptionUpdate' || variant === 'config_option_update') {
    const inner = getVariantInner(obj, variant) ?? obj
    const rawOptions = inner['config_options'] ?? inner['configOptions']
    if (Array.isArray(rawOptions)) {
      const options: ConfigOption[] = rawOptions
        .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object')
        .map((o) => {
          const type = o['type']
          const isBoolean = type === 'boolean' || type === 'Boolean'
          const currentValue = String(o['current_value'] ?? o['currentValue'] ?? '')
          let opts: { value: string; name: string }[]
          if (isBoolean) {
            opts = [
              { value: 'true', name: 'On' },
              { value: 'false', name: 'Off' },
            ]
          } else {
            const rawOpts = o['options']
            opts = Array.isArray(rawOpts)
              ? rawOpts
                  .filter((op): op is Record<string, unknown> => !!op && typeof op === 'object')
                  .map((op) => ({ value: String(op['value'] ?? ''), name: String(op['name'] ?? op['value'] ?? '') }))
              : []
          }
          const category = typeof o['category'] === 'string' ? o['category'] : 'other'
          const normalizedValue = isBoolean ? String(currentValue === 'true') : currentValue
          return {
            id: String(o['id'] ?? ''),
            name: String(o['name'] ?? ''),
            category,
            currentValue: normalizedValue,
            options: opts,
          }
        })
        .filter((o) => o.id && o.options.length > 0)
      return { kind: 'setConfigOptions', options }
    }
    return { kind: 'drop' }
  }

  if (DROP_VARIANTS.has(variant)) return { kind: 'drop' }

  return { kind: 'pushSystem', label: variant }
}

// --- Stored-frame decoding ---
//
// 后端把进行中/已完成的 assistant turn 以 `{"v":1,"frames":[<update>,...]}` 原始帧
// 包裹持久化（见 turn_accumulator.rs），而非 cooked ContentBlock[]。DB hydrate 与
// turn_snapshot 都要把这些原始帧还原成 blocks——复用同一套 live 分类器，杜绝
// TS/Rust 双份分类逻辑（AGENTS.md §8 / 禁 Copy-Paste）。

/** 把 `{"v":1,"frames":[...]}` 原始帧包裹还原成结构化 blocks（分类 → buildReplayMessages）。 */
function rawFramesToBlocks(wrapperJson: string): ContentBlock[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(wrapperJson)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const frames = (parsed as Record<string, unknown>)['frames']
  if (!Array.isArray(frames)) return []
  const actions = frames.map((f) => classifySessionUpdate(normalizeSessionUpdate(f)))
  return buildReplayMessages(actions).flatMap((m) => m.blocks)
}

/** hydrate 入口：cooked 数组原样返回；原始帧包裹解码；未知形状返回 null（调用方回退纯文本）。 */
export function decodeStoredBlocks(raw: string): ContentBlock[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) return parsed as ContentBlock[]
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['frames'])) {
    return rawFramesToBlocks(raw)
  }
  return null
}

// --- Hook ---

export function useAcpChat({ sessionId }: UseAcpChatOptions): UseAcpChatResult {
  const [connectionState, setConnectionState] = useState<AcpConnectionState>('disconnected')
  const wsRef = useRef<WebSocket | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId
  const isReplaying = useRef(false)
  const suppressReplay = useRef(false)
  const isManualRestore = useRef(false)
  // 重放 staging 缓冲：重放帧全部攒在这里（不进渲染态），replay_end 时非空才
  // 原子提交（双缓冲）。重放失败/为空时丢弃，现有消息不受影响。
  const replayBuffer = useRef<SessionUpdateAction[]>([])
  // 实时流式缓冲：文本/thinking chunk 高频到达时，攒进同一动画帧一次性提交，
  // 把「每 chunk 一次重渲染」降为「每帧最多一次」——IDE 文本流应有的朴素节流，
  // 非特效：输出速度不变，只是合并提交。工具/plan/权限等结构性 action 仍即时生效。
  const liveBuffer = useRef<SessionUpdateAction[]>([])
  const liveRaf = useRef<number | null>(null)
  // 重连续接：进行中 turn 的 seq 高水位。收到 turn_snapshot 或 live session_update
  // 时推高；prompt_done/turn_state(inactive) 清空。subscribe-before-snapshot 造成的
  // 重叠帧（seq<=水位）据此丢弃，避免重复渲染（见 §4 对账）。
  const inProgressSeq = useRef<number | null>(null)
  // hydrate 门控：ChatView 的 GET /messages 落定前，把会影响消息列表的帧（turn_snapshot
  // /session_update/turn_state/prompt_*）攒在此缓冲，避免抢在 hydrate 之前建消息导致
  // hydrate 因 messages 非空而 bail（丢历史）。落定后按序回放。重连（无 remount）时
  // hydrated 已 true，帧即时派发不入缓冲。
  const preHydrateBuffer = useRef<ServerFrame[]>([])
  const hydratedRef = useRef(false)
  const frameHandlerRef = useRef<((frame: ServerFrame) => void) | null>(null)
  const attention = useAttention()

  // ChatView hydrate 落定信号（每会话），用于放行 preHydrateBuffer。
  const hydrated = useChatStore((s) => (sessionId ? s.states[sessionId]?.hydrated : false) ?? false)

  const flushLiveBuffer = useCallback(() => {
    liveRaf.current = null
    const sid = sessionIdRef.current
    if (!sid) return
    const batch = liveBuffer.current
    if (batch.length === 0) return
    liveBuffer.current = []
    useChatStore.getState().applyReplayBatch(sid, batch)
  }, [])

  // 把当前 store 的完整消息（含结构化 blocks）写回 DB，刷新后可还原。
  // 不再合并相邻 assistant——每条消息独立对应一行，与实时 insert_message 粒度一致，
  // 确保 sync_messages 的 (session, role, text) 去重能精确命中并 UPDATE blocks。
  // 过滤规则（undelivered 跳过、只 user/assistant 入库）抽到 chatStore.messagesToSyncPayload
  // 纯函数里，便于单测。
  const syncToDb = useCallback(() => {
    const sid = sessionIdRef.current
    if (!sid) return
    const msgs = useChatStore.getState().states[sid]?.messages ?? []
    const payload = messagesToSyncPayload(msgs)
    if (payload.length === 0) return
    if (import.meta.env.DEV) {
      console.debug('[ACP sync]', payload.length, 'msgs,', payload.reduce((n, p) => n + p.text.length, 0), 'chars')
    }
    fetch(`/api/v1/sessions/${encodeURIComponent(sid)}/messages/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: payload }),
    }).catch(() => {})
  }, [])

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
    inProgressSeq.current = null
    preHydrateBuffer.current = []

    ws.onopen = () => {
      if (disposed) { ws.close(); return }
      setConnectionState('connected')
      const sid = sessionIdRef.current
      if (sid) useChatStore.getState().setError(sid, null)
    }

    // 帧派发核心：live 路径与 preHydrateBuffer 回放共用。挂到 ref 供 hydrated 落定
    // 后的 flush effect 调用（闭包捕获当前连接的 ws）。
    const dispatchFrame = (frame: ServerFrame) => {
      const sid = sessionIdRef.current
      if (!sid) return
      const s = useChatStore.getState()
      switch (frame.type) {
        case 'session_update': {
          const canonical = normalizeSessionUpdate(frame.data?.update)
          const action = classifySessionUpdate(canonical)
          if (isReplaying.current && suppressReplay.current) {
            // 已有历史：丢弃重放的内容帧，但放行配置/命令/模式等状态同步帧。
            if (
              action.kind === 'setConfigOptions' ||
              action.kind === 'setCommands' ||
              action.kind === 'setMode' ||
              action.kind === 'setUsage'
            ) {
              useChatStore.getState().applyReplayBatch(sid, [action])
            }
            break
          }
          // 重放期间：全部攒进 staging 缓冲，replay_end 时一次性原子提交。
          if (isReplaying.current && !suppressReplay.current) {
            replayBuffer.current.push(action)
            break
          }
          // seq 去重：subscribe-before-snapshot 的重叠窗口会重复推送 seq<=水位 的帧，
          // 已在 turn_snapshot 中体现，丢弃避免重复渲染。无 seq 的帧（config/commands）
          // 不受门控，正常放行。
          if (
            inProgressSeq.current != null &&
            typeof frame.seq === 'number' &&
            frame.seq <= inProgressSeq.current
          ) {
            if (import.meta.env.DEV) console.debug('[ACP seq-drop]', frame.seq, '<=', inProgressSeq.current)
            break
          }
          if (typeof frame.seq === 'number') inProgressSeq.current = frame.seq
          // ALL actions → live buffer, flushed once per rAF frame via
          // applyReplayBatch (single set() call = one re-render per frame).
          switch (action.kind) {
            case 'appendText':
            case 'appendThought':
            case 'upsertTool':
            case 'setPlan':
            case 'setTodos':
            case 'setMode':
            case 'setUsage':
            case 'setCommands':
            case 'setConfigOptions':
            case 'pushSystem':
              liveBuffer.current.push(action)
              if (liveRaf.current === null) {
                liveRaf.current = requestAnimationFrame(flushLiveBuffer)
              }
              break
            case 'drop':
              if (import.meta.env.DEV) console.debug('[ACP drop]', frame.data?.update)
              break
          }
          break
        }
        case 'prompt_done':
          // 先 flush 残留流式 chunk，避免结尾丢字，再标记完成。
          if (liveRaf.current !== null) {
            cancelAnimationFrame(liveRaf.current)
            liveRaf.current = null
          }
          flushLiveBuffer()
          s.markDone(sid)
          // assistant turn 已由后端累积器实时落库，前端不再回写。清空 seq 水位，
          // 下一 turn 从零开始（不做 seq 门控）。
          inProgressSeq.current = null
          // Drain queued follow-up: 用户在 agent 忙碌期按回车存到 chatStore.queuedMessage
          // 的下一条消息在 agent 跑完这一轮后自动发出。N=1 语义：只有一条可排队，发完即清空。
          // 与 useChatStore.addUserMessage/sendPrompt 等价的内联逻辑：避免调用 useCallback
          // （避免 TDZ + 闭包陈旧值）。见 docs/adr/0001-acp-queue-drain-location.md。
          {
            const fresh = useChatStore.getState()
            const queued = fresh.states[sid]?.queuedMessage
            if (queued && queued.trim()) {
              const trimmed = queued.trim()
              fresh.clearQueuedMessage(sid)
              fresh.addUserMessage(sid, trimmed)
              try {
                ws.send(JSON.stringify({ type: 'prompt', text: trimmed }))
                fresh.beginPrompt(sid)
              } catch {
                fresh.markError(sid, 'Failed to send queued message — connection unavailable')
              }
            } else if (!frame.stop_reason?.toLowerCase().includes('cancel')) {
              // 与 tmux 链路表现一致（Sidebar 在 running→idle 转换 fire 'done'）；
              // 用户主动取消不算完成，排队续发意味着 agent 还没歇。
              attention.fire(sid, sid, 'done')
            }
          }
          break
        case 'prompt_error':
          s.markError(sid, frame.message ?? 'prompt failed')
          // 与 tmux 链路的 attention_reason=error 表现一致
          attention.fire(sid, sid, 'error')
          break
        case 'error':
          // 重放中途失败（如 load_failed 时后端以 error 代替 replay_end）：
          // 终止 staging 丢弃已攒帧，保留现有消息，解除「恢复中」状态。
          if (isReplaying.current) {
            isReplaying.current = false
            suppressReplay.current = false
            isManualRestore.current = false
            replayBuffer.current = []
            useChatStore.getState().setReplaying(sid, false)
          }
          if (frame.code === 'session_not_found') {
            s.markEnded(sid)
          } else {
            s.setError(sid, frame.message ?? 'server error')
          }
          break
        case 'terminal_activity':
          s.upsertTerminalActivity(sid, {
            id: frame.id ?? '',
            command: frame.command ?? '',
            args: frame.args ?? [],
            status: frame.status === 'exited' ? 'exited' : 'created',
            exit_code: frame.exit_code ?? null,
          })
          break
        case 'replay_start': {
          isReplaying.current = true
          replayBuffer.current = []
          const msgs = s.states[sid]?.messages
          // 手动 restore 必须走完整重放（DB hydrate 的旧快照不完整）。
          suppressReplay.current = !isManualRestore.current && !!(msgs && msgs.length > 0)
          if (!suppressReplay.current) {
            // 不清空现有消息：重放帧进 staging，replay_end 非空才原子替换（双缓冲）。
            // 重放失败/为空（agent 可能不推历史）时保留原内容，不会出现空白空窗。
            useChatStore.getState().setReplaying(sid, true)
          }
          break
        }
        case 'replay_end': {
          const wasSuppressed = suppressReplay.current
          const wasManual = isManualRestore.current
          isReplaying.current = false
          suppressReplay.current = false
          isManualRestore.current = false
          const staged = replayBuffer.current
          replayBuffer.current = []
          if (!wasSuppressed) {
            if (buildReplayMessages(staged).length > 0) {
              useChatStore.getState().commitReplay(sid, staged)
              // 重放历史只活在内存 store，刷新即丢 —— 写回 DB。
              syncToDb()
            } else {
              // 空重放：session/load 是否重放历史为 agent 可选行为，保留现有消息，
              // 仅应用状态同步帧；手动恢复时提示用户历史未返回。
              const stateActions = staged.filter(
                (a) =>
                  a.kind === 'setMode' ||
                  a.kind === 'setUsage' ||
                  a.kind === 'setCommands' ||
                  a.kind === 'setConfigOptions',
              )
              if (stateActions.length > 0) {
                useChatStore.getState().applyReplayBatch(sid, stateActions)
              }
              if (wasManual) {
                useChatStore.getState().pushSystemEvent(sid, 'chat.replay.empty')
              }
            }
          }
          useChatStore.getState().setReplaying(sid, false)
          s.clearEnded(sid)
          break
        }
        case 'permission_request': {
          const req = frame.request ?? {}
          if (frame.id) {
            s.setPermission(sid, { id: frame.id, ...parsePermissionRequest(req) })
            // 触发持续闪烁提醒：agent 在等用户决策（对应后端 requires_action 语义）
            attention.fire(sid, sid, 'decision')
          }
          break
        }
        case 'process_alive':
          // 后端进程存活状态事件驱动更新（替代轮询）：即时刷新指示灯。
          if (typeof frame.alive === 'boolean') {
            useAppStore.getState().setAcpProcessAlive(sid, frame.alive)
          }
          break
        case 'capabilities':
          // F03: agent 是否支持图片 prompt（initialize 的 promptCapabilities.image）
          if (typeof frame.image === 'boolean') {
            useChatStore.getState().setImageSupported(sid, frame.image)
          }
          // 聊天气泡显示 agent 身份：后端下发所用 agent 的 display_name
          if (typeof frame.agent_name === 'string') {
            useChatStore.getState().setAgentName(sid, frame.agent_name)
          }
          break
        case 'turn_snapshot': {
          // 重连续接：用进行中 turn 的快照按 row_id 替换/收编在建 assistant 消息，
          // 并把 seq 水位置为快照 seq——后续 live 帧 seq 需大于它才应用（丢弃
          // subscribe-before-snapshot 的重叠重复帧）。
          const blocks = frame.blocks ? rawFramesToBlocks(frame.blocks) : []
          s.applyTurnSnapshot(sid, {
            rowId: frame.row_id ?? '',
            text: frame.text ?? '',
            blocks,
          })
          if (typeof frame.seq === 'number') inProgressSeq.current = frame.seq
          break
        }
        case 'turn_state':
          if (frame.active === false) {
            // turn 在断连期间已结束的兜底：定稿任何残留 streaming 消息。
            s.markDone(sid)
            inProgressSeq.current = null
          } else if (frame.active === true) {
            // 重连到进行中 turn：置 sending 以显示思考指示器。
            s.beginPrompt(sid)
          }
          break
        default:
          // 未识别的帧类型：不静默吞掉，记录以便发现协议/版本漂移或 agent 私有扩展。
          console.warn('[ACP RX] unknown frame type:', (frame as { type?: unknown }).type, frame)
          break
      }
    }
    frameHandlerRef.current = dispatchFrame

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

      // hydrate 门控：GET /messages 落定前，会改动消息列表的帧先入缓冲按序回放，
      // 避免抢跑 hydrate。其余帧（capabilities/process_alive/terminal_activity/
      // permission_request/error/replay_*）不触碰 hydrate 守卫，即时派发。
      if (!hydratedRef.current && HYDRATE_GATED_FRAMES.has(frame.type)) {
        preHydrateBuffer.current.push(frame)
        return
      }
      dispatchFrame(frame)
    }

    ws.onerror = () => {
      if (wsRef.current !== ws) return
      const sid = sessionIdRef.current
      if (sid) {
        const st = useChatStore.getState().states[sid]
        // 若仍在等待回复，连接已不可达 → 复位 sending 并报错，避免占位永久卡死
        if (st?.sending && !st.sessionEnded) {
          useChatStore.getState().markError(sid, 'WebSocket error')
        } else {
          useChatStore.getState().setError(sid, 'WebSocket error')
        }
      }
      setConnectionState('error')
    }

    ws.onclose = () => {
      if (wsRef.current === ws) {
        isManualRestore.current = false
        setConnectionState('disconnected')
        wsRef.current = null
        const sid = sessionIdRef.current
        if (sid && !disposed) {
          const st = useChatStore.getState().states[sid]
          // 等待回复期间连接断开 → 复位 sending 并报错，避免「思考中」占位假死
          if (st?.sending && !st.sessionEnded) {
            useChatStore.getState().markError(sid, 'Connection lost — message may not have been delivered')
          }
          // 5.3=C 路径：连接断时如果队列里有未发的消息，把它写入 chat history 作为
          // 「undelivered」留痕（仅在内存，不入 DB），并清空队列槽位。连接恢复后
          // 用户可基于这条留痕手动决定是否重打。
          const queued = st?.queuedMessage
          if (queued && queued.trim()) {
            useChatStore.getState().addUndeliveredMessage(sid, queued.trim())
            useChatStore.getState().clearQueuedMessage(sid)
          }
        }
      }
    }

    return () => {
      disposed = true
      if (liveRaf.current !== null) {
        cancelAnimationFrame(liveRaf.current)
        liveRaf.current = null
      }
      flushLiveBuffer()
      frameHandlerRef.current = null
      if (ws.readyState === WebSocket.OPEN) ws.close()
      if (wsRef.current === ws) wsRef.current = null
    }
  }, [sessionId])

  // hydrate 落定 → 放行 preHydrateBuffer：按序回放缓冲帧到当前连接的派发器。
  // 重连（无 remount）时 hydrated 早已 true，缓冲恒空，此 effect 为 no-op。
  useEffect(() => {
    if (!hydrated) return
    hydratedRef.current = true
    const buffered = preHydrateBuffer.current
    if (buffered.length === 0) return
    preHydrateBuffer.current = []
    const handler = frameHandlerRef.current
    if (handler) for (const f of buffered) handler(f)
  }, [hydrated])

  const sendPrompt = useCallback((text: string, images?: ImageAttachment[]) => {
    const ws = wsRef.current
    const sid = sessionIdRef.current
    const trimmed = text.trim()
    const hasImages = !!images && images.length > 0
    // 纯图片消息（无文字）合法：粘贴截图直接发送。
    if (!ws || ws.readyState !== WebSocket.OPEN || !sid || (!trimmed && !hasImages)) return
    const s = useChatStore.getState()
    const imageBlocks = images?.map((img) => ({
      type: 'image' as const,
      mimeType: img.mimeType,
      data: img.data,
    }))
    s.addUserMessage(sid, trimmed, imageBlocks)
    try {
      const frame: Record<string, unknown> = { type: 'prompt', text: trimmed }
      if (hasImages) {
        frame.images = images.map((img) => ({ data: img.data, mime_type: img.mimeType }))
      }
      ws.send(JSON.stringify(frame))
      s.beginPrompt(sid)
    } catch {
      // send 失败（底层缓冲满 / 连接已坏）：不乐观置 sending，直接报错
      s.markError(sid, 'Failed to send message — connection unavailable')
    }
  }, [])

  const cancel = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'cancel' }))
  }, [])

  const restore = useCallback(() => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    isManualRestore.current = true
    ws.send(JSON.stringify({ type: 'load_session' }))
  }, [])

  const respondPermission = useCallback((id: string, optionId: string) => {
    const ws = wsRef.current
    const sid = sessionIdRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !sid) return
    ws.send(JSON.stringify({ type: 'permission_response', id, option_id: optionId }))
    useChatStore.getState().clearPermission(sid)
    attention.clearAlert(sid)
  }, [attention])

  const setConfigOption = useCallback((configId: string, value: string) => {
    const ws = wsRef.current
    const sid = sessionIdRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN || !sid) return
    useChatStore.getState().patchConfigOptionValue(sid, configId, value)
    ws.send(JSON.stringify({ type: 'set_config_option', config_id: configId, value }))
  }, [])

  return { connectionState, sendPrompt, cancel, restore, respondPermission, setConfigOption }
}
