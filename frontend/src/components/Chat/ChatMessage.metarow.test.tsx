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
// ①「每个读数各自一个禁断行段」——换行只发生在段间的充分条件；
// ② 流式期行宽托底 `min-width:max-content`（2026-10-14 用户报告窄正文块下三个读数
//    堆成三行）且结算行不得带它（E11「放不下才换行」只属于结算场合）。
//
// 分隔符等距（2026-10-16 用户报告「14:32· 工具」左粘右疏）：读数段是 inline-flex 子项，
// 浏览器删掉子项行首的可折叠空格，`nowrap` 下「·」左侧间隙 0、右侧一空格宽。段样式改用
// `white-space:pre` 保住字面前导空格（`overflow-wrap:normal` 切断容器 `anywhere` 继承），
// 这是该视觉缺陷唯一可在 jsdom 里守住的因——见 `CHAT_META_SEGMENT_STYLE` 注释。
//
// 读数来源（2026-10-15 翻盘，work-time 计划 E23）：定稿值是**消息自己的**后端结算
// 字段（`message.toolMs`/`message.tps`/`message.finishedAt`，来源 hydrate 或
// prompt_done），流式值是后端 `turn_stats` 推送经 `utils/turnStats` 缓存的只读
// 显示——测试直接注入两者，不再驱动任何本地计时算法（算法与口径回归整体迁至
// `src/acp/turn_accumulator.rs`）。
// 结算主段（2026-10-16，计划 E25）：「已工作 x分x秒」替换为「结束于 HH:mm」
// （`finishedAt` + formatHoverTime 智能缩写）；无 finishedAt 的历史行整段不渲染
// （不回退「已工作」——用户拍板历史数据不兜底）。「已工作」保留在收纳行标题里。
//
// hover 说明浮层（2026-10-16 用户要求「只要 ACP 不提供、OmniTerm 计算这个意思」+
// 「复用 OmniTerm 风格，不要浏览器原生白底」）：文案收敛为一句 `chat.msg.omniComputed`，
// 只在屏幕上真有估算读数（工具耗时 / tps）时挂；样式走 `.chat-meta-tip-float`
// （`.pixel-float` 本体 + absolute/opacity），不再用原生 `title`。
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

/** 构造**今天**的某个本地时刻（RFC3339）——formatHoverTime 的「今天」分支返回
 *  HH:mm，期望值可硬编码且不依赖测试运行的时区。 */
function todayAt(hours: number, minutes: number): string {
  const d = new Date()
  d.setHours(hours, minutes, 0, 0)
  return d.toISOString()
}

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

/** 元信息行里的读数段：禁断行（`pre`）是唯一不变量，label+value 必须在同一段内。 */
function readingSegments(): HTMLSpanElement[] {
  const row = metaRow()
  if (!row) return []
  return Array.from(row.querySelectorAll<HTMLSpanElement>('span')).filter(
    (el) => el.style.whiteSpace === 'pre',
  )
}

/** 元信息行读数容器（三个读数段的父节点）上的 hover 说明浮层文本。空串 = 没挂浮层
 *  （没有需要解释的估算读数）——流式路径用 display:none 表达「没挂」。 */
function metaTip(): string {
  const row = metaRow()
  const float = row?.querySelector<HTMLSpanElement>('.chat-meta-tip-float')
  if (!float) return ''
  return float.style.display === 'none' ? '' : float.textContent ?? ''
}

/** 元信息行**可见**的读数段：流式路径把缺省段 display:none 掉（仍占 DOM），故再滤一层
 *  （textContent 为空同样不可能有读数，两道都留着——任一条将来单独失效不至于误判可见）。 */
function visibleReadingSegments(): HTMLSpanElement[] {
  return readingSegments().filter((el) => el.style.display !== 'none' && el.textContent !== '')
}

describe('ChatMessageView meta row line breaking', () => {
  it('splits the settled reading into unbreakable segments so a unit never leaves its number', () => {
    // 定稿读数来自消息自己的后端结算字段：主段「结束于 14:32」/ 工具 2.5s（≈3秒）/
    // 400 tok/s。
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 333_000, toolMs: 2_500, tps: 400, finishedAt: todayAt(14, 32) })}
          sessionId="s1"
          isLastAssistant
        />,
      )
    })
    const segments = readingSegments()
    expect(segments.length).toBe(3)
    expect(segments[0].textContent).toBe('结束于 14:32')
    expect(segments[1].textContent).toBe(' · 工具 3秒')
    expect(segments[2].textContent).toBe(' · 400.0 tok/s')
    for (const el of segments) {
      expect(el.style.whiteSpace).toBe('pre')
      expect(el.style.overflowWrap).toBe('normal')
    }
    // 结算行不托宽：窄气泡下动作栏 + 结算值仍按 E11「放不下才换行」。
    expect(metaRow()?.style.minWidth).toBe('')
  })

  it('renders each history message with its own readings, not only the last one', () => {
    // 常驻语义：落库后的读数挂在**自己那条**消息上，历史行（非最后一条、无
    // isLastAssistant）同样显示，刷新后不回退（旧实现只挂最后一条 assistant）。
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 10_000, toolMs: 4_000, tps: 88.8, finishedAt: todayAt(9, 5), streaming: false })}
          sessionId="s1"
        />,
      )
    })
    const segments = readingSegments()
    expect(segments.length).toBe(3)
    expect(segments[0].textContent).toBe('结束于 09:05')
    expect(segments[1].textContent).toBe(' · 工具 4秒')
    expect(segments[2].textContent).toBe(' · 88.8 tok/s')
  })

  it('drops absent readings instead of leaving an empty breakable segment', () => {
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 2_000, toolMs: 0, tps: null, finishedAt: todayAt(14, 32) })}
          sessionId="s2"
          isLastAssistant
        />,
      )
    })
    const segments = readingSegments()
    // toolMs=0（有效观测没记到工具）与 tps=null（无可测窗口）都不渲染，只留主段。
    expect(segments.length).toBe(1)
    expect(segments[0].textContent).toBe('结束于 14:32')
  })

  it('drops the whole settled segment when the turn has no finishedAt (legacy row)', () => {
    // 用户 2026-10-16 拍板：历史数据不兜底——无结束时刻的老行不回退「已工作」，
    // 结算段（含工具/tps 段与 hover 说明）整段撤掉；时长仍可在收纳行标题看到
    // （见 ChatMessage.process 测试）。
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 10_000, toolMs: 4_000, tps: 88.8 })}
          sessionId="s1"
          isLastAssistant
        />,
      )
    })
    expect(readingSegments()).toHaveLength(0)
    expect(metaTip()).toBe('')
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
    for (const el of segments) {
      expect(el.style.whiteSpace).toBe('pre')
      expect(el.style.overflowWrap).toBe('normal')
    }
    // 流式期整行托到单行内容宽度：窄正文块（工具卡 / 刚起的文本泡）下三个读数
    // 也不允许被 flex-wrap 拆成三行（2026-10-14 用户报告）。
    expect(metaRow()?.style.minWidth).toBe('max-content')

    // 下一帧推送（工具结束、读数定住）→ 直写 DOM 更新，无需重渲染。
    act(() => setLiveTurnStats('s3', { workMs: 9_000, toolMs: 3_000, tps: 400 }))
    segments = readingSegments()
    expect(segments[0].textContent).toBe('工作中 9秒')
  })

  it('renders the live reading only at the bottom of the latest assistant message', () => {
    // 同一 turn 会被 system 通知 / 工具卡切成多条 streaming 消息；`turn_stats` 是
    // 会话级读数，逐条渲染会让同一组「工作中 … · 工具 … · … tok/s」在消息流里
    // 重复出现（2026-10-18 用户报告截图）。唯一显示处 = 最后一条 assistant 底部。
    setLiveTurnStats('s7', { workMs: 6_000, toolMs: 3_000, tps: 400 })
    act(() => {
      root.render(
        <>
          <ChatMessageView
            message={assistant({ id: 'm-earlier', streaming: true })}
            sessionId="s7"
          />
          <ChatMessageView
            message={assistant({ id: 'm-latest', streaming: true })}
            sessionId="s7"
            isLastAssistant
          />
        </>,
      )
    })
    const rows = container.querySelectorAll<HTMLDivElement>('.chat-meta-row')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('工作中 6秒')
    expect(rows[0].textContent).toContain(' · 工具 3秒')
    expect(rows[0].textContent).toContain(' · 400.0 tok/s')
  })
})

// hover 说明浮层（2026-10-16 用户要求「只要 ACP 不提供、OmniTerm 计算这个意思」）：
// 文案收敛为一句，且只在屏幕上真有估算读数（工具耗时 / tps）时挂——没有需要解释的
// 数字就不挂。样式走 `.chat-meta-tip-float`（`.pixel-float` 本体），不是浏览器原生
// `title`（白底系统 tooltip 与 OmniTerm 视觉语言冲突）。
describe('ChatMessageView meta row hover note', () => {
  it('shows one short OmniTerm-style note on the settled row and drops the native title', () => {
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 10_000, toolMs: 4_000, tps: 88.8, finishedAt: todayAt(14, 32) })}
          sessionId="s1"
          isLastAssistant
        />,
      )
    })
    expect(metaTip()).toBe('ACP 不提供该数据，由 OmniTerm 计算')
    // 原生 title 已弃用：留着就会在自定义浮层之外再弹一个系统白底 tooltip。
    expect(readingSegments()[0]?.parentElement?.title ?? '').toBe('')
    // 浮层本体复用 .pixel-float（§6 统一浮层档）。
    expect(metaRow()?.querySelector('.chat-meta-tip-float')?.className).toContain('pixel-float')
  })

  it('anchors the float to the readings themselves, not to the whole row', () => {
    // 防「tooltip 漂移」回归（2026-10-16 用户报告：鼠标指向读数那一边，浮层却出现在
    // 消息列左缘）。读数是右对齐的，浮层只有挂在读数 span 上（CSS `right:0` 与读数
    // 右缘对齐）才跟着光标走；挂到 `.chat-meta-row` 上就整体跑到列左缘。
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 10_000, toolMs: 4_000, tps: 88.8, finishedAt: todayAt(14, 32) })}
          sessionId="s1"
          isLastAssistant
        />,
      )
    })
    const float = metaRow()?.querySelector('.chat-meta-tip-float')
    // 父节点必须是读数容器本身（三个读数段的父节点），不是 .chat-meta-row。
    expect(float?.parentElement).toBe(readingSegments()[0]?.parentElement)
    expect(float?.parentElement?.className).toContain('chat-meta-tip')
    expect(float?.parentElement).not.toBe(metaRow())
  })

  it('drops the note when neither estimated reading is on screen', () => {
    // toolMs=0（有效观测没记到工具）且 tps=null（无可测窗口）→ 屏幕上没有估算读数，
    // 挂一句「这个数据怎么算的」只会让人去找不存在的数字。
    act(() => {
      root.render(
        <ChatMessageView
          message={assistant({ durationMs: 2_000, toolMs: 0, tps: null, finishedAt: todayAt(14, 32) })}
          sessionId="s2"
          isLastAssistant
        />,
      )
    })
    expect(metaTip()).toBe('')
    expect(visibleReadingSegments().map((el) => el.textContent)).toEqual(['结束于 14:32'])
  })

  it('keeps the live note in sync with the pushed frame', () => {
    setLiveTurnStats('s4', { workMs: 6_000, toolMs: null, tps: null })
    act(() => {
      root.render(
        <ChatMessageView message={assistant({ streaming: true })} sessionId="s4" isLastAssistant />,
      )
    })
    // 只有工作段（后端实测，非估算）→ 不挂说明。
    expect(visibleReadingSegments()).toHaveLength(1)
    expect(metaTip()).toBe('')

    // 推送带上工具与速率 → 挂上那句说明。
    act(() => setLiveTurnStats('s4', { workMs: 9_000, toolMs: 3_000, tps: 400 }))
    expect(visibleReadingSegments()).toHaveLength(3)
    expect(metaTip()).toBe('ACP 不提供该数据，由 OmniTerm 计算')
  })

  it('re-translates the live note when the language changes', async () => {
    // 浮层唯一写入方是 effect 里的 draw()（直写 DOM），推送帧覆盖不到语言切换，
    // 只能靠 effect 因 `t`/`i18n` 变化重跑——这条路径没有任何推送触发，必须显式钉住。
    setLiveTurnStats('s5', { workMs: 9_000, toolMs: 3_000, tps: 400 })
    act(() => {
      root.render(
        <ChatMessageView message={assistant({ streaming: true })} sessionId="s5" isLastAssistant />,
      )
    })
    expect(metaTip()).toBe('ACP 不提供该数据，由 OmniTerm 计算')
    expect(visibleReadingSegments().map((el) => el.textContent)).toEqual([
      '工作中 9秒',
      ' · 工具 3秒',
      ' · 400.0 tok/s',
    ])

    await act(async () => {
      await i18n.changeLanguage('en')
    })
    expect(metaTip()).toBe('ACP does not provide this data; OmniTerm computes it')
    expect(visibleReadingSegments().map((el) => el.textContent)).toEqual([
      'working 9s',
      ' · tools 3s',
      ' · 400.0 tok/s',
    ])
  })

  it('clears the live note when the turn is voided', () => {
    // turn 作废（prompt_done / prompt_error / turn_state inactive）→ clearLiveTurnStats(null)
    // → 三段读数与说明一起撤掉；留着旧说明会解释已经不在屏幕上的数字。
    setLiveTurnStats('s6', { workMs: 9_000, toolMs: 3_000, tps: 400 })
    act(() => {
      root.render(
        <ChatMessageView message={assistant({ streaming: true })} sessionId="s6" isLastAssistant />,
      )
    })
    expect(metaTip()).toBe('ACP 不提供该数据，由 OmniTerm 计算')

    act(() => clearLiveTurnStats('s6'))
    expect(metaTip()).toBe('')
    expect(visibleReadingSegments()).toHaveLength(0)
  })
})

// 诚实口径必须**两个 locale 同时成立**：上面的渲染断言只跑当前语言（beforeEach 固定 zh），
// 而 en 是 fallbackLng——文案若被润色回「est./约 + 后端估算」的旧措辞，或在某一侧被
// 写成长篇，「hover 只说一句」会在 en 侧被静默推翻。故直接钉两份 JSON 的文案语义
// （与 Settings.test.tsx 的 en/zh 对齐断言同一模式），不依赖渲染路径。
describe('meta row honest copy in both locales', () => {
  const enMap = en as Record<string, string>
  const zhMap = zh as Record<string, string>

  it('states in both locales that ACP does not provide the data and OmniTerm computes it', () => {
    for (const [name, map] of [['en', enMap], ['zh', zhMap]] as const) {
      expect(map['chat.msg.omniComputed'], name).toMatch(/ACP/)
      expect(map['chat.msg.omniComputed'], name).toMatch(/OmniTerm/)
      // 「只要这个意思」：一句话，不写计算口径、不写落库/刷新说明。
      expect(map['chat.msg.omniComputed'], name).not.toMatch(/÷|burst|落库|刷新/)
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

  it('labels the settled main reading as a wall-clock end time in both locales', () => {
    // 主段「结束于 {{time}}」：时间是 `formatHoverTime` 的本地智能缩写（今天 HH:mm，
    // 跨天带日期），占位符必须叫 {{time}}（不是 {{dur}}，那不是时长）。
    expect(zhMap['chat.msg.endedAt']).toBe('结束于 {{time}}')
    expect(enMap['chat.msg.endedAt']).toBe('Ended at {{time}}')
  })
})
