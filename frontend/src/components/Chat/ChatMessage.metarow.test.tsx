import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '../../stores/chatStore'
import i18n from '../../i18n'
import { addOutputChars, beginTurn, clearTurnClock, endTurn, updateTurnTool } from '../../utils/turnClock'

// 元信息行（turn 耗时 / 工具耗时 / tps）的**换行约束**回归：中文没有空格，单文本节点
// 会被浏览器在数字与单位之间断行（2026-09-21 用户报告「5分钟」/「33秒」被拆开）。
// jsdom 不做布局，故不断言真实换行结果，而是断言「每个读数各自一个 nowrap 段」这一
// 结构不变量——它是换行只发生在段间的充分条件。
// 独立的轻量测试文件，避免给 ChatMessage 的其余渲染路径建重 harness。

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  clearTurnClock()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  clearTurnClock()
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

/** 元信息行里的读数段：nowrap 是唯一不变量，label+value 必须在同一段内。 */
function readingSegments(): HTMLSpanElement[] {
  const row = container.querySelector('.chat-meta-row')
  if (!row) return []
  return Array.from(row.querySelectorAll<HTMLSpanElement>('span')).filter(
    (el) => el.style.whiteSpace === 'nowrap',
  )
}

describe('ChatMessageView meta row line breaking', () => {
  it('splits the settled reading into nowrap segments so a unit never leaves its number', () => {
    // 结算值来自 turnClock 的定稿快照（finalTps / finalToolElapsedMs）。
    beginTurn('s1', 0)
    addOutputChars('s1', 400, 1_000)
    updateTurnTool('s1', 'a', 'in_progress', 1_000)
    updateTurnTool('s1', 'a', 'completed', 12_000)
    endTurn('s1', 12_000)
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 333_000 })}
          sessionId="s1"
          isLastAssistant
        />,
      )
    })
    const segments = readingSegments()
    expect(segments.length).toBe(3)
    // 「工作中 5分钟33秒」整段不断行：5分钟 与 33秒 之间没有断点。
    expect(segments[0].textContent).toBe('已工作 5分钟33秒')
    // 工具与速度各占一段，段内的 label 与 value 不分离。
    expect(segments[1].textContent).toBe(' · 工具约 11秒')
    expect(segments[2].textContent).toBe(' · 估算 100.0 t/s')
    for (const el of segments) expect(el.style.whiteSpace).toBe('nowrap')
  })

  it('drops absent readings instead of leaving an empty breakable segment', () => {
    beginTurn('s2', 0)
    endTurn('s2', 1_000)
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 2_000 })}
          sessionId="s2"
          isLastAssistant
        />,
      )
    })
    const segments = readingSegments()
    expect(segments.length).toBe(1)
    expect(segments[0].textContent).toBe('已工作 2秒')
  })

  it('splits the live reading the same way while streaming', () => {
    // 实时读数用 Date.now() 采样，故冻结时钟拿确定值（注入的 at 与采样时刻同源）。
    vi.useFakeTimers()
    vi.setSystemTime(3_000)
    beginTurn('s3', 0)
    addOutputChars('s3', 800, 1_000)
    updateTurnTool('s3', 'a', 'in_progress', 1_000)
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ streaming: true })}
          sessionId="s3"
          isLastAssistant
        />,
      )
    })
    const segments = readingSegments()
    expect(segments.length).toBe(3)
    expect(segments[0].textContent).toBe('工作中 3秒')
    expect(segments[1].textContent).toBe(' · 工具约 2秒')
    expect(segments[2].textContent).toBe(' · 估算 200.0 t/s')
    for (const el of segments) expect(el.style.whiteSpace).toBe('nowrap')
    vi.useRealTimers()
  })
})
