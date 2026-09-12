import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import type { ChatMessage } from '../../stores/chatStore'
import type { Session } from '../../api/client'
import '../../i18n'

/**
 * ChatView 行为测试共用脚手架：预置 appStore / agentStore 的最小状态（免真实
 * fetch）、按 hydrate 完成态灌入消息、复位相关 store。createRoot 的挂载/卸载
 * 生命周期由各测试文件自管——各用例的容器与断言布局不同，这里只共享数据准备。
 */

export const SESSION_ID = 's1'

const session: Session = {
  id: SESSION_ID,
  project_id: 'p1',
  workspace_path: '/tmp/ws',
  hook_enabled: false,
  created_at: '2026-01-01T00:00:00Z',
  runtime_kind: 'acp',
  acp_process_alive: true,
}

export function userMsg(id: string, text: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id, role: 'user', text, blocks: [], createdAt: Date.now(), ...extra }
}

export function assistantMsg(id: string, text: string): ChatMessage {
  return { id, role: 'assistant', text, blocks: [], createdAt: Date.now() }
}

/** 预置最小 store 状态：activeSessionId 指向 ACP 会话、agents 已加载（免兜底请求）。 */
export function setupChatViewStores() {
  useAppStore.setState({ activeSessionId: SESSION_ID, sessions: { p1: [session] } })
  // 置为已加载，避免 ChatView 的兜底 effect 触发真实的 agents 请求。
  useAgentStore.setState({ loaded: true })
}

/** 复位 ChatView 相关 store（chatStore 无 persist，states 需显式清空）。 */
export function resetChatViewStores() {
  useChatStore.setState({ states: {} })
  useAppStore.setState({ activeSessionId: null, sessions: {} })
}

/** hydrated: true 让 ChatView 的 hydrate effect 直接跳过 GET /messages（无需 mock fetch）。 */
export function seedChatMessages(messages: ChatMessage[]) {
  const s = useChatStore.getState()
  s.hydrate(SESSION_ID, messages, null)
  s.setHydrated(SESSION_ID, true)
}
