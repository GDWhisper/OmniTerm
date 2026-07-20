import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useChatStore, selectChatState, type ChatMessage } from '../../stores/chatStore'
import { useAcpConnectionStore } from '../../stores/acpConnectionStore'
import { ChatMessageView } from './ChatMessage'
import { ChatInput } from './ChatInput'
import { PermissionBanner } from './PermissionBanner'
import { ConfigToolbar } from './ConfigToolbar'
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

  const titleChip = (() => {
    if (chatState.sessionEnded) {
      return <span style={{ color: 'var(--text-faint)' }}>{t('chat.status.ended')}</span>
    }
    switch (connectionState) {
      case 'connecting':
        return <span style={{ color: 'var(--text-faint)' }}>{t('chat.status.connecting')}</span>
      case 'connected':
        return <span style={{ color: 'var(--success)' }}>● LIVE</span>
      case 'error':
        return <span style={{ color: 'var(--danger, #FF7B72)' }}>{t('chat.status.error')}</span>
      case 'disconnected':
      default:
        return <span style={{ color: 'var(--text-faint)' }}>{t('chat.status.disconnected')}</span>
    }
  })()

  const inputDisabled = chatState.sessionEnded || connectionState !== 'connected'

  return (
    <div
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

      {chatState.sessionEnded && (
        <div
          style={{
            padding: '6px 12px',
            background: 'rgba(255, 255, 255, 0.04)',
            color: 'var(--text-muted)',
            fontSize: 12,
            borderBottom: '1px solid var(--border-subtle)',
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

      <ConfigToolbar
        configOptions={chatState.configOptions}
        usage={chatState.usage}
        onSetConfigOption={setConfigOption}
      />

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          padding: '8px 0',
        }}
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
      </div>

      {chatState.pendingPermission && (
        <PermissionBanner
          permission={chatState.pendingPermission}
          onRespond={respondPermission}
        />
      )}

      <ChatInput
        disabled={inputDisabled}
        sending={chatState.sending}
        onSend={handleSend}
        onCancel={cancel}
        commands={chatState.commands}
      />
    </div>
  )
}
