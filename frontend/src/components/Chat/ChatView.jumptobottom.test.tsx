import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

// 「回到底部」按钮：离开消息区底部即显示——不要求尾部有新内容到达（流式期间与
// 会话结束/空闲回看历史都可用），滚回底部（含点击按钮）后隐藏。jsdom 无真实布局，
// atBottom 由对滚动容器显式 mock 的 scrollHeight/clientHeight/scrollTop 决定。

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

function jumpButton() {
  return container.querySelector<HTMLButtonElement>('.chat-jump-bottom')
}

/** 把滚动容器度量 mock 成给定状态（实例属性遮蔽 jsdom 原生访问器）。 */
function mockScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
) {
  let top = metrics.scrollTop
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v
    },
  })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => metrics.clientHeight })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => metrics.scrollHeight })
  return {
    getTop: () => top,
    setTop: (v: number) => {
      top = v
    },
  }
}

function fireScroll() {
  act(() => {
    // .overlay-scroll-content 即 scrollRef 指向的消息滚动容器。
    container.querySelector('.overlay-scroll-content')!.dispatchEvent(new Event('scroll'))
  })
}

describe('ChatView jump-to-bottom button', () => {
  it('shows when scrolled away from bottom even with no new content', () => {
    // 会话已结束、消息不再变化的场景：离底即显，不依赖尾部新内容（旧指纹门控回归）。
    seedChatMessages([userMsg('m1', 'question'), assistantMsg('m2', 'answer')])
    renderView()
    expect(jumpButton()).toBeNull()

    const el = container.querySelector<HTMLElement>('.overlay-scroll-content')!
    mockScrollMetrics(el, { scrollTop: 0, clientHeight: 600, scrollHeight: 2000 })
    fireScroll()
    expect(jumpButton()).toBeTruthy()
  })

  it('hides once back at the bottom', () => {
    seedChatMessages([userMsg('m1', 'question'), assistantMsg('m2', 'answer')])
    renderView()
    const el = container.querySelector<HTMLElement>('.overlay-scroll-content')!
    const m = mockScrollMetrics(el, { scrollTop: 0, clientHeight: 600, scrollHeight: 2000 })
    fireScroll()
    expect(jumpButton()).toBeTruthy()

    m.setTop(2000 - 600)
    fireScroll()
    expect(jumpButton()).toBeNull()
  })

  it('jumps to the bottom and hides on click', () => {
    seedChatMessages([userMsg('m1', 'question'), assistantMsg('m2', 'answer')])
    renderView()
    const el = container.querySelector<HTMLElement>('.overlay-scroll-content')!
    const m = mockScrollMetrics(el, { scrollTop: 0, clientHeight: 600, scrollHeight: 2000 })
    fireScroll()
    expect(jumpButton()).toBeTruthy()

    act(() => jumpButton()!.click())
    expect(m.getTop()).toBe(2000)
    expect(jumpButton()).toBeNull()
  })
})
