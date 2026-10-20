import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '../../stores/chatStore'
import { useAppStore } from '../../stores/appStore'
import i18n from '../../i18n'

// 思考块的排版与折叠态回归（2026-10-14 起对齐 ZCode 的 Reasoning 折叠态）：
// ① 内容字体不得斜体，保持比正文小 + 虚化；
// ② 折叠态标题行**单行**承载「◆ 图标 + 状态标签 + · + 实时思考行 + 箭头」；
// ③ 实时思考行**仅流式期间**显示，内容是一行**未经任何总结**的思考原文
//    （最后一个非空行），溢出靠「视口滚动到末尾」让最新 token 始终可见，
//    不再用 text-overflow: ellipsis（那会冻结旧前缀、裁掉最新内容）；
// ④ 状态标签分流式态「正在思考」（扫光）与完成态「深度思考」。

let container: HTMLDivElement
let root: Root

/** 单条 thought 块的 assistant 消息；streaming 控制是否处于流式期间。 */
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

/** 折叠态实时思考行的单行视口（仅流式 + 'brief' 档 + 收起时渲染）。 */
function streamingLine(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-thinking-streaming-line="true"]')
}

/** 视口内的文本节点（带滚入动画、由 key 驱动重挂载的那个）。 */
function streamingLineText(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-thinking-streaming-line="true"] > span')
}

function render(message: ChatMessage) {
  act(() => {
    root.render(<ChatMessageView message={message} />)
  })
  // 思考块现在被收在**消息级过程容器**里（整轮归组，见 ChatMessage.process.test.tsx
  // 「整轮归组」那组）：容器收起时思考块整个不在 DOM 中。本文件的主题是思考块
  // 自己的排版与折叠态，故渲染后先把容器展开——流式态容器本就展开，不点
  // （点了反而折上）。容器自身的展折叠归 process 测试管。
  openProcess()
}

/** 展开消息级过程容器（若处于收起态）。 */
function openProcess() {
  const chevron = container.querySelector<HTMLElement>('.process-chevron')
  if (chevron?.getAttribute('data-open') !== 'false') return
  click(container.querySelector<HTMLButtonElement>('.process-header-btn'))
}

/** 标题行按钮（◆ … ▸）。 */
function headerButton(): HTMLButtonElement | null {
  return thinkingBlock()?.querySelector<HTMLButtonElement>('button') ?? null
}

const click = (el: Element | null) =>
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

/**
 * 给单行视口造出 jsdom 里不存在的布局几何，并记录 scrollLeft 赋值。
 *
 * jsdom 不做布局：scrollWidth / clientWidth 恒 0，scrollLeft 赋值也读不回来。
 * 这里显式定义三者，用来断言「视口被推到末尾」而不是走 ellipsis。
 * 必须在**内容变化触发 effect 之前**装好，故调用时机在首次 render 之后、
 * 第二次 render（换一行）之前。
 */
function mockLineGeometry(el: HTMLElement, scrollWidth: number, clientWidth: number) {
  let scrollLeft = 0
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => scrollWidth })
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => clientWidth })
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    get: () => scrollLeft,
    set: (v: number) => {
      scrollLeft = v
    },
  })
  return () => scrollLeft
}

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

describe('ThoughtBlockView 折叠态状态标签', () => {
  it('流式且收起时标签为「正在思考」并带扫光', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('正在想', true))
    const shimmer = thinkingBlock()!.querySelector<HTMLElement>('.thinking-shimmer')
    expect(shimmer).toBeTruthy()
    expect(shimmer!.textContent).toBe(i18n.t('chat.thinking'))
  })

  it('已完成且收起时标签为「深度思考」，不带扫光', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('想完了'))
    expect(thinkingBlock()!.querySelector('.thinking-shimmer')).toBeNull()
    expect(thinkingBlock()!.textContent).toContain(i18n.t('chat.thought'))
  })

  it('箭头收起态默认隐藏、展开态常显并转向下（CSS 控制，这里断言接线）', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'hide' })
    render(thoughtMessage('想了很久'))
    const collapsed = thinkingBlock()!.querySelector<HTMLElement>('.thinking-chevron')!
    expect(collapsed.className).toContain('thinking-chevron')
    expect(collapsed.getAttribute('data-open')).toBe('false')
    click(headerButton())
    const open = thinkingBlock()!.querySelector<HTMLElement>('.thinking-chevron')!
    expect(open.getAttribute('data-open')).toBe('true')
  })
})

describe('ThoughtBlockView 收起态：完全隐藏', () => {
  it('只留标题行，不渲染任何思考内容', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'hide' })
    render(thoughtMessage('第一行思考\n第二行思考', true))
    expect(headerButton()).toBeTruthy()
    expect(thinkingBlock()!.textContent).not.toContain('第一行思考')
    expect(thinkingBlock()!.querySelector('.overlay-scroll-content')).toBeNull()
    expect(streamingLine()).toBeNull()
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

describe('ThoughtBlockView 折叠态：显示简要（仅流式期间）', () => {
  it('流式收起时在标题行内显示一行思考原文，且不渲染完整内容', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('先看结构\n再看实现\n最后补测试', true))
    const line = streamingLine()
    expect(line).toBeTruthy()
    // 一行 = 最后一个非空行（正在生长的那一行），不是总结、不是首行
    expect(line!.textContent).toBe('最后补测试')
    // 完整内容不渲染：只有那一行，另两行不可见
    expect(thinkingBlock()!.textContent).not.toContain('先看结构')
    expect(thinkingBlock()!.textContent).not.toContain('再看实现')
    expect(thinkingBlock()!.querySelector('.overlay-scroll-content')).toBeNull()
  })

  it('思考行内嵌在标题行按钮里（不是标题行下方另起一行）', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('正在想', true))
    // 布局对齐 ZCode：视口是标题行按钮的后代，而非兄弟节点。
    expect(headerButton()!.contains(streamingLine())).toBe(true)
  })

  it('流式结束后不再显示思考行（对齐 ZCode：只剩状态标签）', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('第一行\n第二行'))
    expect(streamingLine()).toBeNull()
  })

  it('思考为空串时不渲染思考行（不给空气泡）', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('\n\n', true))
    expect(streamingLine()).toBeNull()
    expect(headerButton()).toBeTruthy()
  })

  it('流式期间思考行随文本增长自然滚动，不做任何总结', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    // 流式块：streaming=true，模拟 chunk 逐词到达
    render(thoughtMessage('正在想', true))
    expect(streamingLine()!.textContent).toBe('正在想')
    act(() => {
      root.render(<ChatMessageView message={thoughtMessage('正在想\n想到一半', true)} />)
    })
    expect(streamingLine()!.textContent).toBe('想到一半')
    act(() => {
      root.render(<ChatMessageView message={thoughtMessage('正在想\n想到一半\n想完了', true)} />)
    })
    expect(streamingLine()!.textContent).toBe('想完了')
  })

  it('同一行继续生长时不重挂载（不重放滚入动画）', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('正在想', true))
    const first = streamingLineText()
    expect(first).toBeTruthy()
    act(() => {
      root.render(<ChatMessageView message={thoughtMessage('正在想更多', true)} />)
    })
    // key = 行首偏移，未换行则不变 → 同一个 DOM 节点，动画不重放
    expect(streamingLineText()).toBe(first)
    expect(streamingLine()!.textContent).toBe('正在想更多')
  })

  it('换行时思考行整体滚入（key 变化 → 新节点 + 滚入动画类）', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('正在想', true))
    const first = streamingLineText()
    act(() => {
      root.render(<ChatMessageView message={thoughtMessage('正在想\n新起一行', true)} />)
    })
    const second = streamingLineText()
    expect(second).not.toBe(first)
    expect(second!.textContent).toBe('新起一行')
    expect(second!.className).toContain('thinking-line-roll')
  })

  it('溢出时把视口推到末尾，让最新 token 始终可见（不走 ellipsis）', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('正在想', true))
    const viewport = streamingLine()!
    // 装好几何后再推一次内容变化，触发 effect 里的 sync()
    const readScrollLeft = mockLineGeometry(viewport, 4000, 300)
    act(() => {
      root.render(<ChatMessageView message={thoughtMessage('正在想\n又长了一些', true)} />)
    })
    // 不再用省略号：省略号会冻结旧前缀、把最新内容裁在右侧
    expect(viewport.style.textOverflow).toBe('')
    expect(viewport.style.whiteSpace).toBe('nowrap')
    expect(viewport.style.overflow).toBe('hidden')
    // 视口被推到末尾 → 最新 token 可见
    expect(readScrollLeft()).toBe(4000)
    // 溢出时叠加左缘渐隐遮罩，提示左侧还有被滚走的内容。
    // 只断言 data 属性与 jsdom 能收住的 mask-repeat/mask-size：遮罩核心的
    // mask-image 值里含 calc(100% - 16px)，jsdom 的 CSS 解析器会整条丢弃
    // （实测直接给 style.maskImage 赋值也留不住），故不能在此断言它——
    // 真实浏览器正常生效，这一条只锁「遮罩确实被挂上」。
    expect(viewport.getAttribute('data-thinking-streaming-mask')).toBe('both')
    expect(viewport.style.maskRepeat).toBe('no-repeat')
    expect(viewport.style.maskSize).toBe('100% 100%')
  })

  it('未溢出时不加遮罩（右缘是完整的最新 token）', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('很短', true))
    // jsdom 几何 0/0 → 不溢出
    expect(streamingLine()!.getAttribute('data-thinking-streaming-mask')).toBe('none')
    expect(streamingLine()!.style.maskRepeat).toBe('')
  })

  it('超长单行不截断字符（收口由视口负责）', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    const long = 'x'.repeat(4000)
    render(thoughtMessage(`短行\n${long}`, true))
    expect(streamingLine()!.textContent).toBe(long)
  })

  it('展开后思考行消失，改为完整内容；再收起流式块思考行回来', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('第一行\n第二行', true))
    expect(streamingLine()!.textContent).toBe('第二行')
    click(headerButton())
    expect(streamingLine()).toBeNull()
    const content = thinkingBlock()!.querySelector<HTMLElement>('.overlay-scroll-content')!
    expect(content.textContent).toContain('第一行')
    expect(content.textContent).toContain('第二行')
    // 再收起：思考行回来
    click(headerButton())
    expect(streamingLine()!.textContent).toBe('第二行')
  })

  it('展开思考打开时块恒展开，不出思考行', () => {
    useAppStore.setState({ expandThinking: true, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('第一行\n第二行'))
    expect(streamingLine()).toBeNull()
    expect(thinkingBlock()!.querySelector('.overlay-scroll-content')).toBeTruthy()
  })

  it('思考行不是 data-chat-body——不参与气泡右缘测量', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'brief' })
    render(thoughtMessage('一行思考', true))
    // 元信息行量的是最后一个 [data-chat-body]；思考行若也打标就会顶替它。
    // 带标的是**思考块自己**与它外面的过程容器（后者也要参与测量），
    // 思考块内部不允许再出现第三个。
    expect(container.querySelectorAll('[data-chat-body="true"]')).toHaveLength(2)
    expect(thinkingBlock()!.querySelectorAll('[data-chat-body="true"]')).toHaveLength(0)
    expect(streamingLine()!.getAttribute('data-chat-body')).toBeNull()
  })
})

describe('ThoughtBlockView 收起态档位热切换', () => {
  it('改设置后面向已挂载的思考块立即生效', () => {
    useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'hide' })
    render(thoughtMessage('第一行\n第二行', true))
    expect(streamingLine()).toBeNull()
    act(() => {
      useAppStore.setState({ thinkingCollapsedMode: 'brief' })
    })
    expect(streamingLine()!.textContent).toBe('第二行')
    act(() => {
      useAppStore.setState({ thinkingCollapsedMode: 'hide' })
    })
    expect(streamingLine()).toBeNull()
  })
})
