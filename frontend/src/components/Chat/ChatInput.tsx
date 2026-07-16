import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { READER_FONT } from '../../utils/fonts'

interface ChatInputProps {
  disabled: boolean
  onSend: (text: string) => void
  onCancel: () => void
  sending: boolean
}

/**
 * Chat input row: textarea + send/cancel controls.
 *
 * - Enter submits; Shift+Enter inserts a newline.
 * - Auto-grows up to 6 lines, then scrolls internally.
 * - Disabled while `sending` is true (waiting for prompt_done) — Phase 4
 *   enforces one in-flight prompt at a time. Phase 5 may allow queueing.
 */
export function ChatInput({ disabled, onSend, onCancel, sending }: ChatInputProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  // Autofocus the textarea when the component mounts so the user can
  // start typing immediately after creating an ACP session.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Auto-grow the textarea to fit its content (up to 6 lines).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = 18
    const maxHeight = lineHeight * 6
    const next = Math.min(maxHeight, el.scrollHeight)
    el.style.height = `${next}px`
  }, [text])

  const canSend = !disabled && !sending && text.trim().length > 0

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) {
        onSend(text)
        setText('')
      }
    }
  }

  const handleClickSend = () => {
    if (!canSend) return
    onSend(text)
    setText('')
    textareaRef.current?.focus()
  }

  const inputStyle: React.CSSProperties = {
    flex: 1,
    resize: 'none',
    background: 'var(--bg-elevated)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-subtle)',
    borderRadius: 8,
    padding: '8px 10px',
    fontFamily: READER_FONT,
    fontSize: 13,
    lineHeight: '18px',
    outline: 'none',
    overflowY: 'auto',
    minHeight: 36,
  }

  const buttonBase: React.CSSProperties = {
    border: 'none',
    borderRadius: 6,
    padding: '6px 12px',
    fontFamily: READER_FONT,
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    letterSpacing: '0.04em',
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '8px 12px',
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-base)',
        alignItems: 'flex-end',
      }}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('chat.input.placeholder')}
        disabled={disabled || sending}
        rows={1}
        style={{
          ...inputStyle,
          opacity: disabled || sending ? 0.6 : 1,
        }}
      />
      {sending ? (
        <button
          onClick={onCancel}
          style={{
            ...buttonBase,
            background: 'var(--danger, #FF7B72)',
            color: '#fff',
          }}
        >
          {t('chat.input.cancel')}
        </button>
      ) : (
        <button
          onClick={handleClickSend}
          disabled={!canSend}
          style={{
            ...buttonBase,
            background: canSend ? 'var(--accent)' : 'var(--bg-elevated)',
            color: canSend ? '#fff' : 'var(--text-faint)',
            cursor: canSend ? 'pointer' : 'not-allowed',
          }}
        >
          {t('chat.input.send')}
        </button>
      )}
    </div>
  )
}
