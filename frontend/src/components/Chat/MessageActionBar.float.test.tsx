import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MessageActionBar } from './MessageActionBar'
import type { MessageAction, MessageActionContext } from './messageActions'
import type { ChatMessage } from '../../stores/chatStore'
import i18n from '../../i18n'

// 消息动作条 label 浮层（hover 图标时显示的功能文字）的水平 clamp 回归。
//
// 浮层是聊天气泡滚动容器（.overlay-scroll-content）里的 absolute 子元素，探出容器
// 右缘的那一段会进容器的 scrollable overflow、把 scrollWidth 顶宽——右对齐 user
// 消息的「引用」浮层实测恒定探出一截（2026-10-13 用户报告消息列出现横向滚动条）。
// 修法：clamp 基准从「视口」改成「最近的滚动容器」。
//
// jsdom 不做布局：这里按真实浏览器量到的几何 mock getBoundingClientRect /
// offsetWidth / clientWidth，断言「浮层矩形落在容器可见区内」这一不变量——
// 它是 scrollWidth 不被顶宽的充分条件。

let container: HTMLDivElement
let root: Root

/** 滚动容器（.overlay-scroll-content）量到的矩形：1440 视口下的消息列。 */
const CONTAINER = { left: 264, right: 1012, top: 34, bottom: 778 }
/** 纵向滚动条槽位（真实浏览器约 15px；jsdom 的 clientWidth 默认是 0，需显式 mock）。 */
const V_SCROLLBAR = 15
/** 「引用」浮层量到的宽度（zh locale 实测值）。 */
const LABEL_W = 47
/** 动作按钮本体的宽度。 */
const BTN_W = 20

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function userMessage(): ChatMessage {
  return {
    id: 'm1',
    role: 'user',
    text: '你好',
    blocks: [{ type: 'text', text: '你好' }],
    createdAt: 0,
  }
}

function action(id: string, labelKey: string): MessageAction {
  return {
    id,
    // 图标只在动作条里占位，本测试不关心它的长相。
    Icon: (() => null) as unknown as MessageAction['Icon'],
    labelKey,
    visible: () => true,
    run: () => {},
  }
}

const ctx: MessageActionContext = {
  message: userMessage(),
  isLastAssistant: false,
  handlers: { copyMessage: () => {}, quoteMessage: () => {}, regenerate: () => {}, canRegenerate: false },
}

/** 渲染一条动作条，外层 div 的 overflowY:auto 让组件把它认成滚动容器。 */
function renderBar(actions: MessageAction[]): HTMLElement {
  act(() => {
    root.render(
      <div style={{ overflowY: 'auto' }}>
        <MessageActionBar actions={actions} ctx={ctx} menu={null} onCloseMenu={() => {}} />
      </div>,
    )
  })
  return container.querySelector<HTMLElement>('div[style*="overflow-y"]')!
}

/** React 的 onMouseEnter 由 mouseover 合成（enter/leave 不走冒泡监听）。 */
function hover(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
}

/**
 * 按给定几何 mock 布局读取。`btnRects` 把按钮元素映射到它的矩形（未列入的按钮
 * 量到零矩形，等价于「不在右缘、无需 clamp」）。
 */
function mockLayout(
  scroller: HTMLElement,
  btnRects: Map<HTMLElement, { left: number; right: number; top: number; bottom: number }>,
) {
  const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  const offsetWidthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
  const clientWidthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get')
  rectSpy.mockImplementation(function (this: HTMLElement) {
    const zero = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }
    if (this === scroller) {
      return { ...zero, ...CONTAINER, width: CONTAINER.right - CONTAINER.left, height: CONTAINER.bottom - CONTAINER.top }
    }
    const r = btnRects.get(this)
    if (r) return { ...zero, ...r, width: r.right - r.left, height: r.bottom - r.top }
    return zero
  })
  offsetWidthSpy.mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('chat-msg-action-btn')) return BTN_W
    return this.tagName === 'SPAN' ? LABEL_W : 0
  })
  clientWidthSpy.mockImplementation(function (this: HTMLElement) {
    return this === scroller ? CONTAINER.right - CONTAINER.left - V_SCROLLBAR : 0
  })
  return () => {
    rectSpy.mockRestore()
    offsetWidthSpy.mockRestore()
    clientWidthSpy.mockRestore()
  }
}

describe('MessageActionBar label float horizontal clamp', () => {
  it('clamps the tooltip inside the scroll container so it never widens the message column', () => {
    const scroller = renderBar([action('copy', 'chat.msg.copy'), action('quote', 'chat.msg.quote')])
    const buttons = Array.from(container.querySelectorAll<HTMLElement>('.chat-msg-action-btn'))
    expect(buttons).toHaveLength(2)

    // 只有最右一个按钮贴容器右缘——右对齐 user 消息的形态。
    const restore = mockLayout(scroller, new Map([[buttons[1], { left: 980, right: 1000, top: 103, bottom: 117 }]]))
    try {
      hover(buttons[1])

      const label = buttons[1].querySelector<HTMLElement>('span')!
      const btn = buttons[1].getBoundingClientRect()
      const float = {
        left: btn.left + Number.parseFloat(label.style.left || '0'),
        right: btn.left + Number.parseFloat(label.style.left || '0') + LABEL_W,
      }
      // 浮层完整落在滚动容器的**可见区**内（右缘已扣掉纵向滚动条槽位）。
      expect(float.left).toBeGreaterThanOrEqual(CONTAINER.left)
      expect(float.right).toBeLessThanOrEqual(CONTAINER.right - V_SCROLLBAR)
      // 修复前 clamp 基准是视口：left 恒 0，浮层右缘 1027 探出容器可见区 30px。
      expect(float.right).toBeLessThan(btn.right)
    } finally {
      restore()
    }
  })

  it('leaves a tooltip that already fits untouched', () => {
    const scroller = renderBar([action('copyMarkdown', 'chat.msg.copyMarkdown')])
    const button = container.querySelector<HTMLElement>('.chat-msg-action-btn')!

    // 按钮远离右缘：浮层按「左缘对齐按钮左缘」原样排，不该被左缩。
    const restore = mockLayout(scroller, new Map([[button, { left: 300, right: 320, top: 100, bottom: 114 }]]))
    try {
      hover(button)
      const label = button.querySelector<HTMLElement>('span')!
      expect(label.style.left).toBe('0px')
    } finally {
      restore()
    }
  })
})
