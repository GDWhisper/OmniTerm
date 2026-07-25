import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { READER_FONT } from '../../utils/fonts'
import { OverlayScroll } from '../Common/OverlayScroll'
import type { SlashCommand } from '../../stores/chatStore'

interface ChatInputProps {
  sessionId: string
  disabled: boolean
  onSend: (text: string) => void
  onCancel: () => void
  sending: boolean
  commands?: SlashCommand[]
}

const draftKey = (sessionId: string) => `omniterm_chat_draft:${sessionId}`

function getDraft(sessionId: string): string {
  try {
    return localStorage.getItem(draftKey(sessionId)) ?? ''
  } catch {
    return ''
  }
}

function saveDraft(sessionId: string, text: string) {
  try {
    localStorage.setItem(draftKey(sessionId), text)
  } catch {
    // Ignore storage errors (quota, private mode, etc.)
  }
}

function deleteDraft(sessionId: string) {
  try {
    localStorage.removeItem(draftKey(sessionId))
  } catch {
    // Ignore storage errors
  }
}

export function ChatInput({ sessionId, disabled, onSend, onCancel, sending, commands = [] }: ChatInputProps) {
  const { t } = useTranslation()
  const [text, setText] = useState(() => getDraft(sessionId) || '')
  const [showCommands, setShowCommands] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Persist unsent text per session and restore when switching back.
  const prevSessionIdRef = useRef(sessionId)
  if (prevSessionIdRef.current !== sessionId) {
    const prevId = prevSessionIdRef.current
    // Save the draft for the outgoing session before applying the new one.
    if (text.trim() !== '') {
      saveDraft(prevId, text)
    }
    prevSessionIdRef.current = sessionId
    setText(getDraft(sessionId))
  }

  useEffect(() => {
    textareaRef.current?.focus()
  }, [sessionId])

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
    ? commands.filter((c) => c.name.toLowerCase().startsWith(text.slice(1).toLowerCase()))
    : []

  useEffect(() => {
    setShowCommands(filteredCommands.length > 0 && text.startsWith('/') && !text.includes(' '))
  }, [text, commands])

  // 命令列表长度变化时，钳制高亮索引避免越界；关闭弹窗时复位。
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, filteredCommands.length - 1)))
  }, [filteredCommands.length])
  useEffect(() => {
    if (!showCommands) setActiveIndex(0)
  }, [showCommands])

  // 高亮项移出可视区时，滚动到最近可见位置。
  useEffect(() => {
    if (showCommands) itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, showCommands])

  const canSend = !disabled && !sending && text.trim().length > 0

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showCommands && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % filteredCommands.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length)
        return
      }
      // Enter / Tab 选中当前高亮命令（Tab 默认会跳走焦点，这里拦截）。
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const cmd = filteredCommands[activeIndex]
        if (cmd) selectCommand(cmd)
        return
      }
      if (e.key === 'Escape') {
        setShowCommands(false)
        return
      }
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) {
        onSend(text)
        setText('')
        deleteDraft(sessionId)
        setShowCommands(false)
      }
    }
  }

  const selectCommand = (cmd: SlashCommand) => {
    setText('/' + cmd.name + ' ')
    setShowCommands(false)
    textareaRef.current?.focus()
  }

  const handleClickSend = () => {
    if (!canSend) return
    onSend(text)
    setText('')
    deleteDraft(sessionId)
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
        <OverlayScroll
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 12,
            right: 12,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            boxShadow: '0 -4px 12px rgba(0,0,0,0.15)',
            zIndex: 10,
          }}
          contentStyle={{ flex: '0 0 auto', maxHeight: 160 }}
        >
          {filteredCommands.map((cmd, index) => {
            const isActive = index === activeIndex
            return (
              <button
                key={cmd.name}
                ref={(el) => { itemRefs.current[index] = el }}
                onClick={() => selectCommand(cmd)}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 12px',
                  background: isActive ? 'var(--accent-14)' : 'none',
                  border: 'none',
                  color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                  fontFamily: READER_FONT,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'var(--bg-surface)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = isActive ? 'var(--accent-14)' : 'none'
                }}
              >
                <span style={{ flexShrink: 0 }}>/{cmd.name}</span>
                {cmd.description && (
                  <span
                    style={{
                      color: isActive ? 'var(--accent)' : 'var(--text-faint)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {cmd.description}
                  </span>
                )}
              </button>
            )
          })}
        </OverlayScroll>
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
