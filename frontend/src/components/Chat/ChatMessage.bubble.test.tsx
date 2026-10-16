import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '../../stores/chatStore'
import i18n from '../../i18n'

// 聊天气泡的像素化契约（ui-style-guide §7.8 / §6 / §14）：圆角一律 0，且**只应由
// index.css 的 .chat-bubble 提供**——组件侧不再 inline 圆角值。历史上这里是 8/6/4
// 的圆弧，规范收紧成硬角时若各处各写一份就会再次漂移，故把「圆角不在 inline」
// 钉成不变量。
// jsdom 不加载 index.css，计算样式拿不到 .chat-bubble 的规则，因此不断言
// border-radius 的计算值，而是断言 class 与 inline 样式这两个结构不变量；
// 亮/暗两主题的实际观感（硬投影浓度、贴缘是否被裁）靠人工目视。
// 独立的轻量测试文件，避免给 ChatMessage 的其余渲染路径建重 harness。

let container: HTMLDivElement
let root: Root

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

function userMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', role: 'user', text: 'hi', blocks: [], createdAt: Date.now(), ...overrides }
}

function assistantMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm2',
    role: 'assistant',
    text: 'done',
    blocks: [{ type: 'text', text: 'done' }],
    createdAt: Date.now(),
    ...overrides,
  }
}

/** 消息行里的气泡本体：data-chat-body 标记的正文块容器。 */
function bubbleOf(rowId: string): HTMLElement | null {
  const row = container.querySelector(`[data-chat-msg-id="${rowId}"]`)
  return row?.querySelector<HTMLElement>('[data-chat-body="true"]') ?? null
}

describe('ChatMessageView 气泡像素化契约', () => {
  it('user 气泡挂 chat-bubble 且不 inline 圆角', () => {
    act(() => {
      root.render(<ChatMessageView message={userMsg()} />)
    })
    const bubble = bubbleOf('m1')
    expect(bubble).toBeTruthy()
    expect(bubble!.classList.contains('chat-bubble')).toBe(true)
    // 圆角只来自 class：inline 一旦写死值，规范变更就会再次各处漂移
    expect(bubble!.style.borderRadius).toBe('')
  })

  it('assistant 正文气泡同样挂 chat-bubble 且不 inline 圆角', () => {
    act(() => {
      root.render(<ChatMessageView message={assistantMsg()} sessionId="s1" />)
    })
    const bubble = bubbleOf('m2')
    expect(bubble).toBeTruthy()
    expect(bubble!.classList.contains('chat-bubble')).toBe(true)
    expect(bubble!.style.borderRadius).toBe('')
  })

  it('高亮态保留 chat-msg-flash（与 chat-bubble 并列，投影由 keyframes 写回）', () => {
    // 「上次输入」跳转聚焦：ChatView.lastprompt.test.tsx 钉住 .chat-msg-flash
    // 的存在，这里补上它与 chat-bubble 的并列关系——聚焦 ring 的 keyframes
    // 靠 --chat-bubble-shadow 把气泡硬投影写回，缺了 class 投影就被抹掉。
    act(() => {
      root.render(<ChatMessageView message={userMsg()} highlighted />)
    })
    const bubble = bubbleOf('m1')
    expect(bubble!.classList.contains('chat-bubble')).toBe(true)
    expect(bubble!.classList.contains('chat-msg-flash')).toBe(true)
  })

  it('未送达态仍带 chat-bubble（class  chrome 不因特殊态丢失）', () => {
    // 未送达气泡的边框是 inline 三分支之一（虚线危险色）。jsdom 的 cssstyle
    // 解析不了 var() 值，`1px dashed var(--danger)` 整条被丢弃，故不断言边框
    // 本身；这里只钉住「特殊态不丢 class」——chrome（硬角 + 边框 + 投影）
    // 全在 .chat-bubble 上，class 丢了气泡就退回无样式裸盒。
    act(() => {
      root.render(<ChatMessageView message={userMsg({ undelivered: true })} />)
    })
    const bubble = bubbleOf('m1')
    expect(bubble!.classList.contains('chat-bubble')).toBe(true)
    // 未送达提示照常渲染（该分支若被 inline 边框改动带坏，文案会先消失）
    expect(bubble!.textContent).toContain('⚠')
  })
})
