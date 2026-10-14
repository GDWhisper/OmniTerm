import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '../../stores/chatStore'
import { useAppStore } from '../../stores/appStore'
import '../../i18n'

// 思考块的排版与收起态档位回归（2026-10-13 用户要求）：
// ① 内容字体不得斜体，保持比正文小 + 虚化；
// ② 「展开思考」关闭时由 `thinkingCollapsedMode` 决定收起态显示什么——
//    'hide' 完全隐藏（历史行为）、'brief' 只在标题行下显示一行**未经总结**的
//    流式思考原文（最后一个非空行），且不与完整内容同时出现。

let container: HTMLDivElement
let root: Root

/** 单条 thought 块的 assistant 消息（非 streaming，避免 caret/计时干扰）。 */
function thoughtMessage(text: string, streaming = false): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    text: '',
    blocks: [{ type: 'thought', text }],
    createdAt: 0,
    streaming,
  }
}

/** 思考块根节点：chat-block 里唯一带 data-chat-body 的那个。 */
function thinkingBlock(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-chat-body="true"].chat-block')
}

/** 收起态简要预览行（仅在 'brief' 档且收起时渲染）。 */
function briefLine(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-thinking-brief="true"]')
}

function render(message: ChatMessage) {
  act(() => {
    root.render(<ChatMessageView message={message} />)
  })
}

/** 标题行按钮（◆▸ thinking）。 */
function headerButton(): HTMLButtonElement | null {
  return thinkingBlock()?.querySelector<HTMLButtonElement>('button') ?? null
}

const click = (el: Element | null) =>
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

beforeEach(() => {
  localStorage.clear()
  useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'hide' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
})

describe('ThoughtBlockView 排版（不要斜体）', () => {
  it('标题行与展开内容都不带斜体', () => {
    useAppStore.setState({ expandThinking: true })
    render(thoughtMessage('先读一下配置'))
    // 标题行按钮：历史上 fontStyle: 'italic'
    expect(headerButton()!.style.fontStyle).toBe('')
    // 展开内容（OverlayScroll 的 contentStyle）
    const content = thinkingBlock()!.querySelector<HTMLElement>('.overlay-scroll-content')
    expect(content).toBeTruthy()
    expect(content!.style.fontStyle).toBe('')
    // 整棵思考块子树里不允许再出现 italic 声明
    expect(container.innerHTML).not.toContain('italic')
  })

  it('内容保持比正文小一档且虚化（--text-muted）', () => {
    useAppStore.setState({ expandThinking: true })
    render(thoughtMessage('先读一下配置'))
    const content = thinkingBlock()!.querySelector<HTMLElement>('.overlay-scroll-content')!
    // 0.923em（外层已是 0.923em，故相对正文 1em 更小）+ 虚化色
    expect(content.style.fontSize).toBe('0.923em')
    expect(content.style.color).toBe('var(--text-muted)')
    // 正文气泡对照：1em + --text-primary，思考必须比它小、比它虚
    const textBubble = container.querySelector<HTMLElement>('.chat-bubble')
    expect(textBubble).toBeNull() // 本条消息只有 thought 块
  })

  it('正文气泡仍是 1em 主色——思考的小号虚化是相对它成立的', () => {
    render({
      id: 'm2',
      role: 'assistant',
      text: '这是正文',
      blocks: [
        { type: 'thought', text: '这是思考' },
        { type: 'text', text: '这是正文' },
      ],
      createdAt: 0,
    })
    const bubble = container.querySelector<HTMLElement>('.chat-bubble')!
    expect(bubble.style.fontSize).toBe('1em')
    expect(bubble.style.color).toBe('var(--text-primary)')
  })
})

describe('ThoughtBlockView 收起态：完全隐藏', () => {
  it('只留标题行，不渲染任何思考内容', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'hide' })
    render(thoughtMessage('第一行思考\n第二行思考'))
    expect(headerButton()).toBeTruthy()
    expect(thinkingBlock()!.textContent).toContain('thinking')
    expect(thinkingBlock()!.textContent).not.toContain('第一行思考')
    expect(thinkingBlock()!.querySelector('.overlay-scroll-content')).toBeNull()
    expect(briefLine()).toBeNull()
  })

  it('点击标题行仍可展开完整思考', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'hide' })
    render(thoughtMessage('第一行思考\n第二行思考'))
    click(headerButton())
    const content = thinkingBlock()!.querySelector<HTMLElement>('.overlay-scroll-content')
    expect(content).toBeTruthy()
    expect(content!.textContent).toContain('第一行思考')
    expect(content!.textContent).toContain('第二行思考')
  })
})

describe('ThoughtBlockView 收起态：显示简要', () => {
  it('收起时在标题行下显示一行思考原文，且不渲染完整内容', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('先看结构\n再看实现\n最后补测试'))
    const brief = briefLine()
    expect(brief).toBeTruthy()
    // 一行 = 最后一个非空行（正在生长的那一行），不是总结、不是首行
    expect(brief!.textContent).toBe('最后补测试')
    // 完整内容不渲染：只有那一行，另两行不可见
    expect(thinkingBlock()!.textContent).not.toContain('先看结构')
    expect(thinkingBlock()!.textContent).not.toContain('再看实现')
    expect(thinkingBlock()!.querySelector('.overlay-scroll-content')).toBeNull()
  })

  it('预览行用 nowrap + ellipsis 收口单行（不在 JS 里截断字符）', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('x'.repeat(4000)))
    const brief = briefLine()!
    expect(brief.style.whiteSpace).toBe('nowrap')
    expect(brief.style.textOverflow).toBe('ellipsis')
    expect(brief.style.overflow).toBe('hidden')
    // 原文完整进 DOM，截断只由 CSS 负责
    expect(brief.textContent).toBe('x'.repeat(4000))
  })

  it('预览行沿用思考内容的小号虚化规格', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('一行思考'))
    const brief = briefLine()!
    expect(brief.style.fontSize).toBe('0.923em')
    expect(brief.style.color).toBe('var(--text-muted)')
    expect(brief.style.fontStyle).toBe('')
  })

  it('流式期间预览随文本增长自然滚动，不做任何总结', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    // 流式块：streaming=true，模拟 chunk 逐词到达
    render(thoughtMessage('正在想', true))
    expect(briefLine()!.textContent).toBe('正在想')
    act(() => {
      root.render(<ChatMessageView message={thoughtMessage('正在想\n想到一半', true)} />)
    })
    expect(briefLine()!.textContent).toBe('想到一半')
    act(() => {
      root.render(<ChatMessageView message={thoughtMessage('正在想\n想到一半\n想完了', true)} />)
    })
    expect(briefLine()!.textContent).toBe('想完了')
  })

  it('展开后预览行消失，改为完整内容', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('第一行\n第二行'))
    expect(briefLine()!.textContent).toBe('第二行')
    click(headerButton())
    expect(briefLine()).toBeNull()
    const content = thinkingBlock()!.querySelector<HTMLElement>('.overlay-scroll-content')!
    expect(content.textContent).toContain('第一行')
    expect(content.textContent).toContain('第二行')
    // 再收起：预览回来
    click(headerButton())
    expect(briefLine()!.textContent).toBe('第二行')
  })

  it('展开思考打开时块恒展开，不出预览行', () => {
    useAppStore.setState({ expandThinking: true, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('第一行\n第二行'))
    expect(briefLine()).toBeNull()
    expect(thinkingBlock()!.querySelector('.overlay-scroll-content')).toBeTruthy()
  })

  it('思考为空串时不渲染预览行（不给空气泡）', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('\n\n'))
    expect(briefLine()).toBeNull()
    expect(thinkingBlock()!.textContent).toContain('thinking')
  })

  it('预览行不是 data-chat-body——不参与气泡右缘测量', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('一行思考'))
    // 元信息行量的是最后一个 [data-chat-body]；预览行若也打标就会顶替它
    expect(container.querySelectorAll('[data-chat-body="true"]')).toHaveLength(1)
    expect(briefLine()!.getAttribute('data-chat-body')).toBeNull()
  })
})

describe('ThoughtBlockView 收起态档位热切换', () => {
  it('改设置后面向已挂载的思考块立即生效', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'hide' })
    render(thoughtMessage('第一行\n第二行'))
    expect(briefLine()).toBeNull()
    act(() => {
      useAppStore.setState({ thinkingCollapsedMode: 'brief' })
    })
    expect(briefLine()!.textContent).toBe('第二行')
    act(() => {
      useAppStore.setState({ thinkingCollapsedMode: 'hide' })
    })
    expect(briefLine()).toBeNull()
  })
})
