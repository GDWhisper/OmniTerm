import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useAgentStore } from '../../stores/agentStore'
import type { ChatMessage } from '../../stores/chatStore'
import type { Session } from '../../api/client'
import '../../i18n'

// 「上次输入」悬浮卡片：消息区顶部居中悬浮，单行展示最近一次已送达的用户输入，
// 点击跳转聚焦到那个气泡（accent 描边 + ring 闪烁）。undelivered（断连留痕，
// 从未真正发往 agent）不算一次输入——不作为展示内容，也不作为跳转目标。
// 目标气泡在视口内时卡片收起，滚离视口后重现。

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

  it('hides while the target bubble is in view and reappears once it scrolls out', () => {
    seedMessages([userMsg('m1', 'first question'), assistantMsg('m2', 'answer')])
    renderView()
    // jsdom 默认零矩形：气泡与视口重叠 0 < 24px → 视为不可见 → 卡片显示
    expect(lastPromptCard()).toBeTruthy()

    // mock 后其余元素（含滚动容器）统一按 0..600 视口处理，气泡矩形由用例给定。
    // 重测走真实路径：在滚动容器（.overlay-scroll-content，即 scrollRef 指向的
    // 元素）上派发 scroll 事件，由 handleScroll 内的重测驱动显隐。
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    const rectsFor = (bubble: { top: number; bottom: number } | null) =>
      spy.mockImplementation(function (this: HTMLElement) {
        const base = {
          x: 0, y: 0, left: 0, right: 0, width: 100, height: 0, top: 0, bottom: 0,
          toJSON: () => ({}),
        }
        if (bubble && this.hasAttribute('data-chat-msg-id')) {
          return {
            ...base,
            top: bubble.top,
            bottom: bubble.bottom,
            y: bubble.top,
            height: bubble.bottom - bubble.top,
          }
        }
        return { ...base, bottom: 600, height: 600 }
      })
    const fireScroll = () => {
      act(() => {
        container.querySelector('.overlay-scroll-content')!.dispatchEvent(new Event('scroll'))
      })
    }
    try {
      // 气泡完全在视口内（重叠 50px ≥ 24）→ 卡片收起
      rectsFor({ top: 10, bottom: 60 })
      fireScroll()
      expect(lastPromptCard()).toBeNull()

      // 气泡几乎滚出视口底（仅 5px 重叠 < 24）→ 卡片重现
      rectsFor({ top: 595, bottom: 645 })
      fireScroll()
      expect(lastPromptCard()).toBeTruthy()
    } finally {
      spy.mockRestore()
    }
  })
})
