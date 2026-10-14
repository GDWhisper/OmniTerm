import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '../../stores/chatStore'
import { useAppStore } from '../../stores/appStore'
import i18n from '../../i18n'
import zh from '../../locales/zh/translation.json'
import en from '../../locales/en/translation.json'

// 消息级「过程容器」契约（对齐 ZCode 容器型工具 agent.tsx / ToolLayout.tsx）：
// 一轮 ACP 输出里的过程块（thought / tool_call / plan）被收进同一个折叠器，
// 折叠态只留**一行计数聚合摘要**，最终 text 结论留在容器外始终可见。
// 交互 = 流式中展开（跟着看过程）、完成后自动折叠（收纳）、用户手动干预后
// 自动规则不再插手。
// jsdom 不加载 index.css，故不断言计算样式，只断言 DOM 结构与文案这两个不变量；
// 扫光 / 箭头 hover 的实际观感靠人工目视。

let container: HTMLDivElement
let root: Root

/** 一条含过程块 + 最终 text 结论的 assistant 消息。 */
function processMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    text: '最终结论',
    blocks: [
      { type: 'thought', text: '先想一下' },
      { type: 'tool_call', toolCallId: 't1', title: '读文件', status: 'completed' },
      { type: 'tool_call', toolCallId: 't2', title: '跑命令', status: 'completed' },
      { type: 'plan', entries: [{ content: '第一步', status: 'completed' }] },
      { type: 'text', text: '最终结论' },
    ],
    createdAt: 0,
    ...overrides,
  }
}

/** 收纳行按钮（◆/◈ … ▸）。 */
function processHeader(): HTMLButtonElement | null {
  return (
    container.querySelector<HTMLButtonElement>('.process-header-btn') ??
    container.querySelector<HTMLButtonElement>('.thinking-header-btn')
  )
}

/** 收纳态箭头：data-open 表达容器展开/收起。 */
function processChevron(): HTMLElement | null {
  return container.querySelector<HTMLElement>('.process-chevron')
}

/** 最终 text 结论块（气泡本体）。 */
function textBubble(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-chat-body="true"].chat-bubble')
}

const click = (el: Element | null | undefined) =>
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

function render(message: ChatMessage) {
  act(() => {
    root.render(<ChatMessageView message={message} />)
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  localStorage.clear()
  useAppStore.setState({ expandThinking: false, thinkingCollapsedMode: 'hide', expandToolCalls: false })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
})

describe('ProcessBlocks 收纳行存在性与摘要', () => {
  it('多过程块时渲染收纳行，摘要按块型计数聚合', () => {
    render(processMsg())
    const header = container.querySelector<HTMLButtonElement>('.process-header-btn')
    expect(header).toBeTruthy()
    // 计数聚合：思考 1 · 工具调用 2 · 计划 1
    expect(header!.textContent).toContain('思考 1 次')
    expect(header!.textContent).toContain('工具调用 2 次')
    expect(header!.textContent).toContain('计划 1 份')
  })

  it('收纳行字形与思考块标题行不同形（避免视觉混淆）', () => {
    render(processMsg())
    const header = container.querySelector<HTMLButtonElement>('.process-header-btn')
    // 收纳行用 ◈，思考块用 ◆——同族不同形
    expect(header!.textContent).toContain('◈')
  })

  it('收纳行带 data-chat-body，参与气泡右缘测量', () => {
    render(processMsg())
    const header = container.querySelector<HTMLElement>('.process-header-btn')
    expect(header!.closest('[data-chat-body="true"]')).toBeTruthy()
  })
})

describe('ProcessBlocks 折叠态', () => {
  it('流式结束后默认收起：只显示一行摘要，过程明细不渲染', () => {
    render(processMsg({ streaming: false }))
    // 已完成 → 自动折叠（默认态）
    expect(processChevron()!.getAttribute('data-open')).toBe('false')
    // 明细不在 DOM 里：思考原文、工具标题、计划条目都不出现
    const row = container.querySelector<HTMLElement>('[data-chat-msg-id="m1"]')!
    expect(row.textContent).not.toContain('先想一下')
    expect(row.textContent).not.toContain('读文件')
    expect(row.textContent).not.toContain('第一步')
    // 摘要行本身在
    expect(processHeader()!.textContent).toContain('工具调用 2 次')
  })

  it('折叠态状态词为「已完成」', () => {
    render(processMsg({ streaming: false }))
    expect(processHeader()!.textContent).toContain('已完成')
  })

  it('最终 text 结论留在容器外、始终可见', () => {
    render(processMsg({ streaming: false }))
    expect(textBubble()).toBeTruthy()
    expect(textBubble()!.textContent).toContain('最终结论')
  })
})

describe('ProcessBlocks 流式态', () => {
  it('流式中默认展开：过程明细可见', () => {
    render(processMsg({ streaming: true }))
    expect(processChevron()!.getAttribute('data-open')).toBe('true')
    // 观测点选**内层块自己的标题行**（工具卡标题「读文件」/ 思考块的
    // .thinking-header-btn），而非思考原文：容器展开时内层各块仍按
    // expandThinking / expandToolCalls 决定自身展不展开（这是「容器与两个
    // 开关不同层」的正确表现），故原文不一定在 DOM 里，但块头一定在。
    const row = container.querySelector<HTMLElement>('[data-chat-msg-id="m1"]')!
    expect(row.textContent).toContain('读文件')
    expect(row.textContent).toContain('跑命令')
    expect(container.querySelector('.thinking-header-btn')).toBeTruthy()
  })

  it('流式中状态词为「进行中」', () => {
    render(processMsg({ streaming: true }))
    expect(processHeader()!.textContent).toContain('进行中')
  })

  it('流式结束边沿自动折叠', () => {
    render(processMsg({ streaming: true }))
    expect(processChevron()!.getAttribute('data-open')).toBe('true')
    // streaming true → false：边沿上自动收起
    render(processMsg({ streaming: false }))
    expect(processChevron()!.getAttribute('data-open')).toBe('false')
    const row = container.querySelector<HTMLElement>('[data-chat-msg-id="m1"]')!
    expect(row.textContent).not.toContain('先想一下')
  })
})

describe('ProcessBlocks 用户干预优先', () => {
  it('用户手动展开过后，流式结束不再自动折叠', () => {
    render(processMsg({ streaming: true }))
    // 手动折一下再展开 = 干预过
    click(processHeader())
    expect(processChevron()!.getAttribute('data-open')).toBe('false')
    click(processHeader())
    expect(processChevron()!.getAttribute('data-open')).toBe('true')
    // 流式结束：干预过，不自动折
    render(processMsg({ streaming: false }))
    expect(processChevron()!.getAttribute('data-open')).toBe('true')
  })

  it('用户手动折叠后流式结束：保持折叠，不被再次摊开', () => {
    render(processMsg({ streaming: true }))
    click(processHeader())
    expect(processChevron()!.getAttribute('data-open')).toBe('false')
    render(processMsg({ streaming: false }))
    expect(processChevron()!.getAttribute('data-open')).toBe('false')
  })

  it('手动展开后可再手动收起（双向可控）', () => {
    render(processMsg({ streaming: false }))
    click(processHeader())
    expect(processChevron()!.getAttribute('data-open')).toBe('true')
    const row = container.querySelector<HTMLElement>('[data-chat-msg-id="m1"]')!
    expect(row.textContent).toContain('读文件')
    click(processHeader())
    expect(processChevron()!.getAttribute('data-open')).toBe('false')
    expect(row.textContent).not.toContain('读文件')
  })
})

describe('ProcessBlocks 边界：不改变无容器场景的行为', () => {
  it('纯 text 消息不渲染收纳行（行为与加容器前一致）', () => {
    render({
      id: 'm2',
      role: 'assistant',
      text: '只是结论',
      blocks: [{ type: 'text', text: '只是结论' }],
      createdAt: 0,
    })
    expect(container.querySelector('.process-header-btn')).toBeNull()
    expect(textBubble()!.textContent).toContain('只是结论')
  })

  it('单个过程块不套容器：思考块仍渲染自己的标题行', () => {
    // 单块段套容器会得到「容器摘要 + 块自己的头」两行重复信息，故不套。
    render({
      id: 'm3',
      role: 'assistant',
      text: '结论',
      blocks: [
        { type: 'thought', text: '只想一句' },
        { type: 'text', text: '结论' },
      ],
      createdAt: 0,
    })
    expect(container.querySelector('.process-header-btn')).toBeNull()
    expect(container.querySelector('.thinking-header-btn')).toBeTruthy()
  })

  it('system 块留在容器外（审批必须可见可点）', () => {
    render(
      processMsg({
        blocks: [
          { type: 'thought', text: '想' },
          { type: 'tool_call', toolCallId: 't1', title: '读文件', status: 'completed' },
          { type: 'system', label: '权限请求' },
          { type: 'text', text: '结论' },
        ],
      }),
    )
    // system 在容器外原序渲染，不随容器折叠而消失
    expect(container.querySelector('.process-header-btn')).toBeTruthy()
    const row = container.querySelector<HTMLElement>('[data-chat-msg-id="m1"]')!
    expect(row.textContent).toContain('权限请求')
  })

  it('无 text 结论时（纯过程块）收纳行仍正常', () => {
    render({
      id: 'm4',
      role: 'assistant',
      text: '',
      blocks: [
        { type: 'thought', text: '想' },
        { type: 'tool_call', toolCallId: 't1', title: '读文件', status: 'completed' },
      ],
      createdAt: 0,
    })
    expect(container.querySelector('.process-header-btn')).toBeTruthy()
    expect(container.querySelector('.process-header-btn')!.textContent).toContain('工具调用 1 次')
  })
})

describe('ProcessBlocks i18n key 齐备', () => {
  it('zh / en 都定义了收纳行所需 key', () => {
    const zhMap = zh as Record<string, string>
    const enMap = en as Record<string, string>
    for (const k of [
      'chat.process.thoughtCount',
      'chat.process.toolCount',
      'chat.process.planCount',
      'chat.process.working',
      'chat.process.done',
    ]) {
      expect(zhMap[k], `zh ${k}`).toBeTruthy()
      expect(enMap[k], `en ${k}`).toBeTruthy()
    }
  })
})
