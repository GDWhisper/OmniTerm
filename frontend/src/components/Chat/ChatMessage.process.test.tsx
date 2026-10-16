import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '../../stores/chatStore'
import { useAppStore } from '../../stores/appStore'
import { clearAllLiveTurnStats, setLiveTurnStats } from '../../utils/turnStats'
import i18n from '../../i18n'
import zh from '../../locales/zh/translation.json'
import en from '../../locales/en/translation.json'

// 消息级「过程容器」契约（对齐 ZCode 容器型工具 agent.tsx / ToolLayout.tsx）：
// **一轮** ACP 输出里**最终结论之前**的一切收进同一个折叠器——过程块
// （thought / tool_call / plan）与夹在过程块之间的中间 text 输出；结论及其后的
// 块留在容器外原位（流式顺序不变量，2026-10-16 修复）。折叠态只留
// **一行摘要**，最终 text 结论（流式中正在生长的那段）留在容器外始终可见。
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

/** 一轮被工具调用切成多段的输出：中间文字与过程块交替，最后是结论。 */
function interleavedMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm9',
    role: 'assistant',
    text: '最终结论',
    blocks: [
      { type: 'text', text: '第一段中间输出' },
      { type: 'thought', text: '先想一下' },
      { type: 'tool_call', toolCallId: 't1', title: '读文件', status: 'completed' },
      { type: 'text', text: '第二段中间输出' },
      { type: 'tool_call', toolCallId: 't2', title: '跑命令', status: 'completed' },
      { type: 'text', text: '最终结论' },
    ],
    createdAt: 0,
    ...overrides,
  }
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

function render(message: ChatMessage, sessionId?: string) {
  act(() => {
    root.render(<ChatMessageView message={message} sessionId={sessionId} />)
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

describe('ProcessBlocks 容器格式化上下文', () => {
  // 回归（2026-10-15 用户报告「工具调用信息位置错乱，复制按钮也是乱的」）：
  // 容器原本是普通块级 div，而 entries 里的 ToolCallBlockView 根节点是
  // `display:inline-flex`、ThoughtBlockView/PlanBlockView 是普通块级 div。在块
  // 容器里前者退化成**行内级**——与收纳行标题挤进同一行、按基线对齐产生纵向
  // 错位，长卡再折到下一行；后者铺满容器宽，把块级复制角标甩到容器远右缘。
  // 修法：容器立成与消息行 `.chat-msg-row` 同款的 flex column，三类明细块都被
  // 块化成 flex item——各自 shrink-to-fit、按行堆叠，与加容器前直接挂在消息行
  // 下完全一致。
  // jsdom 不加载 index.css、不做布局，故不断言几何，只断言这条结构不变量：
  // display / flexDirection / alignItems 三个值缺一不可（少 alignItems 则明细块
  // 会被拉成整宽，复制角标重新甩到远右缘）。
  it('容器是 flex column + align-items:flex-start，与消息行同一格式化上下文', () => {
    render(processMsg({ streaming: true }))
    const header = container.querySelector<HTMLElement>('.process-header-btn')!
    const box = header.parentElement as HTMLElement
    expect(box.style.display).toBe('flex')
    expect(box.style.flexDirection).toBe('column')
    expect(box.style.alignItems).toBe('flex-start')
  })

  it('容器不带 .chat-block：hover 容器不该亮出内部所有块的复制角标', () => {
    // `.chat-block:hover .chat-block-copy-btn` 是后代选择器——容器若挂上这个类，
    // 光是 hover 收纳行就会把内部每个明细块的角标一起点亮，而每个块本该只由
    // 自己的 hover 点亮（容器自己没有角标，也不需要 position:relative）。
    render(processMsg({ streaming: true }))
    const header = container.querySelector<HTMLElement>('.process-header-btn')!
    const box = header.parentElement as HTMLElement
    expect(box.classList.contains('chat-block')).toBe(false)
    // 内部明细块仍各自带 .chat-block（块级复制角标的定位父元素）
    expect(box.querySelector('.chat-block')).toBeTruthy()
  })

  it('容器收口是宽度上限的单一真源：内部明细块不再自带 maxWidth', () => {
    // 明细块自己再设 85% 会与容器的 85% **相乘**（实测同一张卡 1006px → 855px），
    // 长标题比平铺在消息行下时更早出省略号。故容器内的块不设 maxWidth，
    // 由容器统一收口（容器自身 ≤85% 行宽，块自然 ≤85% 行宽）。
    render(processMsg({ streaming: true }))
    const header = container.querySelector<HTMLElement>('.process-header-btn')!
    const nested = header.parentElement!.querySelectorAll<HTMLElement>('.chat-block')
    expect(nested.length).toBeGreaterThan(0)
    for (const el of nested) expect(el.style.maxWidth).toBe('')
  })

  it('留在容器外的块（最终 text 结论）仍自带 85% 宽度上限', () => {
    // 对照组：容器外的块没有上层收口，必须自己带 BUBBLE_MAX_WIDTH，
    // 否则长结论会撑到整行宽。
    render(interleavedMsg({ streaming: false }))
    const bubble = container.querySelector<HTMLElement>('.chat-bubble')!
    expect(bubble.textContent).toContain('最终结论')
    expect(bubble.style.maxWidth).toBe('85%')
  })
})

describe('ProcessBlocks 整轮归组（回归：每个小输出各折一行）', () => {
  // 2026-10-15 用户报告「实现偏离，预期是流式输出的最后一句话展示，然后单轮所有
  // 流式输出的思考、工具、输出都收纳起来……而非当前的每个小输出都折叠起来」。
  // 截图里同一条消息出现 5 行 `◈ 已工作 22分钟7秒 …`——根因是当时按**连续过程块
  // 切段**归组：每段中间文字之间各攒出一个容器，一轮被切成「文字 + 收纳行」交替
  // 的许多行。现改为**按轮归组**：结论**及其后**的一切之外的块收进同一个
  // 容器，一轮有且仅有一个收纳行（2026-10-16 起拆分点收敛为「结论之前」，
  // 见下一节「流式顺序」）。
  it('一轮只有一个收纳行：中间文字与过程块收进同一个容器', () => {
    render(interleavedMsg({ streaming: false }))
    expect(container.querySelectorAll('.process-header-btn').length).toBe(1)
    const row = container.querySelector<HTMLElement>('[data-chat-msg-id="m9"]')!
    // 折叠态：中间输出与过程明细都不在 DOM 里
    expect(row.textContent).not.toContain('第一段中间输出')
    expect(row.textContent).not.toContain('第二段中间输出')
    expect(row.textContent).not.toContain('读文件')
    expect(row.textContent).not.toContain('跑命令')
    // 最终结论留在容器外，始终可见
    expect(row.textContent).toContain('最终结论')
    // 计数聚合的是**整轮**：思考 1 次 · 工具调用 2 次
    expect(processHeader()!.textContent).toContain('思考 1 次')
    expect(processHeader()!.textContent).toContain('工具调用 2 次')
  })

  it('容器内的中间文字展开后按原序回来', () => {
    render(interleavedMsg({ streaming: false }))
    click(processHeader())
    const row = container.querySelector<HTMLElement>('[data-chat-msg-id="m9"]')!
    const body = row.textContent ?? ''
    // 原序：第一段 → 思考 → 读文件 → 第二段 → 跑命令（结论在容器外）
    expect(body.indexOf('第一段中间输出')).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('第一段中间输出')).toBeLessThan(body.indexOf('读文件'))
    expect(body.indexOf('读文件')).toBeLessThan(body.indexOf('第二段中间输出'))
    expect(body.indexOf('第二段中间输出')).toBeLessThan(body.indexOf('跑命令'))
  })

  it('容器内的中间文字同样不带 maxWidth（宽度由容器单一收口）', () => {
    render(interleavedMsg({ streaming: false }))
    click(processHeader())
    const box = processHeader()!.parentElement as HTMLElement
    const bubbles = box.querySelectorAll<HTMLElement>('.chat-bubble')
    expect(bubbles.length).toBe(2)
    for (const el of bubbles) expect(el.style.maxWidth).toBe('')
  })

  it('只有中间文字、无过程块时也收纳，摘要不写兜底文案', () => {
    // 一轮的输出被不渲染的块（todo 只看板）切开、又没有任何 thought/tool/plan：
    // 容器仍要收纳那些中间文字，此时摘要只剩字形 + 时长段，正是 ZCode 参照的
    // 「已工作 19 分 35 秒 ›」形态——故不写「无过程」类兜底文案。
    render({
      id: 'm10',
      role: 'assistant',
      text: '结论',
      blocks: [
        { type: 'text', text: '第一段' },
        { type: 'todo', title: '看板', entries: [{ content: '一步', status: 'pending', priority: 'medium' }] },
        { type: 'text', text: '结论' },
      ],
      createdAt: 0,
    })
    const header = processHeader()!
    expect(header).toBeTruthy()
    expect(header.textContent).not.toContain('思考')
    expect(header.textContent).not.toContain('工具调用')
    expect(header.textContent).not.toContain('计划')
    const row = container.querySelector<HTMLElement>('[data-chat-msg-id="m10"]')!
    expect(row.textContent).not.toContain('第一段')
    expect(row.textContent).toContain('结论')
  })
})

describe('ProcessBlocks 流式顺序（回归：思考块出现在最近一次输出的上面）', () => {
  // 2026-10-16 用户报告：流式中，正在流式输出的思考块会出现在最近一次输出的
  // **上面**，不符合流式顺序（截图场景：agent 输出「页面渲染成功…」之后又起了
  // 一轮思考）。根因是归组把「最后一个 text 块」之后的过程块也收进容器，而容器
  // 固定渲染在第一个被收纳块的位置（结论之前）——后到的过程块被整体提前到结论
  // 上方。修复：容器只收纳结论**之前**的前缀，结论及其后的块原位渲染，流式顺序
  // 在任意时刻成立（规格见 ui-style-guide §7.10）。
  /** 结论之后又起了一轮思考 + 工具（「最近一次输出之后」的典型形态）。 */
  function tailProcessMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
      id: 'm11',
      role: 'assistant',
      text: '页面渲染成功，抽屉里 user.go 已打开。',
      blocks: [
        { type: 'thought', text: '先做一轮推理' },
        { type: 'text', text: '页面渲染成功，抽屉里 user.go 已打开。' },
        { type: 'tool_call', toolCallId: 't1', title: '读文件', status: 'completed' },
        { type: 'thought', text: '继续推理中' },
      ],
      createdAt: 0,
      ...overrides,
    }
  }

  const rowText = () =>
    container.querySelector<HTMLElement>('[data-chat-msg-id="m11"]')!.textContent ?? ''

  it('流式中：结论之后新起的思考停在结论下方（不在上面）', () => {
    // 思考正文可见才能断言顺序：开「展开思考」；容器流式中默认展开。
    useAppStore.setState({ expandThinking: true })
    render(tailProcessMsg({ streaming: true }))
    const body = rowText()
    // 原序：先做一轮推理（容器内）→ 页面渲染成功 → 读文件 → 继续推理中（正在流式）
    expect(body.indexOf('先做一轮推理')).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('先做一轮推理')).toBeLessThan(body.indexOf('页面渲染成功'))
    expect(body.indexOf('页面渲染成功')).toBeLessThan(body.indexOf('读文件'))
    expect(body.indexOf('读文件')).toBeLessThan(body.indexOf('继续推理中'))
    // 容器只收纳结论之前的前缀：摘要计数不含结论后的那次思考与工具
    expect(processHeader()!.textContent).toContain('思考 1 次')
    expect(processHeader()!.textContent).not.toContain('工具调用')
  })

  it('结束后：结论之后的过程块仍在结论之后（原位），不再被提前', () => {
    useAppStore.setState({ expandThinking: true })
    render(tailProcessMsg({ streaming: false }))
    const body = rowText()
    expect(body.indexOf('页面渲染成功')).toBeLessThan(body.indexOf('读文件'))
    expect(body.indexOf('读文件')).toBeLessThan(body.indexOf('继续推理中'))
    // 整轮仍只有一行收纳摘要；结论前的思考收在容器里（默认收起不可见）
    expect(container.querySelectorAll('.process-header-btn').length).toBe(1)
    expect(body).not.toContain('先做一轮推理')
    expect(processHeader()!.textContent).toContain('思考 1 次')
  })

  it('结论是消息首块（前缀为空）：不出现容器，尾块原位渲染', () => {
    useAppStore.setState({ expandThinking: true })
    render({
      id: 'm12',
      role: 'assistant',
      text: '第一段输出',
      blocks: [
        { type: 'text', text: '第一段输出' },
        { type: 'thought', text: '随后思考' },
      ],
      createdAt: 0,
      streaming: true,
    })
    expect(container.querySelector('.process-header-btn')).toBeNull()
    const body = container.querySelector<HTMLElement>('[data-chat-msg-id="m12"]')!.textContent ?? ''
    expect(body.indexOf('第一段输出')).toBeLessThan(body.indexOf('随后思考'))
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

  it('折叠态标题为工作时长「已工作 X 分 X 秒」', () => {
    // 有 durationMs 时走结算值；秒数定格即表达「已完成」，不需要另设状态词。
    render(processMsg({ streaming: false, durationMs: 95_000 }))
    expect(processHeader()!.textContent).toContain('已工作 1分钟35秒')
  })

  it('无 durationMs 的历史消息不渲染时长段，只留计数', () => {
    // 迁移前的历史行可能没有结算耗时：此时不硬造一个 0 秒标题，只留计数段。
    render(processMsg({ streaming: false, durationMs: undefined }))
    const header = processHeader()!
    expect(header.textContent).not.toContain('已工作')
    expect(header.textContent).toContain('工具调用 2 次')
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

  it('流式中标题走实时读数（秒数在跳即表达进行中）', () => {
    // 标题主体是工作时长而非状态词：流式中秒数逐帧增长，本身就是「进行中」。
    // 实时读数来自后端 `turn_stats` 推送（utils/turnStats 缓存），挂载读缓存、
    // 推送到达直写 DOM，故同步断言即可。
    setLiveTurnStats('sess-live', { workMs: 5_000, toolMs: null, tps: null })
    try {
      render(processMsg({ streaming: true }), 'sess-live')
      expect(processHeader()!.textContent).toContain('已工作')
    } finally {
      clearAllLiveTurnStats()
    }
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

  it('单个过程块也收进整轮容器（不再有「单块段例外」）', () => {
    // 曾经的例外：一个思考块 / 工具卡本就有自己的折叠头，套容器会得到「容器摘要
    // + 块自己的头」两行重复信息。按轮归组后该例外取消——容器是**轮级**的，
    // 一轮只出一次摘要；块自己的头仍在容器展开后出现，与多块时同构。
    // （jsdom 下两个开关默认关，故容器收起时块头不在 DOM 里。）
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
    expect(container.querySelector('.process-header-btn')).toBeTruthy()
    expect(container.querySelector('.thinking-header-btn')).toBeNull()
    // 展开后块自己的标题行回来
    click(processHeader())
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
    ]) {
      expect(zhMap[k], `zh ${k}`).toBeTruthy()
      expect(enMap[k], `en ${k}`).toBeTruthy()
    }
  })
})
