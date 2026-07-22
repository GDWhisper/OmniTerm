import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useChatStore, selectChatState, type ChatMessage } from '../../stores/chatStore'
import { useAcpConnectionStore } from '../../stores/acpConnectionStore'
import { ChatMessageView } from './ChatMessage'
import { ChatInput } from './ChatInput'
import { PermissionBanner } from './PermissionBanner'
import { ConfigToolbar } from './ConfigToolbar'
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
export function ChatView() {
  const { t } = useTranslation()
  const activeSessionId = useAppStore((s) => s.activeSessionId)
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
  const pixelAnimationsEnabled = useAppStore((s) => s.pixelAnimationsEnabled)
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
          (m: { id: string; role: string; text: string; createdAt: string }) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            text: m.text,
            blocks: [{ type: 'text' as const, text: m.text }],
            createdAt: new Date(m.createdAt).getTime(),
          }),
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

  const handleSend = (text: string) => {
    sendPrompt(text)
    // Re-stick so the user's own message is visible + next chunk scrolls in.
    setAutoStick(true)
  }

  // Shift+Tab 在 ACP 会话窗口内循环切换 mode（category === 'mode' 的 config option）。
  // 仅当焦点落在 ChatView 子树内才触发（React 合成事件冒泡），满足「聚焦在会话窗口」的要求。
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!e.shiftKey || e.key !== 'Tab') return
    const modeOption = chatState.configOptions.find((o) => o.category === 'mode')
    if (!modeOption || modeOption.options.length < 2) return
    e.preventDefault()
    const idx = modeOption.options.findIndex((o) => o.value === modeOption.currentValue)
    const next = modeOption.options[(idx + 1) % modeOption.options.length]
    setConfigOption(modeOption.id, next.value)
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
      onKeyDown={handleKeyDown}
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
        contentStyle={{ display: 'flex', flexDirection: 'column', padding: '8px 0' }}
      >
        {chatState.messages.length === 0 && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-faint)',
              fontSize: 13,
              padding: 16,
            }}
          >
            {t('chat.empty')}
          </div>
        )}
        {chatState.messages.map((m) => (
          <ChatMessageView key={m.id} message={m} />
        ))}
        {chatState.sending && (
          <ThinkingIndicator animate={pixelAnimationsEnabled} label={t('chat.thinking')} />
        )}
        {isReplaying && (
          <div className="chat-replay-indicator">
            <span className="replay-spinner" />
            <span>{t('chat.replaying')}</span>
          </div>
        )}
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

      <ChatInput
        disabled={inputDisabled}
        sending={chatState.sending}
        onSend={handleSend}
        onCancel={cancel}
        commands={chatState.commands}
      />

      <ConfigToolbar
        configOptions={chatState.configOptions}
        usage={chatState.usage}
        onSetConfigOption={setConfigOption}
      />
    </div>
  )
}

/**
 * Terminal-style status line shown at the bottom of the message stream for the
 * whole duration the agent is busy (`sending` === true, i.e. from prompt send
 * until `prompt_done`). Mimics a terminal's live last line so long-running
 * agent tasks (tool calls, waiting, thinking) never leave the view silent.
 * Renders a continuously scrambling hex stream ("decoding" noise, matching the
 * FileManager path-bar look) that never locks into readable text. Falls back to
 * a static label when animations are off.
 */
const SCRAMBLE_HEX = '0123456789abcdef'
const SCRAMBLE_LEN = 16

function ThinkingIndicator({ animate, label }: { animate: boolean; label: string }) {
  // per-slot glyph array → fixed width, no layout jitter from differing glyphs
  const [slots, setSlots] = useState<string[]>(() =>
    Array.from({ length: SCRAMBLE_LEN }, () => SCRAMBLE_HEX[(Math.random() * 16) | 0]),
  )

  useEffect(() => {
    if (!animate) return
    const id = window.setInterval(() => {
      setSlots((prev) =>
        prev.map((_, i) => (i % 3 === 0 ? SCRAMBLE_HEX[(Math.random() * 16) | 0] : prev[i])),
      )
    }, 60)
    return () => window.clearInterval(id)
  }, [animate])

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 12px 6px',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        lineHeight: '20px',
        color: 'var(--text-faint)',
        letterSpacing: '0.08em',
        userSelect: 'none',
      }}
    >
      <span style={{ color: 'var(--accent)', fontWeight: 700 }}>▌</span>
      <span>{animate ? slots.join('') : label}</span>
    </div>
  )
}
