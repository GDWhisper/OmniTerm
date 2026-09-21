import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatView } from './ChatView'
import { useChatStore } from '../../stores/chatStore'
import {
  SESSION_ID,
  userMsg,
  assistantMsg,
  setupChatViewStores,
  resetChatViewStores,
  seedChatMessages,
  chatScrollEl,
  mockScrollMetrics,
  fireScroll,
  installResizeObserverSpy,
} from './ChatView.testUtils'

// 贴底态的维持：跟随中任何把底缘推远的布局变化都必须重新钉底——容器尺寸变化
// （键盘收放、todo 看板/输入区/权限条长高）与滚动内容长高（思考指示、重放指示、
// 终端事件）都不会改 messages、也不保证发 scroll 事件，漏掉任一条就会「贴底态
// 仍为 true，视口却停在半空」：移动端聊天面板离屏时收缩实测底缘直接掉下去，
// 切回 sidebar 就是「没追底」且「回到底部」按钮也不显示（见 ChatView 的
// ResizeObserver 回调注释）。jsdom 无布局，全部靠 mock 度量 + 手动触发回调驱动。

let container: HTMLDivElement
let root: Root
let roSpy: ReturnType<typeof installResizeObserverSpy>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // 必须在渲染前装好：ChatView 在 layout effect 里创建 observer。
  roSpy = installResizeObserverSpy()
  setupChatViewStores()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetChatViewStores()
  vi.unstubAllGlobals()
})

function renderView() {
  act(() => root.render(<ChatView />))
}

function jumpButton() {
  return container.querySelector<HTMLButtonElement>('.chat-jump-bottom')
}

/** 贴底态（scrollTop 1400 / clientHeight 600 / scrollHeight 2000）下的容器。 */
function seedAtBottom() {
  seedChatMessages([userMsg('m1', 'question'), assistantMsg('m2', 'answer')])
  renderView()
  const el = chatScrollEl(container)
  const metrics = mockScrollMetrics(el, { scrollTop: 1400, clientHeight: 600, scrollHeight: 2000 })
  return { el, metrics }
}

describe('ChatView stick-to-bottom across layout changes', () => {
  it('跟随中容器收缩后重新贴底（离屏切走再切回不丢底缘）', () => {
    const { el, metrics } = seedAtBottom()
    // 容器矮了 300px（键盘收放 / todo 看板长高 / 面板离屏时被压矮）：滚动位置不动、
    // 也没有 scroll 事件——浏览器的「保住底缘」只在滚动容器可见时才会发生。
    metrics.setClientHeight(300)
    act(() => roSpy.fire(el))

    expect(metrics.getTop()).toBe(2000)
    expect(jumpButton()).toBeNull()
  })

  it('已上翻（非贴底）时容器收缩不夺回阅读位置', () => {
    const { el, metrics } = seedAtBottom()
    metrics.setTop(800)
    act(() => fireScroll(container))
    expect(jumpButton()).toBeTruthy()

    metrics.setClientHeight(300)
    act(() => roSpy.fire(el))

    expect(metrics.getTop()).toBe(800)
    expect(jumpButton()).toBeTruthy()
  })

  it('滚动内容长高但不改 messages（重放指示出现）时重新贴底', () => {
    const { metrics } = seedAtBottom()
    // 内容长高 160px：messages 引用不变，旧实现（deps 只有 messages/autoStick）不重钉。
    metrics.setScrollHeight(2160)
    act(() => useChatStore.getState().setReplaying(SESSION_ID, true))

    expect(metrics.getTop()).toBe(2160)
    expect(jumpButton()).toBeNull()
  })
})
