import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { ChatMessage, ContentBlock, ToolCallBlock, PlanBlock, SystemBlockDetail } from '../../stores/chatStore'
import { useAppStore } from '../../stores/appStore'
import { useStickScroll } from '../../hooks/useStickScroll'
import { useLongPress } from '../../hooks/useLongPress'
import { OverlayScroll } from '../Common/OverlayScroll'
import { Markdown } from './Markdown'
import { READER_FONT } from '../../utils/fonts'
import { formatHoverTime, formatToolDuration, formatTps, formatWorkDuration } from '../../utils/formatTime'
import {
  getLiveTurnStats,
  subscribeLiveTurnStats,
  type LiveTurnStats,
} from '../../utils/turnStats'
import { PERM_TIMEOUT_NEVER_SECS, permTimeoutDuration, permTimeoutNoticeLabel, permTimeoutSeconds } from '../../utils/permTimeout'
import { looksLikeDiff } from '../../utils/diff'
import { resolveThinkingStreamingSummary } from '../../utils/thinkingCollapsed'
import { DiffView } from './DiffView'
import { FileLocationLink } from './FileLocationLink'
import { messageActions, type MessageActionHandlers, type MessageActionContext } from './messageActions'
import { MessageActionBar, type ActionMenuPosition } from './MessageActionBar'
import { hapticTap } from '../../utils/haptics'
import { copyText } from '../../utils/clipboard'
import { useToastStore } from '../../stores/toastStore'
import { IconCopy } from '../FileManager/icons'
import { imageSrc } from '../../utils/imageAttachment'
import { formatFileSize } from '../../utils/fileAttachment'
import { IconFile } from '../FileManager/icons'

// 用户输入（已发送）正文超过此行数时默认折叠，提供展开/收起。
const USER_TEXT_COLLAPSE_LINES = 8
// 折叠态下展示的最大行数（其余内容隐藏，点击展开后全量显示）。
const USER_TEXT_PREVIEW_LINES = 8
// 正文气泡的宽度上限（思考块/工具卡/文本泡/用户泡共用）。贴气泡右缘的元信息行
// （turn 耗时）必须用同一个值，否则两处百分比各改各的，右缘就错开了。
const BUBBLE_MAX_WIDTH = '85%'
// 消息行内块间距。过程容器是消息行内部的「小消息行」，复用同一个值——
// 容器内的明细块与它们平铺在消息行下时间距一致。
const MSG_ROW_GAP = 6

// 气泡底部元信息文字（turn 结算耗时 / 流式实时计时与 tps）共用的规格：两者占据同一槽位，
// 定稿瞬间从「跳动值」换成「结算值」时只有文案变、字号/字距/数字宽度都不变，才不会
// 看着像抖了一下。颜色是两者唯一的视觉差（实时态更亮一档），由调用方覆盖。
//
// **不含 `marginLeft:auto`**——左右对齐是状态相关的：流式期动作栏恒空、读数**靠左**；
// 定稿后动作栏回归左侧、读数用 `marginLeft:auto` 顶到**右侧**（见 CHAT_META_RIGHT）。
// **段内绝不换行**——中文没有空格，`whiteSpace:normal` + `overflowWrap:anywhere` 会让浏览器
// 在数字与单位之间断行（实测「5分钟」/「33秒」、「工具」/「<1秒」、「63.5」/「tok/s」
// 三处都被拆开，2026-09-21 用户报告），故三个读数各自一个禁断行的段（见
// CHAT_META_SEGMENT_STYLE：`pre` 而非 `nowrap`，否则分隔符行首空格被折叠）。
// 段间换行是状态相关的：**流式期整行固定单行**（行宽由渲染处 `min-width:max-content` 托底，
// 2026-10-14 用户报告窄正文块下三段堆成三行）；**定稿后**容器 flex-wrap 承接段间换行——
// 结算场合行里还有动作栏，沿用 E11 的「放不下才换行」。
const CHAT_META_TEXT_STYLE: CSSProperties = {
  fontSize: '0.769em',
  fontFamily: READER_FONT,
  letterSpacing: '0.03em',
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'normal',
  minWidth: 0,
  maxWidth: '100%',
  overflowWrap: 'anywhere',
  display: 'inline-flex',
  flexWrap: 'wrap',
}

// 单个读数（一段完整语义，如「工具 12秒」）：段内禁止断行，数字与单位永不分离。
//
// **必须 `whiteSpace:'pre'` 而不是 `'nowrap'`**：读数段是 inline-flex 子项，每个子项
// 自成一个块级行首，CSS 会把行首的可折叠空格整段删掉。2026-10-16 用户报告
// 「结束于 14:32 · 工具 3秒 · 55.5 tok/s」的分隔符两侧间隙不均衡——实测 `nowrap` 下
// 「14:32」与「·」之间的空格宽 0px、「·」与「工具」之间 7.75px（等宽字体一空格宽），
// 视觉上是「14:32· 工具」左粘右疏。`pre` 保留字面空格且同样禁止段内换行（含窄容器
// 被迫收缩时不从段中断开，实测与 nowrap 一致），分隔符两侧各一空格故等距。
// `overflowWrap:'normal'` 显式切断容器 `anywhere` 的继承：`pre` 与继承来的 `anywhere`
// 是否允许段内任意断行在规范上含混，这里按「段内绝不换行」的契约钉死。
const CHAT_META_SEGMENT_STYLE: CSSProperties = { whiteSpace: 'pre', overflowWrap: 'normal' }

// 结算值（定稿后）在元信息行里顶到右缘。流式实时读数**不加**这一条，故停在左侧。
// 拆段后 textAlign 对 flex 子项无效，右缘改由 justify-content 表达。
const CHAT_META_RIGHT: CSSProperties = { marginLeft: 'auto', justifyContent: 'flex-end' }

const TOOL_KIND_ICONS: Record<string, string> = {
  read: '▤',
  edit: '✎',
  execute: '▶',
  search: '⌕',
  delete: '✕',
  write: '✍',
  browser: '◍',
}

const TOOL_KIND_LABELS: Record<string, string> = {
  read: 'READ',
  edit: 'EDIT',
  execute: 'EXECUTE',
  search: 'SEARCH',
  delete: 'DELETE',
  write: 'WRITE',
  browser: 'BROWSE',
}

/**
 * 块级复制角标（P1）：悬浮块内容右上角显示，点击复制该块原文。
 * 语义按块类型：text 复制正文、thought 复制思考、tool_call 复制 content（含 diff 原文）。
 * 用 getState-action（useToastStore.getState().addToast）避免订阅 store 破坏 memo。
 */
function BlockCopyButton({ text }: { text: string }) {
  const { t } = useTranslation()
  if (!text) return null
  return (
    <button
      type="button"
      className="chat-block-copy-btn"
      title={t('chat.msg.copy')}
      aria-label={t('chat.msg.copy')}
      onClick={(e) => {
        e.stopPropagation()
        void copyText(text).then((ok) => {
          useToastStore.getState().addToast(
            ok ? 'success' : 'error',
            ok ? t('chat.msg.copySuccess') : t('chat.msg.copyFailed'),
          )
        })
      }}
    >
      <IconCopy style={{ width: 12, height: 12, verticalAlign: 'text-bottom' }} />
    </button>
  )
}

/**
 * 已发送 user 消息正文。内容超过 USER_TEXT_COLLAPSE_LINES 行时默认折叠，
 * 保留预览行数并提供展开/收起开关；短内容原样渲染。
 */
function CollapsibleUserText({ text }: { text: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const lineCount = text.split('\n').length
  const collapsed = !open && lineCount > USER_TEXT_COLLAPSE_LINES

  return (
    <>
      <pre
        style={{
          margin: 0,
          whiteSpace: 'pre-wrap',
          fontFamily: 'inherit',
          fontSize: 'inherit',
          lineHeight: 'inherit',
          color: 'inherit',
          overflow: collapsed ? 'hidden' : undefined,
          maxHeight: collapsed ? `${USER_TEXT_PREVIEW_LINES * 1.5}em` : undefined,
        }}
      >
        {text}
      </pre>
      {lineCount > USER_TEXT_COLLAPSE_LINES && (
        <button
          onClick={() => setOpen(!open)}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-faint)',
            fontSize: '0.846em',
            padding: '2px 0 0',
            fontFamily: READER_FONT,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {open ? '▴ ' + t('chat.msg.collapse') : '▾ ' + t('chat.msg.expand')}
        </button>
      )}
    </>
  )
}

// 思考内容的排版规格（单一真源：展开区与收起态实时思考行共用）。
// 比正文（text 气泡 1em）小一档 + `--text-muted` 虚化，**刻意不加斜体**——
// 思考块此前的斜体是「思考=斜体」的排版俗套，与 OmniTerm 的等宽阅读字体
// 不搭（2026-10-13 用户要求修正）。行高与内容区一致。
const THINKING_TEXT_STYLE: CSSProperties = {
  fontSize: '0.923em',
  lineHeight: 1.5,
  color: 'var(--text-muted)',
}

// 收起态实时思考行的溢出遮罩：左缘 16px 渐隐，提示「左侧还有被滚走的内容」。
// 仅在单行视口确实溢出时叠加（见组件里的 lineOverflow）——不溢出时右缘是完整
// 的最新 token，加遮罩反而会把内容啃掉一块。
const THINKING_LINE_MASK_STYLE: CSSProperties = {
  WebkitMaskImage:
    'linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)',
  maskImage:
    'linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)',
  WebkitMaskRepeat: 'no-repeat',
  maskRepeat: 'no-repeat',
  WebkitMaskSize: '100% 100%',
  maskSize: '100% 100%',
}

/** 耗时刷新间隔（毫秒）：展开态每秒给「持续了 N 秒」进位一次。 */
const THINKING_DURATION_TICK_MS = 1000

/** 收纳行字形：与思考块的 `◆` 同族不同形，避免两块视觉混淆。 */
const PROCESS_HEADER_ICON = '◈'

/** 被收进过程容器的单块 + 它在原 blocks[] 中的下标。含中间的 text 输出。 */
interface ProcessEntry {
  block: ContentBlock
  idx: number
}

/**
 * 消息级「过程容器」：把**一轮** ACP 输出里**最终结论之前**的一切收进同一个
 * 折叠器——过程块（thought / tool_call / plan）与夹在过程块之间的中间 text 输出；
 * 结论及其后的块留在容器外原位（流式顺序在任意时刻成立，2026-10-16 修复）。
 * 折叠态只留**一行摘要**，最终 text 结论（流式中正在生长的那段）留在容器外始终
 * 可见。对齐 ZCode 容器型工具（`ToolCallBlocks/renderers/agent.tsx` +
 * `ToolLayout.tsx`）的交互：
 *
 * - **流式中展开、完成后自动折叠**（用户 2026-10-14 选定）。运行中跟着看过程，
 *   一结束就收纳成一行，长串明细不会永久摊开在聊天流里。
 * - 摘要走**计数聚合**而非罗列（对齐 ZCode `formatExploreSummary` 的
 *   search/list/file 计数）：「思考 2 · 工具调用 3 · 计划 1」比把每个块名列一遍
 *   更短，也不会随块数增长而无限变长。
 * - 用户手动展开/收起过后，自动规则不再覆盖他的选择（对齐 ZCode 的
 *   `userInteractedRef`）。
 *
 * 与既有「展开思考」「展开工具调用」两个开关**不同层、不冲突**：容器决定
 * 「看不看得到明细」，那两个开关决定「展开后明细的粒度」——容器展开时内部各块
 * 照旧按开关渲染（ThoughtBlockView / ToolCallBlockView 各自读自己的设定）。
 */
function ProcessBlocks({
  entries,
  streaming,
  workText,
  renderEntry,
}: {
  entries: ProcessEntry[]
  streaming: boolean
  /** turn 工作时长结算值（后端定稿时算出的 `message.durationMs` 格式化）。
   *  流式期恒为 null：实时时长只在气泡底部元信息行显示一次（后端 `turn_stats`
   *  是会话级读数，同一 turn 的多条 streaming 消息拿到的是同一份值）。 */
  workText: string | null
  renderEntry: (entry: ProcessEntry) => ReactNode
}) {
  const { t } = useTranslation()
  // 流式中默认展开（跟着看过程）；历史 / 已定稿的默认收起（收纳）。
  const [open, setOpen] = useState(streaming)
  // 用户是否手动干预过：置位后自动折叠不再插手（对齐 ZCode userInteractedRef）。
  const userInteractedRef = useRef(false)
  const wasStreamingRef = useRef(streaming)

  // 流式结束边沿自动折叠。判边沿而非「streaming 为 false 就折」——后者会在用户
  // 手动展开后、下一轮流式结束时再次折叠，把用户的选择覆盖掉。
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current
    wasStreamingRef.current = streaming
    if (!wasStreaming || streaming) return
    if (userInteractedRef.current) return
    setOpen(false)
  }, [streaming])

  const toggle = () => {
    userInteractedRef.current = true
    setOpen((v) => !v)
  }

  // 计数聚合。代价 O(块数)，流式中每渲染一次全量重数也远不到需要 memo 的量级
  // （一轮的过程块通常个位数到几十），故不包 useMemo——包了反而要管 entries 的
  // 引用稳定性（每次渲染新建），得不偿失。
  let thoughtCount = 0
  let toolCount = 0
  let planCount = 0
  for (const { block } of entries) {
    if (block.type === 'thought') thoughtCount++
    else if (block.type === 'tool_call') toolCount++
    else if (block.type === 'plan') planCount++
  }

  // 只收计数非零的段，段间 `·`。可能全零——一轮只有中间 text 输出、没有任何
  // thought/tool/plan 时容器仍要收纳那些文字，此时摘要只剩时长段与箭头，
  // 正是 ZCode 参照的形态（`已工作 19 分 35 秒 ›`），故不写兜底文案。
  const parts: string[] = []
  if (thoughtCount > 0) parts.push(t('chat.process.thoughtCount', { count: thoughtCount }))
  if (toolCount > 0) parts.push(t('chat.process.toolCount', { count: toolCount }))
  if (planCount > 0) parts.push(t('chat.process.planCount', { count: planCount }))

  // 标题主体是**结算后的工作时长**（用户 2026-10-14 明确要求「标题是已工作 x 分 x 秒」）。
  // 流式期不再在这里显示实时时长：`turn_stats` 是会话级读数，同一 turn 被
  // system 通知/工具卡切成多条 streaming 消息时，收纳行会在每条消息上重复同一
  // 个「已工作」值；实时读数统一由气泡底部元信息行唯一承担（2026-10-18 用户报告）。
  const durLabel = workText ? t('chat.msg.workTime', { dur: workText }) : null

  return (
    // 容器必须是**flex column**（与消息行 `.chat-msg-row` 同一格式化上下文），
    // 不能是普通块容器：entries 里的 `ToolCallBlockView` 根节点是
    // `display:inline-flex`、`ThoughtBlockView`/`PlanBlockView` 是普通块级 div，
    // 它们在块容器里一个退化成行内级、一个铺满容器宽——
    // 工具卡会与收纳行标题挤进同一行并按基线对齐产生纵向错位，长卡再折行到
    // 下一行；思考/计划块铺满容器宽则把块级复制角标甩到容器远右缘
    // （2026-10-15 用户报告「工具调用信息位置错乱，复制按钮也是乱的」）。
    // 立成 flex column 后三者都被块化成 flex item：各自 shrink-to-fit、
    // 按行堆叠，与加容器前直接挂在消息行下完全一致。
    // 不带 `.chat-block`：容器自己没有复制角标，挂上只会让
    // `.chat-block:hover .chat-block-copy-btn` 变成「hover 容器即亮出全部
    // 内部角标」，而每个明细块本该只由自己的 hover 点亮。
    <div
      data-chat-body="true"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: MSG_ROW_GAP,
        alignSelf: 'flex-start',
        maxWidth: BUBBLE_MAX_WIDTH,
      }}
    >
      <button onClick={toggle} className="process-header-btn" style={{ fontSize: '0.846em' }}>
        <span style={{ flexShrink: 0 }}>{PROCESS_HEADER_ICON}</span>
        {/* 标题整段（时长 + 各计数）是**一个文本流**，段间分隔符统一为流内的字面
            `' · '`，宽度由等宽字体的空格定，于是三段看起来等距。
            早前时长段是独立 flex item、`·` 是又一个独立 flex item，两侧都没有
            空隙（「已工作 22分钟7秒·思考」粘连），而计数之间的 `·` 却来自
            join 的字面空格 —— 同一行两套分隔机制，视觉上忽宽忽窄。 */}
        <span className="process-summary-text">
          {/* 结算态摘要用最浅文本色，避免喧宾夺主（同 ToolLayout 对 kindLabel 的
              处理理由）。流式期时长段不在这里，见上方 durLabel 注释。 */}
          {durLabel && <span style={{ fontWeight: 500 }}>{durLabel}</span>}
          {parts.length > 0 && ` · ${parts.join(' · ')}`}
        </span>
        {/* 收起态 hover 整行才显，展开态常显并转向下（同思考块箭头语义）。 */}
        <span className="process-chevron" data-open={open ? 'true' : 'false'} style={{ flexShrink: 0 }}>
          ▸
        </span>
      </button>
      {open && entries.map((entry) => renderEntry(entry))}
    </div>
  )
}

function ThoughtBlockView({ text, streaming, maxWidth }: { text: string; streaming: boolean; maxWidth?: string }) {
  const { t } = useTranslation()
  const expandThinking = useAppStore(s => s.expandThinking)
  // 收起态档位（仅在 expandThinking 关闭时有语义）：'hide' 只留标题行，
  // 'brief' 在标题行内嵌一行流式思考原文。订阅 store 而不是只读初值——
  // 用户在设置面板改档位时，已挂载的思考块要立即跟着变。
  const collapsedMode = useAppStore(s => s.thinkingCollapsedMode)
  // 初值跟随「展开思考」开关。**不要再叠任何自动折叠条件**：多块消息里思考块
  // 永远不是最后一块，`streaming` 恒为 false，任何「非流式即收起」的判据都会把
  // 思考正文整个吃掉（2026-10-14 实测踩过，见 CHANGELOG 对该条的撤销说明）。
  // 过程块的收纳已由消息级 ProcessBlocks 负责，这里不需要自己再折一次。
  const [open, setOpen] = useState(expandThinking)
  // 耗时（对齐 ZCode）：流式开始计时、结束时定档。历史块从未见过 streaming=true，
  // 保持 undefined，折叠态回落到「持续了几秒」。
  const [durationSec, setDurationSec] = useState<number | undefined>(undefined)
  const startTimeRef = useRef<number | null>(null)
  // 收起态实时思考行的视口 / 文本节点与溢出标记。
  const lineViewportRef = useRef<HTMLSpanElement | null>(null)
  const lineTextRef = useRef<HTMLSpanElement | null>(null)
  const [lineOverflow, setLineOverflow] = useState(false)
  // 内部滚动容器锚定语义与 ChatView 外层一致：默认跟随底部；用户上翻阅读时
  // 解除跟随，滚回底部自动恢复。仅 streaming 块生效——历史块文本不再增长，
  // 展开时应从顶部开始读，不跳底。
  const { containerRef: scrollRef, handleScroll: handleInnerScroll, stickToBottom, resetStick } =
    useStickScroll<HTMLDivElement>()

  // 耗时只在展开态每秒刷新：收起态没必要为了一个暂时不显示的数字每秒重渲染
  // 整块；流式结束那一刻无论展开与否都补算定档。
  useEffect(() => {
    if (!streaming) {
      if (startTimeRef.current !== null) {
        // max(1, ...)：亚秒流式也要显示「1 秒」而不是「0 秒」。
        setDurationSec(Math.max(1, Math.ceil((Date.now() - startTimeRef.current) / 1000)))
      }
      startTimeRef.current = null
      return
    }
    if (startTimeRef.current === null) startTimeRef.current = Date.now()
    if (!open) return
    const tick = () => {
      if (startTimeRef.current === null) return
      setDurationSec(Math.max(1, Math.ceil((Date.now() - startTimeRef.current) / 1000)))
    }
    tick()
    const timer = window.setInterval(tick, THINKING_DURATION_TICK_MS)
    return () => window.clearInterval(timer)
  }, [open, streaming])

  // 流式 thinking 文本增长时把内层容器钉在底部。用 useLayoutEffect：绘制前
  // 钉住，避免溢出瞬间先闪一帧顶部内容。
  useLayoutEffect(() => {
    if (!streaming) return
    stickToBottom()
  }, [text, open, streaming, stickToBottom])

  // 收起态实时思考行：**仅流式期间**显示（对齐 ZCode——完成后折叠态只剩
  // 「思考 · 持续了 N 秒」，不再显示思考原文），且仅 brief 档。内容是一行
  // 未经任何总结的思考原文（最后一个非空行，即正在生长的那一行）。
  const summary =
    streaming && !open && collapsedMode === 'brief' ? resolveThinkingStreamingSummary(text) : null
  // 抽成原始值供 effect 依赖：summary 是每次渲染新建的对象，直接进 deps 会让
  // 每次渲染都重跑；其真值与 text 一一对应，用 text 即可完整表达。
  const summaryText = summary?.text ?? null

  // 单行视口推到末尾：内容增长后旧内容向左移，最新 token 始终可见。早前用
  // text-overflow: ellipsis，会冻结旧前缀、把最新内容裁在右侧，与「正常流式
  // 输出」矛盾。同时按实际溢出决定左缘渐隐遮罩。
  useEffect(() => {
    const viewport = lineViewportRef.current
    if (!viewport || !summaryText) return
    const sync = () => {
      setLineOverflow(viewport.scrollWidth > viewport.clientWidth + 1)
      viewport.scrollLeft = viewport.scrollWidth
    }
    sync()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(sync)
    observer.observe(viewport)
    if (lineTextRef.current) observer.observe(lineTextRef.current)
    return () => observer.disconnect()
  }, [summaryText])

  const toggle = () => {
    const next = !open
    setOpen(next)
    // 折叠会卸载容器、丢失滚动位置；重新展开流式块时恢复跟随态，让用户直接
    // 看到最新内容（历史块 streaming=false 不受影响，仍在顶部）。
    if (next) resetStick()
  }

  // 流式且收起 = 「正在思考」+ 扫光；其余（展开中 / 已完成）=「思考 · 耗时」。
  const streamingLabel = streaming && !open

  return (
    <div data-chat-body="true" className="chat-block" style={{ alignSelf: 'flex-start', maxWidth, fontSize: '0.923em' }}>
      <button
        onClick={toggle}
        className="thinking-header-btn"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-faint)',
          fontSize: '0.846em',
          padding: 0,
          fontFamily: READER_FONT,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          // 单行标题行要能被气泡宽度收口：长实时思考行把视口挤在一行内，
          // 而不是把整行撑破气泡。max-w + min-w-0 让 flex 子项可收缩。
          maxWidth: '100%',
          minWidth: 0,
          opacity: 0.9,
        }}
      >
        <span style={{ flexShrink: 0 }}>◆</span>
        {streamingLabel ? (
          <span className="thinking-shimmer" style={{ flexShrink: 0, whiteSpace: 'nowrap', fontWeight: 500 }}>
            {t('chat.thinking')}
          </span>
        ) : (
          <span style={{ flexShrink: 0, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>{t('chat.thought')}</span>
            <span>·</span>
            <span>
              {durationSec === undefined
                ? t('chat.thoughtDurationFewSeconds')
                : t('chat.thoughtDurationSeconds', { seconds: durationSec })}
            </span>
          </span>
        )}
        {summary && (
          <>
            <span style={{ flexShrink: 0 }}>·</span>
            <span
              ref={lineViewportRef}
              data-thinking-streaming-line="true"
              data-thinking-streaming-mask={lineOverflow ? 'both' : 'none'}
              style={{
                minWidth: 0,
                flex: 1,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                color: 'var(--text-muted)',
                ...(lineOverflow ? THINKING_LINE_MASK_STYLE : null),
              }}
            >
              {/* key = 行首偏移：同一行生长期间不变（不重挂载、不重放动画），
                  换行时改变 → 触发一次纵向滚入。 */}
              <span
                key={summary.key}
                ref={lineTextRef}
                className="thinking-line-roll"
                style={{ display: 'inline-block', minWidth: 'max-content' }}
              >
                {summary.text}
              </span>
            </span>
          </>
        )}
        {/* 单个字形 + CSS 旋转：收起态 hover 才显，展开态常显并转向下。 */}
        <span className="thinking-chevron" data-open={open ? 'true' : 'false'} style={{ flexShrink: 0 }}>
          ▸
        </span>
      </button>
      {!streaming && <BlockCopyButton text={text} />}
      {open && (
        <OverlayScroll
          ref={scrollRef}
          onScroll={handleInnerScroll}
          style={{ marginTop: 4 }}
          contentStyle={{
            flex: '0 0 auto',
            maxHeight: 300,
            padding: '2px 10px',
            borderLeft: '2px solid var(--border-subtle)',
            whiteSpace: 'pre-wrap',
            ...THINKING_TEXT_STYLE,
          }}
        >
          {text}
        </OverlayScroll>
      )}
    </div>
  )
}

function ToolCallBlockView({ block, streaming, maxWidth }: { block: ToolCallBlock; streaming: boolean; maxWidth?: string }) {
  const expandToolCalls = useAppStore(s => s.expandToolCalls)
  const [open, setOpen] = useState(expandToolCalls)
  // 内容预览滚动锚定：与 thinking 块同语义。仅消息 streaming 期间工具内容
  // 可能更新（upsertTool 只作用于 streaming 消息），历史块展开从顶部读不跳底。
  const { containerRef: contentScrollRef, handleScroll: handleContentScroll, stickToBottom, resetStick } =
    useStickScroll<HTMLDivElement>()
  const icon = TOOL_KIND_ICONS[block.kind ?? ''] ?? '◆'
  // 仅在 kind 是「已识别的已知类型」或「非空且非兜底 other」时显示类型标签；
  // 上游若只给模糊的 'other'（未透传真实工具名），则不强行显示误导性的 OTHER，
  // 直接以 title 作为标识（见 §8：不把某实现的模糊字段当事实）。
  const knownKind = block.kind && block.kind !== 'other' ? block.kind : undefined
  const kindLabel = knownKind ? (TOOL_KIND_LABELS[knownKind] ?? knownKind.toUpperCase()) : undefined
  const title = block.title ?? ''
  const statusIcon = block.status === 'completed' ? '✓'
    : block.status === 'failed' ? '✗'
    : block.status === 'running' ? '…'
    : '↻'
  const statusColor = block.status === 'completed' ? 'var(--success)'
    : block.status === 'failed' ? 'var(--danger, #FF7B72)'
    : 'var(--accent)'

  const isDiff = block.content ? looksLikeDiff(block.content) : false
  const hasContent = block.content || (block.locations && block.locations.length > 0)

  // 内容更新时若用户处于底部则保持钉底（useLayoutEffect：绘制前钉住避免闪帧）
  useLayoutEffect(() => {
    if (!streaming) return
    stickToBottom()
  }, [block.content, open, streaming, stickToBottom])

  const toggle = () => {
    const next = !open
    setOpen(next)
    // 折叠会卸载容器、丢失滚动位置；重新展开流式块时恢复跟随态
    if (next) resetStick()
  }

  return (
    <div
      data-chat-body="true"
      className="chat-block"
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        maxWidth,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderLeft: `2px solid ${statusColor}`,
        borderRadius: 0,
        fontSize: '0.923em',
        transition: 'border-color 0.3s ease',
      }}
    >
      <button
        onClick={toggle}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-secondary)',
          fontSize: '0.923em',
          padding: '6px 10px',
          fontFamily: READER_FONT,
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          width: '100%',
          textAlign: 'left',
        }}
      >
        <span>{icon}</span>
        <span
          style={{
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: READER_FONT,
            fontSize: '0.846em',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ color: 'var(--text-secondary)', fontWeight: 600, letterSpacing: '0.04em' }}>{kindLabel}</span>
          {title && <span style={{ color: 'var(--text-faint)' }}>{title}</span>}
          {!kindLabel && !title && <span style={{ color: 'var(--text-faint)' }}>TOOL</span>}
        </span>
        <span style={{ color: statusColor, fontWeight: 700, transition: 'color 0.3s ease' }}>{statusIcon}</span>
        {hasContent && (
          <span style={{ color: 'var(--text-faint)', fontSize: '0.769em' }}>{open ? '▾' : '▸'}</span>
        )}
      </button>
      {/* 块级复制：tool_call 复制 block.content 原文（含 diff），P1 */}
      {!streaming && block.content && <BlockCopyButton text={block.content} />}
      {open && (
        <div style={{ padding: '0 10px 8px 32px' }}>
          {block.locations && block.locations.length > 0 && (
            <div style={{ fontSize: '0.846em', marginBottom: 4 }}>
              {block.locations.map((l) => <FileLocationLink key={l} path={l} />)}
            </div>
          )}
          {block.content && isDiff && <DiffView text={block.content} />}
          {block.content && !isDiff && (
            <OverlayScroll
              ref={contentScrollRef}
              onScroll={handleContentScroll}
              contentStyle={{
                flex: '0 0 auto',
                maxHeight: 200,
                padding: '6px 8px',
                background: 'var(--bg-base)',
                borderRadius: 0,
                fontSize: '0.846em',
                whiteSpace: 'pre-wrap',
                color: 'var(--text-muted)',
                fontFamily: READER_FONT,
              }}
            >
              {block.content}
            </OverlayScroll>
          )}
        </div>
      )}
    </div>
  )
}

function PlanBlockView({ block, maxWidth }: { block: PlanBlock; maxWidth?: string }) {
  return (
    <div
      data-chat-body="true"
      style={{
        alignSelf: 'flex-start',
        maxWidth,
        padding: '6px 10px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 0,
        fontSize: '0.923em',
      }}
    >
      {block.entries.map((entry, i) => {
        const icon = entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '◌' : '○'
        const color = entry.status === 'completed' ? 'var(--success)'
          : entry.status === 'in_progress' ? 'var(--accent)'
          : 'var(--text-faint)'
        return (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline', padding: '1px 0' }}>
            <span style={{ color, fontSize: '0.846em' }}>{icon}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{entry.content}</span>
          </div>
        )
      })}
    </div>
  )
}

function TextBlockView({
  text,
  caret,
  streaming,
  maxWidth,
}: {
  text: string
  caret?: boolean
  streaming?: boolean
  maxWidth?: string
}) {
  return (
    <div
      data-chat-body="true"
      className="chat-block chat-bubble"
      style={{
        alignSelf: 'flex-start',
        maxWidth,
        padding: '8px 12px',
        background: 'var(--bg-surface)',
        color: 'var(--text-primary)',
        fontFamily: READER_FONT,
        fontSize: '1em',
        lineHeight: 1.5,
        wordBreak: 'break-word',
      }}
    >
      <Markdown text={text} streaming={streaming} />
      {caret && <span className="chat-streaming-caret" />}
      {!streaming && <BlockCopyButton text={text} />}
    </div>
  )
}

/** 系统事件标签：label 若命中 i18n key 则翻译（前端自产事件），否则原样展示（后端下发的原始文案）。
 *  detail 存在时（后端权限超时行动）在文案下附结构化详情：请求工具、内容预览、
 *  当时的可选项、自动模式实际选中项——用户回来不错过自己错过了什么。
 *
 *  label 同时承载「turn 非正常结束」（`system.turnFailed.*`，stopReason 未知值的原始值经
 *  `{{reason}}` 插值原样透出，AGENTS.md §8：未知协议值必须可见，不得吞掉）；这类 detail
 *  只有 `{stop_reason}`，与权限超时载荷共用 SystemBlockDetail 类型但不渲染详情区——
 *  详情区按「有权限类信息可展示」门控，否则 turn 失败提示会挂一个空壳子。 */
function SystemBlockView({ label, detail }: { label: string; detail?: SystemBlockDetail }) {
  const { t } = useTranslation()
  // 时长口径统一在 utils/permTimeout.ts（秒制 + 历史 minutes 回退 +「总是」档
  // 换用不带时长的 autoAlways 文案），组件只负责插值。
  const seconds = permTimeoutSeconds(detail)
  const duration = permTimeoutDuration(seconds ?? PERM_TIMEOUT_NEVER_SECS)
  const text = t(permTimeoutNoticeLabel(label, seconds), {
    defaultValue: label,
    duration: duration ? t(duration.key, { value: duration.value }) : '',
    selected: detail?.selected ?? '',
    options: detail?.options?.join(' / ') ?? '',
    count: detail?.extra ?? 0,
    // turn 失败（system.turnFailed.*）：stopReason 未知值经由 {{reason}} 插值原样显示。
    // 其他 label 不引用该参数，多余参数无害。
    reason: detail?.stop_reason ?? '',
  })
  const toolDisplay =
    detail?.tool && detail.kind && detail.tool !== detail.kind
      ? `${detail.tool}（${detail.kind}）`
      : (detail?.tool ?? detail?.kind)
  // 权限超时告知的详情区（工具/内容/选项/省略量）：只有这类载荷才需要展开。
  // `{stop_reason}` 之类的纯终态载荷不渲染，避免空 wrapper。
  const hasPermissionDetail = !!(toolDisplay || detail?.content || detail?.options?.length || detail?.extra)
  return (
    <div style={{ alignSelf: 'flex-start', color: 'var(--text-faint)', fontSize: '0.846em', maxWidth: '100%' }}>
      <span>[{text}]</span>
      {detail && hasPermissionDetail && (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {toolDisplay && (
            <span>
              ▸ {t('system.permTimeout.requestTool', { tool: toolDisplay, defaultValue: '▸ 请求：{{tool}}' })}
            </span>
          )}
          {detail.content && (
            <pre
              style={{
                margin: 0,
                padding: '4px 6px',
                background: 'var(--bg-base)',
                borderRadius: 0,
                fontSize: '0.92em',
                overflow: 'auto',
                maxHeight: 120,
                whiteSpace: 'pre-wrap',
                color: 'var(--text-muted)',
              }}
            >
              {detail.content}
              {!!detail.content_omitted &&
                ` ${t('system.permTimeout.contentOmitted', { count: detail.content_omitted, defaultValue: '…（已省略 {{count}} 字符）' })}`}
            </pre>
          )}
          {!!detail.options?.length && (
            <span>
              {t('system.permTimeout.options', { options: detail.options.join(' / '), defaultValue: '可选项：{{options}}' })}
            </span>
          )}
          {!!detail.extra && (
            <span>
              {t('system.permTimeout.extra', { count: detail.extra, defaultValue: '另有 {{count}} 项审批一并处理' })}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 渲染单个块。`maxWidth` 是调用方给的宽度上限，**不是块自己的属性**：
 *
 * - 平铺在消息行下的块（最终 text 结论、system 块）传 `BUBBLE_MAX_WIDTH`（85% 行宽）；
 * - 收进过程容器的块传 `undefined`——容器自己已经用 `BUBBLE_MAX_WIDTH` 收口，
 *   块再设一次 85% 就成了「85% × 容器宽」的双重收口，比平铺时窄一档
 *   （实测 1006px → 855px，长标题更早出省略号）。容器收口是单一真源。
 *   中间的 text 输出也走这条路（它同样被收进容器）。
 */
function renderBlock(
  block: ContentBlock,
  idx: number,
  isLast: boolean,
  streaming: boolean,
  maxWidth: string | undefined,
) {
  switch (block.type) {
    case 'text':
      return (
        <TextBlockView
          key={idx}
          text={block.text}
          caret={isLast && streaming}
          // 仅正在增长的最后一个 text block 降级纯文本；历史 block 文本引用
          // 稳定，靠 Markdown 的 memo 跳过重渲染。
          streaming={isLast && streaming}
          maxWidth={maxWidth}
        />
      )
    case 'thought':
      return <ThoughtBlockView key={idx} text={block.text} streaming={isLast && streaming} maxWidth={maxWidth} />
    case 'tool_call':
      return <ToolCallBlockView key={idx} block={block} streaming={streaming} maxWidth={maxWidth} />
    case 'plan':
      return <PlanBlockView key={idx} block={block} maxWidth={maxWidth} />
    case 'todo':
      // 看板模式：todo 在输入框上方固定展示，不再内联渲染
      return null
    case 'system':
      return <SystemBlockView key={idx} label={block.label} detail={block.detail} />
    case 'image':
      // 图片块只出现在用户消息（附件），用户气泡有独立渲染路径；assistant 侧忽略。
      return null
  }
}

/**
 * 流式期间的实时工作计时、工具耗时与 tps（气泡底部元信息槽位，定稿后被结算值取代）。
 *
 * 读数来自后端 `turn_stats` 推送（约 1Hz，`utils/turnStats` 缓存；前端只显示不计算
 * ——估算的唯一真相源在后端累积器，见 work-time 计划 E23）。推送到达即重画，**不进
 * React state**：那会让整个消息列表每秒重渲染一次，而这里要的只是三个数字——直写
 * DOM；驱动源是 WS 帧而非本地定时器，隐藏标签页的定时器节流不再影响读数。
 *
 * 靠左对齐（不加 `marginLeft:auto`）——流式期动作栏恒空，左右横跳的观感最差；
 * 定稿后整行才交给右侧的结算值（见渲染处）。
 *
 * **三个读数各自一个禁断行 span**：拆段是 DOM 结构而非文本，一次建好、之后每次
 * 推送只改 textContent，不新增分配。段内禁止断行，数字与单位不分离（换行约束见
 * CHAT_META_TEXT_STYLE：中文无空格，单文本节点会被拆成「5分钟」/「33秒」）。
 * 整行固定单行由所在行的 `min-width:max-content` 托底（见渲染处）。
 *
 * **hover 说明浮层只解释画出来的估算读数**（`visibleReadings` + `liveTip`）：工具耗时与
 * tps 各有「暫无」态（无输出 burst / 工具跟踪失效），两者都缺省时整段不挂——没有需要
 * 解释的数字。文案只有一句「ACP 不提供该数据，由 OmniTerm 计算」（`chat.msg.omniComputed`）：
 * 界面读数刻意不带「约/估算」前缀，性质说明全部收在这一句里（2026-10-16 用户要求
 * 「只要这个意思」，此前两条上百字的 tooltip 太长）。浮层走 `.chat-meta-tip-float`
 * （OmniTerm 风格），不是浏览器原生 `title`。
 *
 * **浮层文本的唯一写入方是 draw()**（不写 JSX prop）：浮层与三个读数段同属直写 DOM 域，
 * deps `[sessionId, t, i18n]` 已覆盖挂载 / 切会话 / 切语言。JSX 里再按
 * `getLiveTurnStats` 求一份就是第二个写入方——那张缓存是有界表（`utils/turnStats`，
 * 淘汰不通知订阅者），本会话项被淘汰后一次父组件重渲染就会把浮层抹成空串，
 * 而三段读数还留着最后一次 draw 的文本。
 */

/** 当前这帧读数里**会显示**的三段（缺省段整段撤掉）。tooltip 与三个数字共用这一次判断。 */
interface VisibleReadings {
  dur: string | null
  toolDur: string | null
  rate: string | null
}

function visibleReadings(stats: LiveTurnStats | null, locale?: string): VisibleReadings {
  const dur = stats ? formatWorkDuration(stats.workMs, locale) : null
  // 工作段本身就没读数（尚无推送 / 已作废）→ 三段全撤，tooltip 也全撤。
  if (!stats || !dur) return { dur: null, toolDur: null, rate: null }
  return {
    dur,
    toolDur: formatToolDuration(stats.toolMs, locale),
    rate: formatTps(stats.tps),
  }
}

/** 当前读数对应的 hover 说明：只有一句「ACP 不提供该数据，由 OmniTerm 计算」，
 *  且只在屏幕上真有估算读数（工具耗时 / tps）时挂——两者都缺省时没有需要解释的数字。 */
function liveTip(readings: VisibleReadings, t: TFunction): string {
  if (!readings.toolDur && !readings.rate) return ''
  return t('chat.msg.omniComputed')
}

/** 浮层与锚点的间隙（px），与动作条 label 浮层同一档。 */
const META_TIP_GAP = 4

/**
 * 把 hover 说明浮层夹进最近滚动容器的可见区（水平方向），mouseenter 时调一次。
 *
 * **为什么需要**：浮层 CSS 默认 `right: 0`（与读数右缘对齐，光标在读数上浮层就在
 * 读数上）。但读数 span 的宽度随气泡伸缩——窄气泡下 `flex-wrap` 可把三段读数拆成
 * 三行、span 只剩几十 px，此时右缘对齐会把 255px 的浮层整个推出消息列左缘，被
 * `overflow-x: clip` 裁掉（实测 x=-167）。故 hover 时实测并夹回容器内。
 *
 * 夹取基准必须是**滚动容器**而非视口：浮层是容器里的 absolute 后代，探出容器可见区
 * 的那一段既被裁掉、又会进容器的 scrollable overflow。可见区右缘取 `容器左缘 +
 * clientWidth`（已排除边框与纵向滚动条槽位）。同 MessageActionBar label 的先例。
 */
function clampMetaTip(holder: HTMLElement) {
  const float = holder.querySelector<HTMLElement>('.chat-meta-tip-float')
  // 没有说明（无估算读数 → display:none）或还没量到宽度时不必夹。
  if (!float || float.style.display === 'none' || float.offsetWidth === 0) return
  const holderRect = holder.getBoundingClientRect()
  const floatW = float.offsetWidth
  // 期望位置：右缘与读数右缘对齐。
  const desired = holderRect.width - floatW
  let container: HTMLElement | null = holder.parentElement
  while (container && container !== document.body) {
    if (/(auto|scroll)/.test(window.getComputedStyle(container).overflowY)) break
    container = container.parentElement
  }
  const cRect = container ? container.getBoundingClientRect() : { left: 0, right: window.innerWidth }
  const visibleRight = container ? cRect.left + container.clientWidth : cRect.right
  const minLeft = cRect.left + META_TIP_GAP - holderRect.left
  const maxLeft = visibleRight - META_TIP_GAP - floatW - holderRect.left
  float.style.left = `${Math.max(minLeft, Math.min(desired, maxLeft))}px`
  float.style.right = 'auto'
}

/** mouseenter 处理器：夹取浮层。定稿行与流式行共用同一份逻辑。 */
function handleMetaTipEnter(e: ReactMouseEvent<HTMLElement>) {
  clampMetaTip(e.currentTarget)
}

function LiveWorkElapsed({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation()
  const rootRef = useRef<HTMLSpanElement>(null)
  const workRef = useRef<HTMLSpanElement>(null)
  const toolRef = useRef<HTMLSpanElement>(null)
  const tpsRef = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    // 写一段：空值整段撤掉（display:none），flex 不留空位、分隔符也跟着消失。
    // 同值不写：display 也参与比较，保证首次调用就把空段显式撤掉（0 宽 flex 项不留痕）。
    const write = (el: HTMLSpanElement | null, text: string) => {
      if (!el) return
      const shown = text ? '' : 'none'
      if (el.textContent === text && el.style.display === shown) return
      el.textContent = text
      el.style.display = shown
    }
    const draw = (stats: LiveTurnStats | null) => {
      const r = visibleReadings(stats, i18n.language)
      if (!r.dur) {
        // 尚无推送 / 已作废：整格撤掉，flex 不留空位。
        write(workRef.current, '')
        write(toolRef.current, '')
        write(tpsRef.current, '')
      } else {
        write(workRef.current, t('chat.msg.working', { dur: r.dur }))
        write(toolRef.current, r.toolDur ? ` · ${t('chat.msg.toolTime', { dur: r.toolDur })}` : '')
        write(tpsRef.current, r.rate ? ` · ${t('chat.msg.tps', { tps: r.rate })}` : '')
      }
      // hover 说明跟着可见段走（推送期直写 DOM，不进 React state）；绝对定位不占布局，
      // display:none 时连 hover 都不触发（`.chat-meta-tip:hover` 只切 opacity）。
      write(tipRef.current, liveTip(r, t))
    }
    draw(getLiveTurnStats(sessionId))
    return subscribeLiveTurnStats(sessionId, draw)
  }, [sessionId, t, i18n])

  // 浮层文本不写 JSX prop——唯一写入方是 effect 里的 draw()（理由见上方 LiveWorkElapsed 注释）。
  return (
    <span
      ref={rootRef}
      className="chat-meta-tip"
      style={{ ...CHAT_META_TEXT_STYLE, color: 'var(--text-muted)' }}
      onMouseEnter={handleMetaTipEnter}
    >
      <span ref={workRef} style={CHAT_META_SEGMENT_STYLE} />
      <span ref={toolRef} style={CHAT_META_SEGMENT_STYLE} />
      <span ref={tpsRef} style={CHAT_META_SEGMENT_STYLE} />
      <span ref={tipRef} className="chat-meta-tip-float pixel-float" style={{ display: 'none' }} />
    </span>
  )
}

export interface ChatMessageViewProps {
  message: ChatMessage
  /** 读取本会话在建 turn 的实时计时（`message.streaming` 期间显示）。缺省时不显示
   *   计时器——结算耗时仍走 `message.durationMs`，与 sessionId 无关。 */
  sessionId?: string
  /** F02: regenerate — re-send the last user prompt (only offered on the last assistant message). */
  onRegenerate?: () => void
  /** D4: 复制正文（toast 文案由 ChatView 注入，本地化文案各异）。 */
  onCopyMessage?: (text: string) => void
  /** D7: 引用到输入框（写入 chatStore.pendingInsert 通道）。 */
  onQuoteMessage?: (text: string) => void
  isLastAssistant?: boolean
  /** agent 气泡显示名（capabilities 帧下发；未连接/已释放时 ChatView 用会话关联的
   *   agents.display_name 兜底）；两者都缺失时回退 "agent"。 */
  agentName?: string
  /** 「上次输入」条跳转聚焦的闪烁态：目标气泡 accent 描边 + ring 动画。
   *   仅目标消息为 true、其余恒 false/缺省，memo 浅比较不受影响。 */
  highlighted?: boolean
}

/**
 * 消息气泡。memo 浅比较：非 streaming 历史消息的 message 引用在每帧流式渲染中
 * 保持稳定（store 只替换在建 streaming 消息），配合 ChatView 稳定的回调引用，
 * 使历史消息在流式期间跳过重渲染。
 */
export const ChatMessageView = memo(function ChatMessageView({ message, sessionId, onRegenerate, onCopyMessage, onQuoteMessage, isLastAssistant, agentName, highlighted }: ChatMessageViewProps) {
  const { t, i18n } = useTranslation()
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  // hover 时在 label 行旁显示时间小字（替代原生 title tooltip，移动端无 hover 不显示）
  const [hovered, setHovered] = useState(false)
  // 移动端长按动作菜单锚点（D3）
  const [actionMenu, setActionMenu] = useState<ActionMenuPosition | null>(null)
  const isMobile = useAppStore((s) => s.isMobile)

  // 组装动作 handlers（D2）：copy/quote/regenerate 由 ChatView 注入稳定回调。
  // 全部 useCallback/稳定引用，不破坏 memo 契约。
  const handlers = useMemo<MessageActionHandlers>(
    () => ({
      copyMessage: onCopyMessage ?? (() => {}),
      quoteMessage: onQuoteMessage ?? (() => {}),
      regenerate: onRegenerate ?? (() => {}),
      // 会话未连接/已结束时 ChatView 不注入 onRegenerate → 动作隐藏
      canRegenerate: !!onRegenerate,
    }),
    [onCopyMessage, onQuoteMessage, onRegenerate],
  )

  const ctx: MessageActionContext = { message, isLastAssistant: !!isLastAssistant, handlers, agentName }
  const visibleActions = messageActions.filter((a) => a.visible(ctx))

  // 长按手势（D3）：绑定消息行，但正文块（data-chat-body）不触发——保留系统
  // 文本选择；只在 label 行/空白区长按弹动作菜单。
  const { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } = useLongPress({
    disabled: !isMobile || visibleActions.length === 0,
    onLongPress: (p, e) => {
      const target = e.target as HTMLElement | null
      if (target?.closest('[data-chat-body]')) return
      hapticTap()
      setActionMenu({
        // Clamp inside viewport: menu width ~140px
        x: Math.min(p.x, window.innerWidth - 148),
        y: p.y,
      })
    },
  })
  const closeActionMenu = useCallback(() => setActionMenu(null), [])

  // hover 时间小字绝对定位：不占布局空间，避免把标识行（右对齐的 USER）挤向左侧。
  // user 消息行右对齐，时间放名字左侧（左侧是空白）；assistant 左对齐，放右侧。
  const timeSide = (isUser ? 'right' : 'left') as 'right' | 'left'

  // turn 工作时长（结算值）：恒由后端在定稿时算出，经 hydrate 或 prompt_done 带回。
  // 流式期间气泡底部另有一路实时读数（后端 `turn_stats` 推送，utils/turnStats 只
  // 缓存显示），定稿瞬间被这里的结算值原位取代。
  // null/undefined（在建消息、迁移前的历史行）→ 结算值不渲染，区别于「确实 0 时长」。
  const workText = formatWorkDuration(message.durationMs, i18n.language)
  // turn 结束时刻（定稿结算，与 `finished_at` 落库同一值，随 prompt_done / hydrate
  // 下发）→ 底部读数**主段**「结束于 14:32」（`formatHoverTime` 智能缩写：今天 →
  // HH:mm，跨天带日期）；原主段「已工作 x分x秒」不再直接显示（替换，用户要求）。
  // 流式期没有该值（定稿才产生），主段换回 LiveWorkElapsed 实时读数（「工作中」）。
  // 缺失（迁移前的历史行）→ 主段不渲染，结算段整段随主段撤（用户拍板：历史数据
  // 不兜底，不回退「已工作」，见 plan E25）。「已工作 x分x秒」保留在收纳行标题里。
  const endText = message.finishedAt
    ? t('chat.msg.endedAt', { time: formatHoverTime(new Date(message.finishedAt).getTime()) })
    : null
  // 「工作中」的显示门控用这个 per-turn 布尔，而非渲染期读时钟：读数随推送变，
  // 但门控只随 streaming 起落一次，三个数字的重画留在订阅回调直写 DOM 的路径上。
  const isLive = !!message.streaming && !!sessionId
  // 流式实时读数（工作/工具/tps）的显示门控。它同时决定元信息行宽托底（`min-width`，
  // 见渲染处）——两者必须同一条件，否则会出现「托了宽却没读数」或反之的错位。
  //
  // **只挂最后一条 assistant**：`turn_stats` 是会话级读数，同一 turn 会被 system
  // 通知 / 工具卡切成多条 streaming 消息（`appendProseToMessages` 只在尾部仍是
  // assistant 时续写），每条都拿到同一份值。若逐条渲染，同一条 turn 会在消息流里
  // 重复出现多行相同的「工作中 12分钟10秒 · 工具 … · … tok/s」（2026-10-18 用户
  // 报告截图）。定稿读数仍按消息各自显示（历史行各属不同 turn，见 E23）。
  const liveSessionId = isLive && !workText && isLastAssistant ? sessionId : undefined
  // 定稿读数（工具耗时 / 估算速率）是**每条消息自己的**后端结算字段：来源与
  // `durationMs` 一致（hydrate 的 `GET /messages` 或 `prompt_done` 帧载荷），
  // 不再是会话级内存快照——历史行各自显示自己那一轮的值，刷新后常驻（E23）。
  // null/undefined（历史行、工具跟踪失效、无可测窗口）→ 不渲染，与工作耗时同一
  // 三态语义（`format*` 收口）。
  const settledTps = formatTps(message.tps)
  const settledToolText = formatToolDuration(message.toolMs, i18n.language)
  // hover 说明：只有一句「ACP 不提供该数据，由 OmniTerm 计算」，且只在屏幕上真有
  // 估算读数（工具耗时 / tps）时挂——没有需要解释的数字就不挂（2026-10-16 用户要求
  // 「只要这个意思」，此前是两条上百字的长 tooltip + 读数复述）。样式走
  // `.chat-meta-tip-float`（OmniTerm 风格浮层），不是浏览器原生 title。
  const settledTip = settledToolText || settledTps ? t('chat.msg.omniComputed') : null
  // 动作栏 + 耗时所在行要贴**气泡右缘**：气泡按内容宽度收缩（上限 BUBBLE_MAX_WIDTH），
  // 而这一行是正文块的兄弟节点，CSS 表达不了「和上面某个块右缘对齐」，只能量。
  const rowRef = useRef<HTMLDivElement>(null)
  const [metaWidth, setMetaWidth] = useState<number>()
  useLayoutEffect(() => {
    const row = rowRef.current
    // 实时计时同样要量宽：不量则 metaWidth 为空 → 该行按内容收缩，读数贴在气泡**左**缘，
    // 定稿换成结算值时才跳回右缘（肉眼可见的一次位移）。
    if (!row || !(endText || liveSessionId)) return
    const bodies = row.querySelectorAll<HTMLElement>('[data-chat-body]')
    const last = bodies[bodies.length - 1]
    if (!last) return
    // 同值不 setState：ResizeObserver 每次 observe 先报一轮，回绕成渲染循环没有尽头。
    const measure = () => setMetaWidth((w) => (w === last.offsetWidth ? w : last.offsetWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(last)
    return () => ro.disconnect()
  }, [endText, liveSessionId, message.blocks])

  const label = (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        fontSize: '0.769em',
        color: 'var(--text-secondary)',
        marginBottom: 2,
        fontFamily: READER_FONT,
        letterSpacing: '0.05em',
        position: 'relative',
      }}
    >
      <span
        style={{
          fontWeight: 600,
        }}
      >
        {isUser ? 'USER' : isSystem ? 'SYSTEM' : (agentName && agentName.length > 0 ? agentName : 'agent')}
      </span>
      {hovered && (
        <span
          style={{
            position: 'absolute',
            top: 0,
            [timeSide]: 'calc(100% + 6px)',
            letterSpacing: '0.03em',
            whiteSpace: 'nowrap',
            color: 'var(--text-faint)',
          }}
        >
          {formatHoverTime(message.createdAt)}
        </span>
      )}
    </div>
  )

  if (isUser) {
    return (
      <div
        className="chat-msg-row"
        data-chat-msg-id={message.id}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', padding: '4px 12px' }}
      >
        {label}
        <div
          // data-chat-body: 长按正文保留系统文本选择，不弹动作菜单（D3）
          data-chat-body="true"
          // 「上次输入」条跳转聚焦：accent 描边 + ring 闪烁动画（index.css）。
          // 与 chat-bubble 并列：聚焦 ring 的 keyframes 已把气泡硬投影写回，
          // 闪烁结束不会抹掉它。
          className={`chat-bubble${highlighted ? ' chat-msg-flash' : ''}`}
          style={{
            padding: '8px 12px',
            maxWidth: BUBBLE_MAX_WIDTH,
            background: message.undelivered ? 'var(--bg-elevated)' : 'var(--accent-14)',
            color: message.undelivered ? 'var(--text-muted)' : 'var(--text-primary)',
            // 默认边框由 .chat-bubble 给（--border-strong），两个特殊态就地覆盖。
            border: message.undelivered
              ? '1px dashed var(--danger, #FF7B72)'
              : highlighted
                ? '1px solid var(--accent)'
                : undefined,
            fontFamily: READER_FONT,
            fontSize: '1em',
            lineHeight: 1.5,
            wordBreak: 'break-word',
            opacity: message.undelivered ? 0.85 : 1,
          }}
        >
          {message.undelivered && (
            <div
              style={{
                fontSize: '0.769em',
                color: 'var(--danger, #FF7B72)',
                letterSpacing: '0.05em',
                marginBottom: 4,
                fontWeight: 600,
              }}
            >
              ⚠ {t('chat.input.message.undelivered')}
            </div>
          )}
          <>

              <CollapsibleUserText text={message.text} />
              {(() => {
                const images = message.blocks.filter((b) => b.type === 'image')
                const files = message.blocks.filter((b) => b.type === 'file')
                if (images.length === 0 && files.length === 0) return null
                return (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: message.text ? 6 : 0 }}>
                    {images.map((img, i) => (
                      <img
                        key={i}
                        src={imageSrc(img)}
                        alt=""
                        style={{
                          maxWidth: 240,
                          maxHeight: 200,
                          borderRadius: 0,
                          border: '1px solid var(--border-subtle)',
                          display: 'block',
                        }}
                      />
                    ))}
                    {/* 文件只落元数据：历史里以文件名 chip 还原「当时发了什么」，内容不可回看 */}
                    {files.map((f, i) => (
                      <span
                        key={i}
                        title={f.name}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          maxWidth: 240,
                          padding: '4px 8px',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: 0,
                          background: 'var(--bg-base)',
                          fontFamily: READER_FONT,
                          fontSize: 12,
                          color: 'var(--text-primary)',
                        }}
                      >
                        <IconFile
                          width={14}
                          height={14}
                          style={{ flexShrink: 0, color: 'var(--text-faint)' }}
                        />
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            minWidth: 0,
                          }}
                        >
                          {f.name}
                        </span>
                        <span style={{ color: 'var(--text-faint)', fontSize: 10, flexShrink: 0 }}>
                          {formatFileSize(f.size)}
                        </span>
                      </span>
                    ))}
                  </div>
                )
              })()}
          </>
        </div>
        <MessageActionBar
          actions={visibleActions}
          ctx={ctx}
          menu={actionMenu}
          onCloseMenu={closeActionMenu}
        />
      </div>
    )
  }

  // Assistant/system: stack distinct blocks (thought / tool card / text bubble)
  // rather than collapsing everything into a single bubble.
  const lastIdx = message.blocks.length - 1
  const showLooseCaret = message.streaming && (lastIdx < 0 || message.blocks[lastIdx].type !== 'text')
  // 最终 text 结论的下标 = **最后一个** text 块。不能取 lastIdx：消息可能以工具
  // 调用收尾；也不能取第一个 text 块：ACP 的 prose chunk 被工具调用切成多个 text
  // 块（`appendProseBlock` 只在**连续同类**时合并），靠前的那些是中间输出。
  let finalTextIdx = -1
  for (let i = 0; i < message.blocks.length; i++) {
    if (message.blocks[i].type === 'text') finalTextIdx = i
  }
  // 归组规则（2026-10-15 用户报告「每个小输出都折叠起来」后改为**整轮一个容器**，
  // 2026-10-16 修流式顺序后拆分点收敛为「结论之前」）：
  // 容器收纳**最终 text 结论之前**的一切——过程块（thought / tool_call / plan）+
  // 夹在过程块之间的中间 text 输出；结论**及其后**的块（含「结论之后又调了工具」
  // 的收尾过程块）留在容器外**原位**渲染。
  // 早先按「连续过程块」切段归组，每段文字之间各攒出一个容器：一轮输出被切成
  // 「文字 + ◈已工作…」交替的许多行（用户截图里同一条消息出现 5 行收纳摘要），
  // 与 ZCode「一轮只一行」的参照正相反。现在是**按轮归组**，容器有且仅有一个。
  // system 块必须留容器外：权限审批要可见可点，不能跟着容器一起被折掉。
  const streaming = message.streaming ?? false
  const bodyNodes: ReactNode[] = []
  const collected: ProcessEntry[] = []
  // 容器在 bodyNodes 里占的位 = **第一个被收纳块**的位置。被收纳集合恒为结论之前
  // 的前缀（system 除外），故容器先于结论渲染；结论及其后的块按原相对顺序留在
  // 外面。旧规则把结论之后的块也收进容器、而容器固定渲染在结论之前，那些块被整体
  // **提前到结论上面**——流式中「最近一次输出之后新起的思考」因此长在输出上方
  // （2026-10-16 用户报告「正在流式输出的思考块出现在最近一次输出的上面」）。
  // 现值下留在外面的段随流式生长始终停在消息末尾，流式顺序在任意时刻成立
  // （规格见 ui-style-guide §7.10）。
  let containerSlot = -1
  for (let i = 0; i < message.blocks.length; i++) {
    const b = message.blocks[i]
    if (b.type === 'system' || (finalTextIdx >= 0 && i >= finalTextIdx)) {
      bodyNodes.push(renderBlock(b, i, i === lastIdx, streaming, BUBBLE_MAX_WIDTH))
      continue
    }
    if (collected.length === 0) {
      bodyNodes.push(null)
      containerSlot = bodyNodes.length - 1
    }
    collected.push({ block: b, idx: i })
  }
  // 有东西可收纳才立容器：纯文字回复（无过程块、无中间输出）不出现收纳行，
  // 行为与加容器前完全一致。
  if (collected.length > 0) {
    bodyNodes[containerSlot] = (
      <ProcessBlocks
        key={`process-${collected[0].idx}`}
        entries={collected}
        streaming={streaming}
        workText={workText}
        renderEntry={(entry) => renderBlock(entry.block, entry.idx, entry.idx === lastIdx, streaming, undefined)}
      />
    )
  }
  return (
    <div
      ref={rowRef}
      className="chat-msg-row"
      data-chat-msg-id={message.id}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        padding: '4px 12px',
        gap: MSG_ROW_GAP,
      }}
    >
      {label}
      {bodyNodes}
      {showLooseCaret && <span className="chat-streaming-caret" style={{ alignSelf: 'flex-start' }} />}
      {/* 动作栏 + turn 耗时（含工具耗时与 tps）同一行。对齐是**状态相关**的，避免流式期左右横跳：
          · 流式期：动作栏恒空（五个动作的 visible 硬排 streaming），实时读数**靠左**；
          · 定稿后：动作栏回归左侧，结算值用 `marginLeft:auto` 顶到**右侧**。
          行宽 = 实测的最后一个正文块宽度（气泡按内容收缩，CSS 表达不了「贴上面
          某个块的右缘」，只能量），故无论耗时是同行还是被 flex-wrap 挤到下一行，
          右缘都与气泡右缘重合。动作栏常驻占位（CSS 只切 opacity）且不被压缩，
          所以放不下的是耗时而不是它 —— 位置不随 hover 跳动。
          **流式期例外（2026-10-14 用户报告「计时和 tps 堆叠成三行」）**：实时读数
          三段全 nowrap，量到的正文块是窄工具卡 / 刚起的文本泡时三段放不下，被
          flex-wrap 拆成一行一段；且正文变宽过程中还会 3→2→1 行重排，观感抖动。
          故流式期整行以 `min-width:max-content` 托到单行内容宽度之上（正文变宽后
          行宽自然跟随，读数不位移）；结算值不加这条，仍按上段规则换行。 */}
      {(endText || liveSessionId || visibleActions.length > 0) && (
        <div
          className="chat-meta-row"
          style={{
            alignSelf: 'flex-start',
            width: metaWidth,
            maxWidth: BUBBLE_MAX_WIDTH,
            // 流式实时读数固定单行：托到单行内容宽度（窄气泡下允许横向超出）。
            ...(liveSessionId ? { minWidth: 'max-content' } : null),
          }}
        >
          <MessageActionBar
            actions={visibleActions}
            ctx={ctx}
            menu={actionMenu}
            onCloseMenu={closeActionMenu}
          />
          {/* 流式期间：后端推送的实时读数（工作/工具计时 + tps，每秒跳动，审批挂起时冻住）。
              整个会话只有最后一条 assistant 拿到 `liveSessionId`——同一 turn 的多条
              streaming 气泡共用一份会话级读数，逐条渲染会重复显示（2026-10-18 用户报告）。
              结算段一旦到位就让位给它——同一槽位、同一规格；定稿瞬间由左挪到右（用户明确要求），
              流式全程停在同一侧，不会来回横跳。 */}
          {liveSessionId && <LiveWorkElapsed sessionId={liveSessionId} />}
          {/* 结算段主段 = 「结束于 14:32」（`endText`）；无结束时刻（迁移前的历史行）
              → 整段不渲染，不回退「已工作」（用户拍板历史数据不兜底）。正文处不再
              显示时长——时长保留在收纳行标题里。
              `CHAT_META_RIGHT` 把结算值顶到行右缘——流式实时读数不加它，停在左侧。 */}
          {endText && (
            <span
              className="chat-meta-tip"
              style={{ ...CHAT_META_TEXT_STYLE, ...CHAT_META_RIGHT, color: 'var(--text-faint)' }}
              onMouseEnter={handleMetaTipEnter}
            >
              {/* 三个读数各一个禁断行段：换行只发生在段间，数字不与单位分离
                  （同 LiveWorkElapsed，见 CHAT_META_SEGMENT_STYLE）。 */}
              <span style={CHAT_META_SEGMENT_STYLE}>{endText}</span>
              {settledToolText && (
                <span style={CHAT_META_SEGMENT_STYLE}>{` · ${t('chat.msg.toolTime', { dur: settledToolText })}`}</span>
              )}
              {settledTps && <span style={CHAT_META_SEGMENT_STYLE}>{` · ${t('chat.msg.tps', { tps: settledTps })}`}</span>}
              {settledTip && <span className="chat-meta-tip-float pixel-float">{settledTip}</span>}
            </span>
          )}
        </div>
      )}
    </div>
  )
})
