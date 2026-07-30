import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useChatStore, selectChatState, type ChatMessage, type ContentBlock } from '../../stores/chatStore'
import { useAcpConnectionStore } from '../../stores/acpConnectionStore'
import { useChatShortcuts } from '../../hooks/useChatShortcuts'
import { ChatMessageView } from './ChatMessage'
import { ChatInput } from './ChatInput'
import type { ImageAttachment } from '../../utils/imageAttachment'
import { PermissionBanner } from './PermissionBanner'
import { ConfigToolbar } from './ConfigToolbar'
import { TodoBoard } from './TodoBoard'
import { OverlayScroll } from '../Common/OverlayScroll'
import { READER_FONT } from '../../utils/fonts'

/**
 * ChatView — the ACP-runtime counterpart to `Terminal.tsx`. Renders a
 * vertically stacked title bar + message list + input row.
 *
 * Lifecycle:
 *   - Mounts when `activeSessionId` points at a session whose
 *     `runtime_kind === 'acp'` (the Layout dispatcher, see P4-09).
 *   - `useAcpChat` opens the WS and writes into `chatStore`.
 *   - This component reads from `chatStore` and renders.
 *
 * Auto-scroll follows the common chat pattern: stick to the bottom
 * while the user is at the bottom; stop if they scroll up to read
 * history. Re-stick on next explicit send.
 */
// hydrate 时从 DB 还原结构化 blocks；解析失败则回退纯文本，避免单条坏数据
// 让整个会话历史加载失败。
function safeParseBlocks(raw: string): ContentBlock[] | null {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as ContentBlock[]) : null
  } catch {
    return null
  }
}

export function ChatView() {
  const { t } = useTranslation()
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const chatFontSize = useAppStore((s) => s.chatFontSize)
  const sessions = useAppStore((s) => s.sessions)
  const activeSession =
    activeSessionId
      ? Object.values(sessions).flat().find((s) => s.id === activeSessionId)
      : null

  const conn = useAcpConnectionStore((s) =>
    activeSessionId ? s.connections[activeSessionId] : undefined,
  )
  const connectionState = conn?.connectionState ?? 'disconnected'
  const sendPrompt = conn?.sendPrompt ?? (() => {})
  const cancel = conn?.cancel ?? (() => {})
  const restore = conn?.restore ?? (() => {})
  const respondPermission = conn?.respondPermission ?? (() => {})
  const setConfigOption = conn?.setConfigOption ?? (() => {})
  const chatState = useChatStore(selectChatState(activeSessionId))
  const isReplaying = chatState.replaying

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [autoStick, setAutoStick] = useState(true)

  useEffect(() => {
    if (!activeSessionId) return
    let cancelled = false
    fetch(`/api/v1/sessions/${encodeURIComponent(activeSessionId)}/messages`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.messages?.length) return
        const msgs: ChatMessage[] = data.messages.map(
          (m: { id: string; role: string; text: string; createdAt: string; blocks?: string | null }) => {
            let blocks = m.blocks ? safeParseBlocks(m.blocks) : null
            if (!blocks || blocks.length === 0) {
              blocks = [{ type: 'text' as const, text: m.text }]
            }
            return {
              id: m.id,
              role: m.role as 'user' | 'assistant',
              text: m.text,
              blocks,
              createdAt: new Date(m.createdAt).getTime(),
            }
          },
        )
        useChatStore.getState().hydrate(activeSessionId, msgs)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeSessionId])

  // Re-stick whenever a new chunk/message lands while autoStick is on.
  useEffect(() => {
    if (!autoStick) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [chatState.messages, autoStick])

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    setAutoStick(atBottom)
  }

  // ACP 会话窗口键盘快捷键集中管理（Shift+Tab 切换 mode 等）。
  // 必须置于所有提前 return 之前，遵守 React Hooks 调用顺序规则。
  const onKeyDown = useChatShortcuts({
    configOptions: chatState.configOptions,
    setConfigOption,
  })

  // No session: empty-state placeholder matching Terminal.tsx's look.
  if (!activeSession) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-base)',
          color: 'var(--text-faint)',
          fontFamily: READER_FONT,
        }}
      >
        <div className="panel-title-bar">
          <span>◆</span>
          <span>chat</span>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
            {t('chat.noSession')}
          </div>
        </div>
      </div>
    )
  }

  const handleSend = (text: string, images?: ImageAttachment[]) => {
    // busy 时不直接发送，而是排队：agent 跑完这一轮 (prompt_done) 后 useAcpChat 自动 drain。
    // 详见 docs/adr/0001-acp-queue-drain-location.md。N=1 约束：队列满时 ChatInput
    // 里的 Queue 按钮已 disabled，这里是 belt-and-suspenders 兜底（理论上进入这里的
    // 路径只走 idle 态；busy 走 enqueue 路径不调用 handleSend）。
    // 附件仅支持 idle 直发（队列槽是纯 string），busy 入队时丢弃 images 是预期行为
    // ——ChatInput 已在带附件时禁用 Queue，此路径不会带 images 进入。
    if (chatState.sending) {
      useChatStore.getState().enqueueMessage(activeSessionId!, text)
      return
    }
    sendPrompt(text, images)
    // Re-stick so the user's own message is visible + next chunk scrolls in.
    setAutoStick(true)
  }

  const handleCancelQueued = () => {
    if (!activeSessionId) return
    useChatStore.getState().clearQueuedMessage(activeSessionId)
  }

  // Send Now on queued chip: 调 cancel() 打断当前 in-flight prompt。
  // 不需要手动调 sendPrompt——现有 useAcpChat 的 prompt_done 分支已经有 drain
  // 逻辑（加 queuedMessage → 调 sendPrompt），cancelled prompt 结束时 drain 自动
  // 触发，队列里的消息随后发出。选这个路径避免 cancel+sendPrompt 的 race condition
  // （旧 prompt_done 在新 in-flight 期间到达会把 sending 拉成 false，造成 UI 闪烁）。
  const handleSendNowQueued = () => {
    cancel()
  }

  // F02 编辑重发：原消息标 edited，编辑稿作为全新 prompt 走 handleSend
  // （sending 时自动进 N=1 队列，无需特判）。ACP 无编辑历史语义，见计划 §3.2。
  const handleEditResend = (messageId: string, newText: string) => {
    if (!activeSessionId) return
    useChatStore.getState().markEdited(activeSessionId, messageId)
    handleSend(newText)
  }

  // F02 重新生成：取最后一条用户消息重发，assistant 回复追加不替换。
  // sending 时走 enqueue+cancel（同 Send Now 的 drain 路径，天然规避与队列的竞态）。
  const handleRegenerate = () => {
    if (!activeSessionId) return
    const lastUser = [...chatState.messages].reverse().find((m) => m.role === 'user' && !m.undelivered)
    if (!lastUser) return
    if (chatState.sending) {
      useChatStore.getState().enqueueMessage(activeSessionId, lastUser.text)
      cancel()
      return
    }
    sendPrompt(lastUser.text)
    setAutoStick(true)
  }

  // 进程已被释放（手动 release / reaper 自动回收 / 后端重启）且未重新连接时，
  // 也应展示「恢复会话」按钮。acp_process_alive 由 Sidebar 的会话列表轮询刷新，
  // 因而释放后能即时（最多一个轮询周期）反映到 UI，无需刷新页面。
  const released =
    activeSession?.runtime_kind === 'acp' && activeSession?.acp_process_alive === false
  const showRestore = chatState.sessionEnded || released

  const titleChip = (() => {
    if (chatState.sessionEnded) {
      return <span className="title-bar-badge badge-danger">● DEAD</span>
    }
    if (released) {
      return <span className="title-bar-badge badge-danger">● DEAD</span>
    }
    switch (connectionState) {
      case 'connecting':
        return <span className="title-bar-badge">● LINK</span>
      case 'connected':
        return <span className="title-bar-badge">● LIVE</span>
      case 'error':
        return <span className="title-bar-badge">● FAIL</span>
      case 'disconnected':
      default:
        return <span className="title-bar-badge">● OFF</span>
    }
  })()

  const inputDisabled = chatState.sessionEnded || connectionState !== 'connected'

  return (
    <div
      onKeyDown={onKeyDown}
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-base)',
        fontFamily: READER_FONT,
      }}
    >
      <div className="panel-title-bar">
        <span>◆</span>
        <span>chat</span>
        {chatState.mode && (
          <span
            style={{
              marginLeft: 8,
              padding: '1px 8px',
              fontSize: 10,
              background: 'var(--accent-14)',
              color: 'var(--accent)',
              borderRadius: 4,
              letterSpacing: '0.08em',
            }}
          >
            {chatState.mode.toUpperCase()}
          </span>
        )}
        <span className="title-bar-spacer" />
        {titleChip}
      </div>

      <div className="terminal-panel-pixel" style={{ flex: 1, minHeight: 0, background: 'var(--bg-base)' }}>

      {chatState.error && (
        <div
          style={{
            padding: '6px 12px',
            background: 'rgba(255, 123, 114, 0.12)',
            color: 'var(--danger, #FF7B72)',
            fontSize: 12,
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          {chatState.error}
        </div>
      )}

      <OverlayScroll
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, minHeight: 0 }}
        contentStyle={{ display: 'flex', flexDirection: 'column', padding: '8px 0', fontSize: chatFontSize }}
      >
        {chatState.messages.length === 0 && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-faint)',
              fontSize: '1em',
              padding: 16,
            }}
          >
            {t('chat.empty')}
          </div>
        )}
        {(() => {
          const lastAssistantId = [...chatState.messages].reverse().find((m) => m.role === 'assistant')?.id
          return chatState.messages.map((m) => (
            <ChatMessageView
              key={m.id}
              message={m}
              onEditResend={inputDisabled ? undefined : handleEditResend}
              onRegenerate={inputDisabled || chatState.sending ? undefined : handleRegenerate}
              isLastAssistant={m.id === lastAssistantId}
            />
          ))
        })()}
        {chatState.sending && <ThinkingIndicator />}
        {isReplaying && (
          <div className="chat-replay-indicator">
            <span className="replay-spinner" />
            <span>{t('chat.replaying')}</span>
          </div>
        )}
        {chatState.terminalEvents.map((ev) => (
          <div
            key={ev.id}
            style={{
              margin: '2px 12px',
              padding: '4px 10px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: '0.923em',
              fontFamily: 'var(--reader-font, monospace)',
              background: 'rgba(255, 255, 255, 0.03)',
              border: '1px solid var(--border-subtle)',
              borderLeft: '2px solid var(--accent)',
              borderRadius: 4,
              color: 'var(--text-muted)',
            }}
          >
            <span style={{ color: 'var(--accent)' }}>▸</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ev.command} {ev.args.join(' ')}
            </span>
            <span
              style={{
                flexShrink: 0,
                color:
                  ev.status === 'exited'
                    ? ev.exit_code === 0
                      ? 'var(--success, #3fb950)'
                      : 'var(--danger, #FF7B72)'
                    : 'var(--text-faint)',
              }}
            >
              {ev.status === 'exited'
                ? `exit ${ev.exit_code ?? '?'}`
                : 'running…'}
            </span>
          </div>
        ))}
      </OverlayScroll>

      {chatState.pendingPermission && (
        <PermissionBanner
          permission={chatState.pendingPermission}
          onRespond={respondPermission}
        />
      )}

      {showRestore && (
        <div
          style={{
            padding: '6px 12px',
            background: 'rgba(255, 255, 255, 0.04)',
            color: 'var(--text-muted)',
            fontSize: 12,
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>{t('chat.session.ended')}</span>
          <button
            onClick={restore}
            disabled={connectionState !== 'connected'}
            style={{
              marginLeft: 'auto',
              padding: '2px 10px',
              fontSize: 11,
              borderRadius: 4,
              border: '1px solid var(--border-subtle)',
              background: 'var(--accent-14)',
              color: 'var(--accent)',
              cursor: connectionState === 'connected' ? 'pointer' : 'not-allowed',
              opacity: connectionState === 'connected' ? 1 : 0.5,
            }}
          >
            {t('chat.session.restore')}
          </button>
        </div>
      )}

      <TodoBoard entries={chatState.todos} title={chatState.todosTitle} />

      <ChatInput
        key={activeSessionId}
        sessionId={activeSessionId!}
        disabled={inputDisabled}
        sending={chatState.sending}
        queuedMessage={chatState.queuedMessage}
        onSend={handleSend}
        onCancel={cancel}
        onCancelQueued={handleCancelQueued}
        onSendNow={handleSendNowQueued}
        commands={chatState.commands}
        imageSupported={chatState.imageSupported}
      />

      <ConfigToolbar
        configOptions={chatState.configOptions}
        usage={chatState.usage}
        onSetConfigOption={setConfigOption}
      />

      </div>
    </div>
  )
}

/**
 * Terminal-style status line shown at the bottom of the message stream for the
 * whole duration the agent is busy (`sending` === true, i.e. from prompt send
 * until `prompt_done`). Mimics a terminal's live last line so long-running
 * agent tasks (tool calls, waiting, thinking) never leave the view silent.
 * Renders a continuously scrambling hex stream ("decoding" noise, matching the
 * FileManager path-bar look) that never locks into readable text.
 *
 * 该动画属于状态指示器本身，与「像素动效」（马里奥弹跳/金币等游戏化特效）
 * 无关——不应被那个默认关闭的开关抑制，故恒为动画。
 */
const SCRAMBLE_HEX = '0123456789abcdef'
const SCRAMBLE_LEN = 16

function ThinkingIndicator() {
  const textRef = useRef<HTMLSpanElement | null>(null)
  const startTimeRef = useRef(0)

  useEffect(() => {
    startTimeRef.current = Date.now()
    let raf = 0
    const tick = () => {
      // 直接写 DOM，不进 React state：避免 thinking 阶段高频 appendThought
      // 重渲染挤占本动画的帧（setInterval 宏任务会被密集渲染推迟）。rAF 与
      // 渲染同调度，且本函数零 React 开销，主线程再忙也只占一帧极小成本。
      if (textRef.current) {
        const elapsed = (Date.now() - startTimeRef.current) / 1000
        const len = elapsed < 3 ? SCRAMBLE_LEN
          : elapsed < 10 ? 24
          : elapsed < 30 ? 36
          : 54
        let s = ''
        for (let i = 0; i < len; i++) s += SCRAMBLE_HEX[(Math.random() * 16) | 0]
        textRef.current.textContent = s
      }
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 12px 6px',
        fontFamily: 'var(--pixel-font-static)',
        fontSize: '0.923em',
        lineHeight: '20px',
        color: 'var(--text-faint)',
        letterSpacing: 'var(--pixel-tracking-sm)',
        userSelect: 'none',
      }}
    >
      <span style={{ color: 'var(--accent)', fontWeight: 700 }}>▌</span>
      <span ref={textRef} style={{ fontFamily: READER_FONT, letterSpacing: 0 }} />
    </div>
  )
}
