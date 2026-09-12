import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import type { ChatMessage } from '../../stores/chatStore'
import type { Session } from '../../api/client'
import '../../i18n'

// 「上次输入」悬浮卡片：消息区顶部居中悬浮，展示最近一次已送达的用户输入，
// 点击跳转聚焦到那个气泡（accent 描边 + ring 闪烁）。undelivered（断连留痕，
// 从未真正发往 agent）不算一次输入——不作为展示内容，也不作为跳转目标。

const SESSION_ID = 's1'

const session: Session = {
  id: SESSION_ID,
  project_id: 'p1',
  workspace_path: '/tmp/ws',
  hook_enabled: false,
  created_at: '2026-01-01T00:00:00Z',
  runtime_kind: 'acp',
  acp_process_alive: true,
}

function userMsg(id: string, text: string, extra?: Partial<ChatMessage>): ChatMessage {
  return { id, role: 'user', text, blocks: [], createdAt: Date.now(), ...extra }
}

function assistantMsg(id: string, text: string): ChatMessage {
  return { id, role: 'assistant', text, blocks: [], createdAt: Date.now() }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useAppStore.setState({ activeSessionId: SESSION_ID, sessions: { p1: [session] } })
  // 置为已加载，避免 ChatView 的兜底 effect 触发真实的 agents 请求。
  useAgentStore.setState({ loaded: true })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useChatStore.setState({ states: {} })
  useAppStore.setState({ activeSessionId: null, sessions: {} })
})

// hydrated: true 让 ChatView 的 hydrate effect 直接跳过 GET /messages（无需 mock fetch）。
function seedMessages(messages: ChatMessage[]) {
  const s = useChatStore.getState()
  s.hydrate(SESSION_ID, messages, null)
  s.setHydrated(SESSION_ID, true)
}

function renderView() {
  act(() => root.render(<ChatView />))
}

function lastPromptCard() {
  return container.querySelector<HTMLButtonElement>('.chat-last-prompt-card')
}

describe('ChatView last-prompt card', () => {
  it('shows the most recent delivered user message, not the undelivered trail', () => {
    seedMessages([
      userMsg('m1', 'first question'),
      assistantMsg('m2', 'answer'),
      userMsg('m3', 'lost message', { undelivered: true }),
    ])
    renderView()
    const card = lastPromptCard()
    expect(card).toBeTruthy()
    expect(card!.textContent).toContain('first question')
    expect(card!.textContent).not.toContain('lost message')
  })

  it('renders no card when there is no user message', () => {
    seedMessages([assistantMsg('m2', 'answer')])
    renderView()
    expect(lastPromptCard()).toBeNull()
  })

  it('flashes the target bubble on click and skips the undelivered trail', () => {
    seedMessages([
      userMsg('m1', 'first question'),
      assistantMsg('m2', 'answer'),
      userMsg('m3', 'lost message', { undelivered: true }),
    ])
    renderView()
    act(() => lastPromptCard()!.click())
    // 闪烁 class 落在目标气泡（data-chat-body 容器）上；留痕气泡不闪。
    expect(container.querySelector('[data-chat-msg-id="m1"] .chat-msg-flash')).toBeTruthy()
    expect(container.querySelector('[data-chat-msg-id="m3"] .chat-msg-flash')).toBeNull()
  })
})
