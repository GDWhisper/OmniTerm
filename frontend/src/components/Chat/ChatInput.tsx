import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { READER_FONT } from '../../utils/fonts'

interface ChatInputProps {
  disabled: boolean
  onSend: (text: string) => void
  onCancel: () => void
  sending: boolean
  commands?: string[]
}

export function ChatInput({ disabled, onSend, onCancel, sending, commands = [] }: ChatInputProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [showCommands, setShowCommands] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const lineHeight = 18
    const maxHeight = lineHeight * 6
    const next = Math.min(maxHeight, el.scrollHeight)
    el.style.height = `${next}px`
  }, [text])

  const filteredCommands = text.startsWith('/')
    ? commands.filter((c) => c.toLowerCase().startsWith(text.toLowerCase()))
    : []

  useEffect(() => {
    setShowCommands(filteredCommands.length > 0 && text.startsWith('/') && !text.includes(' '))
  }, [text, commands])

  const canSend = !disabled && !sending && text.trim().length > 0

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && showCommands) {
      setShowCommands(false)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) {
        onSend(text)
        setText('')
        setShowCommands(false)
      }
    }
  }

  const selectCommand = (cmd: string) => {
    setText(cmd + ' ')
    setShowCommands(false)
    textareaRef.current?.focus()
  }

  const handleClickSend = () => {
    if (!canSend) return
    onSend(text)
    setText('')
    setShowCommands(false)
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
        position: 'relative',
      }}
    >
      {showCommands && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 12,
            right: 12,
            maxHeight: 160,
            overflowY: 'auto',
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            boxShadow: '0 -4px 12px rgba(0,0,0,0.15)',
            zIndex: 10,
          }}
        >
          {filteredCommands.map((cmd) => (
            <button
              key={cmd}
              onClick={() => selectCommand(cmd)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 12px',
                background: 'none',
                border: 'none',
                color: 'var(--text-primary)',
                fontFamily: READER_FONT,
                fontSize: 12,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-surface)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none' }}
            >
              {cmd}
            </button>
          ))}
        </div>
      )}
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
