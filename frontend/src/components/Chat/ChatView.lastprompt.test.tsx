import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import {
  userMsg,
  assistantMsg,
  setupChatViewStores,
  resetChatViewStores,
  seedChatMessages,
} from './ChatView.testUtils'

// 「上次输入」悬浮卡片：消息区顶部居中悬浮，单行展示最近一次已送达的用户输入，
// 点击跳回那个气泡（accent 描边 + ring 闪烁）。undelivered（断连留痕，
// 从未真正发往 agent）不算一次输入——不作为展示内容，也不作为跳转目标。
// 显隐三分：气泡在视口内、或用户上翻越过它进入更早历史（气泡沉到视口下方）
// 都收起；仅当气泡升出视口顶缘（用户正在阅读它之后的回复）时显示。

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setupChatViewStores()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetChatViewStores()
})

function renderView() {
  act(() => root.render(<ChatView />))
}

function lastPromptCard() {
  return container.querySelector<HTMLButtonElement>('.chat-last-prompt-card')
}

describe('ChatView last-prompt card', () => {
  it('shows the most recent delivered user message, not the undelivered trail', () => {
    seedChatMessages([
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
    seedChatMessages([assistantMsg('m2', 'answer')])
    renderView()
    expect(lastPromptCard()).toBeNull()
  })

  it('flashes the target bubble on click and skips the undelivered trail', () => {
    seedChatMessages([
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

  it('shows only while the bubble is above the viewport, hides in view and below it', () => {
    seedChatMessages([userMsg('m1', 'first question'), assistantMsg('m2', 'answer')])
    renderView()
    // jsdom 默认零矩形：气泡底缘 0 ≤ 视口顶 0 + 24px 容差 → 视为「已滚出顶缘」→ 显示
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
      // 气泡完全在视口内（10..60）→ 收起
      rectsFor({ top: 10, bottom: 60 })
      fireScroll()
      expect(lastPromptCard()).toBeNull()

      // 气泡整个沉到视口下方（700..750，用户上翻越过它、正在浏览更早历史）→ 收起
      rectsFor({ top: 700, bottom: 750 })
      fireScroll()
      expect(lastPromptCard()).toBeNull()

      // 气泡升出视口顶缘（-200..-50，用户正在阅读它之后的回复）→ 显示
      rectsFor({ top: -200, bottom: -50 })
      fireScroll()
      expect(lastPromptCard()).toBeTruthy()
    } finally {
      spy.mockRestore()
    }
  })
})
