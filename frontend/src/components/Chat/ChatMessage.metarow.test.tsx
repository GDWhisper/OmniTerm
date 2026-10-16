import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '../../stores/chatStore'
import i18n from '../../i18n'
import en from '../../locales/en/translation.json'
import zh from '../../locales/zh/translation.json'
import { clearAllLiveTurnStats, clearLiveTurnStats, setLiveTurnStats } from '../../utils/turnStats'

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

/** 元信息行读数容器（三个 nowrap 段的父节点）的 hover tooltip。 */
function metaTitle(): string {
  return readingSegments()[0]?.parentElement?.title ?? ''
}

/** 元信息行**可见**的读数段：流式路径把缺省段 display:none 掉（仍占 DOM），故再滤一层
 *  （textContent 为空同样不可能有读数，两道都留着——任一条将来单独失效不至于误判可见）。 */
function visibleReadingSegments(): HTMLSpanElement[] {
  return readingSegments().filter((el) => el.style.display !== 'none' && el.textContent !== '')
}

describe('ChatMessageView meta row line breaking', () => {
  it('splits the settled reading into nowrap segments so a unit never leaves its number', () => {
    // 定稿读数来自消息自己的后端结算字段：工作 5分33秒 / 工具 2.5s（≈3秒）/ 400 tok/s。
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
    expect(segments[1].textContent).toBe(' · 工具 3秒')
    expect(segments[2].textContent).toBe(' · 400.0 tok/s')
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
    expect(segments[1].textContent).toBe(' · 工具 4秒')
    expect(segments[2].textContent).toBe(' · 88.8 tok/s')
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
    expect(segments[1].textContent).toBe(' · 工具 3秒')
    expect(segments[2].textContent).toBe(' · 400.0 tok/s')
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

// 读数文案的**诚实口径**（2026-10-15 用户要求「hover 时诚实简单地说清楚」）：界面只出
// 「工具 N秒 · R tok/s」不带「约/估算」前缀，性质说明全部收在 hover——ACP 不返回真实
// token 速率、也不上报工具耗时，两个读数都是 omniterm 自己算的。
describe('ChatMessageView meta row honest tooltips', () => {
  it('says on the settled row that ACP reports no token rate and OmniTerm estimates it', () => {
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 10_000, toolMs: 4_000, tps: 88.8 })}
          sessionId="s1"
          isLastAssistant
        />,
      )
    })
    const title = metaTitle()
    expect(title).toContain('ACP 不返回真实 token 速率')
    expect(title).toContain('由 omniterm 估算')
    // 工具耗时同样标明「ACP 不上报」。
    expect(title).toContain('ACP 不上报该数据')
  })

  it('explains only the readings that are actually on screen', () => {
    // tps=null（无可测窗口）→ 那段说明不进 tooltip，否则等于让人去找不存在的数字。
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 2_000, toolMs: 0, tps: null })}
          sessionId="s2"
          isLastAssistant
        />,
      )
    })
    const title = metaTitle()
    expect(title).toContain('已工作 2秒')
    expect(title).not.toContain('token 速率')
    expect(title).not.toContain('工具执行时长')
  })

  it('keeps the live tooltip in sync with the pushed frame', () => {
    setLiveTurnStats('s4', { workMs: 6_000, toolMs: null, tps: null })
    act(() => {
      root.render(
        <ChatMessageView message={assistant({ streaming: true })} sessionId="s4" isLastAssistant />,
      )
    })
    // 只有工作段：tooltip 不该出现工具/速率的说明。
    expect(visibleReadingSegments()).toHaveLength(1)
    const workOnly = metaTitle()
    expect(workOnly).toContain('工作时长')
    expect(workOnly).not.toContain('token 速率')
    expect(workOnly).not.toContain('工具执行时长')

    // 推送带上工具与速率 → tooltip 补上两段说明，其中速率那段是诚实口径。
    act(() => setLiveTurnStats('s4', { workMs: 9_000, toolMs: 3_000, tps: 400 }))
    expect(visibleReadingSegments()).toHaveLength(3)
    const title = metaTitle()
    expect(title).toContain('ACP 不返回真实 token 速率')
    expect(title).toContain('由 omniterm 估算')
    expect(title.startsWith('由后端实时结算的工作时长')).toBe(true)
  })

  it('re-translates the live tooltip when the language changes', async () => {
    // tooltip 唯一写入方是 effect 里的 draw()（直写 DOM），推送帧覆盖不到语言切换，
    // 只能靠 effect 因 `t`/`i18n` 变化重跑——这条路径没有任何推送触发，必须显式钉住。
    setLiveTurnStats('s5', { workMs: 9_000, toolMs: 3_000, tps: 400 })
    act(() => {
      root.render(
        <ChatMessageView message={assistant({ streaming: true })} sessionId="s5" isLastAssistant />,
      )
    })
    expect(metaTitle()).toContain('由 omniterm 估算')
    expect(visibleReadingSegments().map((el) => el.textContent)).toEqual([
      '工作中 9秒',
      ' · 工具 3秒',
      ' · 400.0 tok/s',
    ])

    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(metaTitle()).toContain('OmniTerm estimates it')
    expect(visibleReadingSegments().map((el) => el.textContent)).toEqual([
      'working 9s',
      ' · tools 3s',
      ' · 400.0 tok/s',
    ])
  })

  it('clears the live tooltip when the turn is voided', () => {
    // turn 作废（prompt_done / prompt_error / turn_state inactive）→ clearLiveTurnStats(null)
    // → 三段读数与 tooltip 一起撤掉；留着旧 tooltip 会解释已经不在屏幕上的数字。
    setLiveTurnStats('s6', { workMs: 9_000, toolMs: 3_000, tps: 400 })
    act(() => {
      root.render(
        <ChatMessageView message={assistant({ streaming: true })} sessionId="s6" isLastAssistant />,
      )
    })
    expect(metaTitle()).toContain('由 omniterm 估算')

    act(() => clearLiveTurnStats('s6'))
    expect(metaTitle()).toBe('')
    expect(visibleReadingSegments()).toHaveLength(0)
  })
})

// 诚实口径必须**两个 locale 同时成立**：上面的渲染断言只跑当前语言（beforeEach 固定 zh），
// 而 en 是 fallbackLng——文案若被润色回「est./约 + 后端估算」的旧措辞，「hover 诚实说清楚」
// 会在 en 侧被静默推翻。故直接钉两份 JSON 的文案语义（与 Settings.test.tsx 的 en/zh 对齐
// 断言同一模式），不依赖渲染路径。
describe('meta row honest copy in both locales', () => {
  const enMap = en as Record<string, string>
  const zhMap = zh as Record<string, string>

  it('states in both locales that ACP reports no rate and OmniTerm estimates it', () => {
    for (const [name, map] of [['en', enMap], ['zh', zhMap]] as const) {
      expect(map['chat.msg.tpsTip'], name).toMatch(/token 速率|token rate/i)
      expect(map['chat.msg.tpsTip'], name).toMatch(/ACP/)
      expect(map['chat.msg.tpsTip'], name).toMatch(/OmniTerm|omniterm/)
      // 工具耗时同样标明「ACP 不上报」。
      expect(map['chat.msg.toolTimeTip'], name).toMatch(/ACP/)
    }
  })

  it('drops the est. hedge from both labels and uses tok/s', () => {
    // 界面文案只出事实：不带「约 / 估算 / est.」前缀，单位统一 tok/s。
    expect(zhMap['chat.msg.toolTime']).toBe('工具 {{dur}}')
    expect(zhMap['chat.msg.tps']).toBe('{{tps}} tok/s')
    expect(enMap['chat.msg.toolTime']).toBe('tools {{dur}}')
    expect(enMap['chat.msg.tps']).toBe('{{tps}} tok/s')
    for (const [name, map] of [['en', enMap], ['zh', zhMap]] as const) {
      expect(map['chat.msg.toolTime'], name).not.toMatch(/约|est\./i)
      expect(map['chat.msg.tps'], name).not.toMatch(/est\.|t\/s(?!o)/i)
    }
  })
})
