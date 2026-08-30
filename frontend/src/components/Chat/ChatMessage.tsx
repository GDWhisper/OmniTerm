import { memo, useLayoutEffect, useMemo, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatMessage, ContentBlock, ToolCallBlock, PlanBlock } from '../../stores/chatStore'
import { useAppStore } from '../../stores/appStore'
import { useStickScroll } from '../../hooks/useStickScroll'
import { useLongPress } from '../../hooks/useLongPress'
import { OverlayScroll } from '../Common/OverlayScroll'
import { Markdown } from './Markdown'
import { READER_FONT } from '../../utils/fonts'
import { formatHoverTime, formatWorkDuration } from '../../utils/formatTime'
import { looksLikeDiff } from '../../utils/diff'
import { DiffView } from './DiffView'
import { FileLocationLink } from './FileLocationLink'
import { messageActions, type MessageActionHandlers, type MessageActionContext } from './messageActions'
import { MessageActionBar, type ActionMenuPosition } from './MessageActionBar'
import { hapticTap } from '../../utils/haptics'
import { copyText } from '../../utils/clipboard'
import { useToastStore } from '../../stores/toastStore'
import { IconCopy } from '../FileManager/icons'

// 用户输入（已发送）正文超过此行数时默认折叠，提供展开/收起。
const USER_TEXT_COLLAPSE_LINES = 8
// 折叠态下展示的最大行数（其余内容隐藏，点击展开后全量显示）。
const USER_TEXT_PREVIEW_LINES = 8

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

function ThoughtBlockView({ text, streaming }: { text: string; streaming: boolean }) {
  const expandThinking = useAppStore(s => s.expandThinking)
  const [open, setOpen] = useState(expandThinking)
  // 内部滚动容器锚定语义与 ChatView 外层一致：默认跟随底部；用户上翻阅读时
  // 解除跟随，滚回底部自动恢复。仅 streaming 块生效——历史块文本不再增长，
  // 展开时应从顶部开始读，不跳底。
  const { containerRef: scrollRef, handleScroll: handleInnerScroll, stickToBottom, resetStick } =
    useStickScroll<HTMLDivElement>()

  // 流式 thinking 文本增长时把内层容器钉在底部。用 useLayoutEffect：绘制前
  // 钉住，避免溢出瞬间先闪一帧顶部内容。
  useLayoutEffect(() => {
    if (!streaming) return
    stickToBottom()
  }, [text, open, streaming, stickToBottom])

  const toggle = () => {
    const next = !open
    setOpen(next)
    // 折叠会卸载容器、丢失滚动位置；重新展开流式块时恢复跟随态，让用户直接
    // 看到最新内容（历史块 streaming=false 不受影响，仍在顶部）。
    if (next) resetStick()
  }

  return (
    <div data-chat-body="true" className="chat-block" style={{ alignSelf: 'flex-start', maxWidth: '85%', fontSize: '0.923em' }}>
      <button
        onClick={toggle}
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
          fontStyle: 'italic',
          opacity: 0.9,
        }}
      >
        <span style={{ fontStyle: 'normal' }}>◆</span>
        {open ? '▾' : '▸'} thinking
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
            fontSize: '0.923em',
            lineHeight: 1.5,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
            whiteSpace: 'pre-wrap',
          }}
        >
          {text}
        </OverlayScroll>
      )}
    </div>
  )
}

function ToolCallBlockView({ block, streaming }: { block: ToolCallBlock; streaming: boolean }) {
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
        maxWidth: '85%',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderLeft: `2px solid ${statusColor}`,
        borderRadius: 6,
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
                borderRadius: 4,
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

function PlanBlockView({ block }: { block: PlanBlock }) {
  return (
    <div
      data-chat-body="true"
      style={{
        alignSelf: 'flex-start',
        maxWidth: '85%',
        padding: '6px 10px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 6,
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

function TextBlockView({ text, caret, streaming }: { text: string; caret?: boolean; streaming?: boolean }) {
  return (
    <div
      data-chat-body="true"
      className="chat-block"
      style={{
        alignSelf: 'flex-start',
        maxWidth: '85%',
        padding: '8px 12px',
        borderRadius: 8,
        background: 'var(--bg-surface)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-subtle)',
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

/** 系统事件标签：label 若命中 i18n key 则翻译（前端自产事件），否则原样展示（后端下发的原始文案）。 */
function SystemBlockView({ label }: { label: string }) {
  const { t } = useTranslation()
  return (
    <span style={{ alignSelf: 'flex-start', color: 'var(--text-faint)', fontSize: '0.846em' }}>
      [{t(label, { defaultValue: label })}]
    </span>
  )
}

function renderBlock(block: ContentBlock, idx: number, isLast: boolean, streaming: boolean) {
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
        />
      )
    case 'thought':
      return <ThoughtBlockView key={idx} text={block.text} streaming={isLast && streaming} />
    case 'tool_call':
      return <ToolCallBlockView key={idx} block={block} streaming={streaming} />
    case 'plan':
      return <PlanBlockView key={idx} block={block} />
    case 'todo':
      // 看板模式：todo 在输入框上方固定展示，不再内联渲染
      return null
    case 'system':
      return <SystemBlockView key={idx} label={block.label} />
    case 'image':
      // 图片块只出现在用户消息（附件），用户气泡有独立渲染路径；assistant 侧忽略。
      return null
  }
}

export interface ChatMessageViewProps {
  message: ChatMessage
  /** F02: resend an edited copy of this user message as a new prompt. */
  onEditResend?: (messageId: string, newText: string) => void
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
}

/**
 * 消息气泡。memo 浅比较：非 streaming 历史消息的 message 引用在每帧流式渲染中
 * 保持稳定（store 只替换在建 streaming 消息），配合 ChatView 稳定的回调引用，
 * 使历史消息在流式期间跳过重渲染。
 */
export const ChatMessageView = memo(function ChatMessageView({ message, onEditResend, onRegenerate, onCopyMessage, onQuoteMessage, isLastAssistant, agentName }: ChatMessageViewProps) {
  const { t, i18n } = useTranslation()
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // hover 时在 label 行旁显示时间小字（替代原生 title tooltip，移动端无 hover 不显示）
  const [hovered, setHovered] = useState(false)
  // 移动端长按动作菜单锚点（D3）
  const [actionMenu, setActionMenu] = useState<ActionMenuPosition | null>(null)
  const isMobile = useAppStore((s) => s.isMobile)

  // 组装动作 handlers（D2）：copy/quote/regenerate 由 ChatView 注入稳定回调，
  // startEdit 是组件内部编辑态入口。全部 useCallback/稳定引用，不破坏 memo 契约。
  const startEdit = useCallback(() => {
    setDraft(message.text)
    setEditing(true)
  }, [message.text])

  const handlers = useMemo<MessageActionHandlers>(
    () => ({
      copyMessage: onCopyMessage ?? (() => {}),
      quoteMessage: onQuoteMessage ?? (() => {}),
      startEdit,
      regenerate: onRegenerate ?? (() => {}),
      // 会话未连接/已结束时 ChatView 不注入这些回调 → 对应动作隐藏
      canEdit: !!onEditResend,
      canRegenerate: !!onRegenerate,
    }),
    [onCopyMessage, onQuoteMessage, startEdit, onRegenerate, onEditResend],
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

  // turn 工作时长：后端在 turn 定稿时结算，只有 hydrate（读 DB）路径才带回来 ——
  // 前端不自算实时计时，否则与含审批扣除的后端口径形成第二套真相。
  // null/undefined（在建消息、迁移前的历史行）→ 整行不渲染，区别于「确实 0 时长」。
  const workText = formatWorkDuration(message.durationMs, i18n.language)
  // 「等待人工」不进正文（会让元信息占两行），只挂在 tooltip 上；移动端无 hover
  // 拿不到，按设计确认放弃该信息于移动端呈现。
  const waitText = message.waitMs ? formatWorkDuration(message.waitMs, i18n.language) : null
  const durationTip = [
    workText && t('chat.msg.workTime', { dur: workText }),
    waitText && t('chat.msg.waitTime', { dur: waitText }),
  ].filter(Boolean).join(' · ')

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
      {isUser && message.edited && (
        <span style={{ marginLeft: 6, fontStyle: 'italic' }}>({t('chat.msg.edited')})</span>
      )}
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

  const submitEdit = () => {
    const trimmed = draft.trim()
    if (!trimmed || !onEditResend) return
    setEditing(false)
    onEditResend(message.id, trimmed)
  }

  if (isUser) {
    return (
      <div
        className="chat-msg-row"
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
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            maxWidth: '85%',
            minWidth: editing ? '60%' : undefined,
            background: message.undelivered ? 'var(--bg-elevated)' : 'var(--accent-14)',
            color: message.undelivered ? 'var(--text-muted)' : 'var(--text-primary)',
            border: message.undelivered
              ? '1px dashed var(--danger, #FF7B72)'
              : '1px solid var(--accent-14)',
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
          {editing ? (
            <textarea
              className="overlay-scroll-content"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submitEdit()
                } else if (e.key === 'Escape') {
                  setEditing(false)
                }
              }}
              autoFocus
              rows={Math.min(6, Math.max(2, draft.split('\n').length))}
              style={{
                width: '100%',
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 4,
                color: 'var(--text-primary)',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                lineHeight: 'inherit',
                padding: '4px 6px',
                resize: 'vertical',
                outline: 'none',
              }}
            />
          ) : (
            <>
              <CollapsibleUserText text={message.text} />
              {(() => {
                const images = message.blocks.filter((b) => b.type === 'image')
                if (images.length === 0) return null
                return (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: message.text ? 6 : 0 }}>
                    {images.map((img, i) => (
                      <img
                        key={i}
                        src={`data:${img.mimeType};base64,${img.data}`}
                        alt=""
                        style={{
                          maxWidth: 240,
                          maxHeight: 200,
                          borderRadius: 4,
                          border: '1px solid var(--border-subtle)',
                          display: 'block',
                        }}
                      />
                    ))}
                  </div>
                )
              })()}
            </>
          )}
        </div>
        {editing ? (
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="chat-msg-action-btn" style={{ color: 'var(--accent)' }} onClick={submitEdit}>
              ⏎ {t('chat.msg.editSend')}
            </button>
            <button className="chat-msg-action-btn" onClick={() => setEditing(false)}>
              ✕ {t('chat.msg.editCancel')}
            </button>
          </div>
        ) : (
          <MessageActionBar
            actions={visibleActions}
            ctx={ctx}
            menu={actionMenu}
            onCloseMenu={closeActionMenu}
          />
        )}
      </div>
    )
  }

  // Assistant/system: stack distinct blocks (thought / tool card / text bubble)
  // rather than collapsing everything into a single bubble.
  const lastIdx = message.blocks.length - 1
  const showLooseCaret = message.streaming && (lastIdx < 0 || message.blocks[lastIdx].type !== 'text')
  return (
    <div
      className="chat-msg-row"
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
        gap: 6,
      }}
    >
      {label}
      {message.blocks.map((b, i) => renderBlock(b, i, i === lastIdx, message.streaming ?? false))}
      {showLooseCaret && <span className="chat-streaming-caret" style={{ alignSelf: 'flex-start' }} />}
      <MessageActionBar
        actions={visibleActions}
        ctx={ctx}
        menu={actionMenu}
        onCloseMenu={closeActionMenu}
      />
      {/* turn 工作时长：正文最后一行，右对齐（与左对齐的正文块拉开层级，避免被
          读成正文的一部分）。动作栏常驻占位（CSS 只切 opacity），故本行位置稳定。 */}
      {workText && (
        <div
          style={{
            alignSelf: 'flex-end',
            fontSize: '0.769em',
            color: 'var(--text-faint)',
            fontFamily: READER_FONT,
            letterSpacing: '0.03em',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
          title={durationTip}
        >
          {t('chat.msg.workTime', { dur: workText })}
        </div>
      )}
    </div>
  )
})
