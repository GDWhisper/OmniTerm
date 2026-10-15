import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '../../stores/chatStore'
import i18n from '../../i18n'
import { clearAllLiveTurnStats, setLiveTurnStats } from '../../utils/turnStats'

// 元信息行（turn 耗时 / 工具耗时 / tps）的**换行约束 + 读数来源**回归：中文没有空格，
// 单文本节点会被浏览器在数字与单位之间断行（2026-09-21 用户报告「5分钟」/「33秒」被拆开）。
// jsdom 不做布局，故不断言真实换行结果，而是断言两条结构不变量：
// ①「每个读数各自一个 nowrap 段」——换行只发生在段间的充分条件；
// ② 流式期行宽托底 `min-width:max-content`（2026-10-14 用户报告窄正文块下三个读数
//    堆成三行）且结算行不得带它（E11「放不下才换行」只属于结算场合）。
//
// 读数来源（2026-10-15 翻盘，work-time 计划 E23）：定稿值是**消息自己的**后端结算
// 字段（`message.toolMs`/`message.tps`，来源 hydrate 或 prompt_done），流式值是后端
// `turn_stats` 推送经 `utils/turnStats` 缓存的只读显示——测试直接注入两者，不再驱动
// 任何本地计时算法（算法与口径回归整体迁至 `src/acp/turn_accumulator.rs`）。
// 独立的轻量测试文件，避免给 ChatMessage 的其余渲染路径建重 harness。

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  clearAllLiveTurnStats()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  clearAllLiveTurnStats()
})

function assistant(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    text: 'done',
    blocks: [{ type: 'text', text: 'done' }],
    createdAt: Date.now(),
    ...overrides,
  }
}

function metaRow(): HTMLDivElement | null {
  return container.querySelector<HTMLDivElement>('.chat-meta-row')
}

/** 元信息行里的读数段：nowrap 是唯一不变量，label+value 必须在同一段内。 */
function readingSegments(): HTMLSpanElement[] {
  const row = metaRow()
  if (!row) return []
  return Array.from(row.querySelectorAll<HTMLSpanElement>('span')).filter(
    (el) => el.style.whiteSpace === 'nowrap',
  )
}

describe('ChatMessageView meta row line breaking', () => {
  it('splits the settled reading into nowrap segments so a unit never leaves its number', () => {
    // 定稿读数来自消息自己的后端结算字段：工作 5分33秒 / 工具 2.5s（≈3秒）/ 400 t/s。
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 333_000, toolMs: 2_500, tps: 400 })}
          sessionId="s1"
          isLastAssistant
        />,
      )
    })
    const segments = readingSegments()
    expect(segments.length).toBe(3)
    // 「工作中 5分钟33秒」整段不断行：5分钟 与 33秒 之间没有断点。
    expect(segments[0].textContent).toBe('已工作 5分钟33秒')
    expect(segments[1].textContent).toBe(' · 工具约 3秒')
    expect(segments[2].textContent).toBe(' · 估算 400.0 t/s')
    for (const el of segments) expect(el.style.whiteSpace).toBe('nowrap')
    // 结算行不托宽：窄气泡下动作栏 + 结算值仍按 E11「放不下才换行」。
    expect(metaRow()?.style.minWidth).toBe('')
  })

  it('renders each history message with its own readings, not only the last one', () => {
    // 常驻语义：落库后的读数挂在**自己那条**消息上，历史行（非最后一条、无
    // isLastAssistant）同样显示，刷新后不回退（旧实现只挂最后一条 assistant）。
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 10_000, toolMs: 4_000, tps: 88.8, streaming: false })}
          sessionId="s1"
        />,
      )
    })
    const segments = readingSegments()
    expect(segments.length).toBe(3)
    expect(segments[0].textContent).toBe('已工作 10秒')
    expect(segments[1].textContent).toBe(' · 工具约 4秒')
    expect(segments[2].textContent).toBe(' · 估算 88.8 t/s')
  })

  it('drops absent readings instead of leaving an empty breakable segment', () => {
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 2_000, toolMs: 0, tps: null })}
          sessionId="s2"
          isLastAssistant
        />,
      )
    })
    const segments = readingSegments()
    // toolMs=0（有效观测没记到工具）与 tps=null（无可测窗口）都不渲染，只留工作段。
    expect(segments.length).toBe(1)
    expect(segments[0].textContent).toBe('已工作 2秒')
  })

  it('splits the live reading the same way while streaming and follows pushed updates', () => {
    // 流式读数 = 后端 `turn_stats` 推送的显示：注入一帧即渲染，注入新帧即更新。
    setLiveTurnStats('s3', { workMs: 6_000, toolMs: 3_000, tps: 400 })
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ streaming: true })}
          sessionId="s3"
          isLastAssistant
        />,
      )
    })
    let segments = readingSegments()
    expect(segments.length).toBe(3)
    expect(segments[0].textContent).toBe('工作中 6秒')
    expect(segments[1].textContent).toBe(' · 工具约 3秒')
    expect(segments[2].textContent).toBe(' · 估算 400.0 t/s')
    for (const el of segments) expect(el.style.whiteSpace).toBe('nowrap')
    // 流式期整行托到单行内容宽度：窄正文块（工具卡 / 刚起的文本泡）下三个读数
    // 也不允许被 flex-wrap 拆成三行（2026-10-14 用户报告）。
    expect(metaRow()?.style.minWidth).toBe('max-content')

    // 下一帧推送（工具结束、读数定住）→ 直写 DOM 更新，无需重渲染。
    act(() => setLiveTurnStats('s3', { workMs: 9_000, toolMs: 3_000, tps: 400 }))
    segments = readingSegments()
    expect(segments[0].textContent).toBe('工作中 9秒')
  })
})
