import type { ChatMessage } from '../../stores/chatStore'
import { READER_FONT } from '../../utils/fonts'

/**
 * Single chat message bubble. Phase 4 keeps rendering minimal: plain
 * `<pre>` for text (preserves whitespace, no markdown yet), a small
 * kind label for user vs assistant vs system, and a streaming caret
 * while chunks are still arriving.
 *
 * Phase 5 will introduce markdown rendering, tool-call cards, and
 * plan-step checklists — the `updates` array on `ChatMessage` already
 * carries the raw SessionUpdate objects those renderers will consume.
 */
export function ChatMessageView({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  const bubbleStyle: React.CSSProperties = {
    padding: '8px 12px',
    borderRadius: 8,
    maxWidth: '85%',
    background: isUser ? 'var(--accent-14)' : isSystem ? 'var(--bg-elevated)' : 'var(--bg-surface)',
    color: isSystem ? 'var(--text-muted)' : 'var(--text-primary)',
    border: isUser ? '1px solid var(--accent-14)' : '1px solid var(--border-subtle)',
    fontFamily: READER_FONT,
    fontSize: 13,
    lineHeight: 1.5,
    alignSelf: isUser ? 'flex-end' : 'flex-start',
    wordBreak: 'break-word',
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        padding: '4px 12px',
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-faint)',
          marginBottom: 2,
          fontFamily: READER_FONT,
          letterSpacing: '0.05em',
        }}
      >
        {isUser ? 'you' : isSystem ? 'system' : 'agent'}
      </div>
      <div style={bubbleStyle}>
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            fontFamily: 'inherit',
            fontSize: 'inherit',
            lineHeight: 'inherit',
            color: 'inherit',
          }}
        >
          {message.text}
          {message.streaming && <span className="chat-streaming-caret" />}
        </pre>
        {!isUser && !isSystem && message.updates.length > 1 && (
          <div
            style={{
              marginTop: 6,
              fontSize: 10,
              color: 'var(--text-faint)',
              fontFamily: READER_FONT,
            }}
          >
            {message.updates.length} updates
          </div>
        )}
      </div>
    </div>
  )
}
