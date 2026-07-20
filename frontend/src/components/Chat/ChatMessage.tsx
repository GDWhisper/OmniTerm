import { useState } from 'react'
import type { ChatMessage, ContentBlock, ToolCallBlock, PlanBlock } from '../../stores/chatStore'
import { Markdown } from './Markdown'
import { READER_FONT } from '../../utils/fonts'

const TOOL_KIND_ICONS: Record<string, string> = {
  read: '📖',
  edit: '✏️',
  execute: '⬛',
  search: '🔍',
  delete: '🗑️',
  write: '📝',
  browser: '🌐',
}

function ThoughtBlockView({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ alignSelf: 'flex-start', maxWidth: '85%', fontSize: 12 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-faint)',
          fontSize: 11,
          padding: 0,
          fontFamily: READER_FONT,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontStyle: 'italic',
          opacity: 0.9,
        }}
      >
        <span style={{ fontStyle: 'normal' }}>💭</span>
        {open ? '▾' : '▸'} thinking
      </button>
      {open && (
        <div
          style={{
            marginTop: 4,
            padding: '2px 10px',
            borderLeft: '2px solid var(--border-subtle)',
            fontSize: 12,
            lineHeight: 1.5,
            color: 'var(--text-muted)',
            fontStyle: 'italic',
            whiteSpace: 'pre-wrap',
            maxHeight: 300,
            overflowY: 'auto',
          }}
        >
          {text}
        </div>
      )}
    </div>
  )
}

function looksLikeDiff(text: string): boolean {
  const lines = text.split('\n')
  if (lines.length < 3) return false
  let diffLines = 0
  for (const l of lines.slice(0, 20)) {
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@') || l.startsWith('+') || l.startsWith('-')) {
      diffLines++
    }
  }
  return diffLines >= 3
}

function DiffView({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <pre
      style={{
        margin: 0,
        padding: '6px 8px',
        background: '#1a1e24',
        borderRadius: 4,
        fontSize: 11,
        overflow: 'auto',
        maxHeight: 300,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        lineHeight: 1.5,
      }}
    >
      {lines.map((line, i) => {
        let color = '#d1d5db'
        let bg = 'transparent'
        if (line.startsWith('+++') || line.startsWith('---')) {
          color = '#8b949e'
        } else if (line.startsWith('@@')) {
          color = '#79c0ff'
        } else if (line.startsWith('+')) {
          color = '#aff5b4'
          bg = 'rgba(46, 160, 67, 0.15)'
        } else if (line.startsWith('-')) {
          color = '#ffa198'
          bg = 'rgba(248, 81, 73, 0.15)'
        }
        return (
          <div key={i} style={{ color, background: bg, minHeight: '1em' }}>{line || ' '}</div>
        )
      })}
    </pre>
  )
}

function ToolCallBlockView({ block }: { block: ToolCallBlock }) {
  const [open, setOpen] = useState(false)
  const icon = TOOL_KIND_ICONS[block.kind ?? ''] ?? '🔧'
  const statusIcon = block.status === 'completed' ? '✓'
    : block.status === 'failed' ? '✗'
    : block.status === 'running' ? '…'
    : '↻'
  const statusColor = block.status === 'completed' ? 'var(--success)'
    : block.status === 'failed' ? 'var(--danger, #FF7B72)'
    : 'var(--accent)'

  const isTerminal = block.kind === 'execute'
  const isDiff = block.content ? looksLikeDiff(block.content) : false
  const hasContent = block.content || (block.locations && block.locations.length > 0)

  return (
    <div
      style={{
        alignSelf: 'stretch',
        maxWidth: '85%',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderLeft: `2px solid ${statusColor}`,
        borderRadius: 6,
        fontSize: 12,
        transition: 'border-color 0.3s ease',
      }}
    >
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--text-secondary)',
          fontSize: 12,
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
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11,
          }}
        >
          {block.title ?? block.kind ?? 'tool call'}
        </span>
        <span style={{ color: statusColor, fontWeight: 700, transition: 'color 0.3s ease' }}>{statusIcon}</span>
        {hasContent && (
          <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>{open ? '▾' : '▸'}</span>
        )}
      </button>
      {open && (
        <div style={{ padding: '0 10px 8px 32px' }}>
          {block.locations && block.locations.length > 0 && (
            <div style={{ color: 'var(--text-faint)', fontSize: 11, marginBottom: 4 }}>
              {block.locations.map((l) => <div key={l}>📄 {l}</div>)}
            </div>
          )}
          {block.content && isDiff && <DiffView text={block.content} />}
          {block.content && !isDiff && (
            <pre
              style={{
                margin: 0,
                padding: '6px 8px',
                background: isTerminal ? '#1a1e24' : 'var(--bg-base)',
                borderRadius: 4,
                fontSize: 11,
                overflow: 'auto',
                maxHeight: 200,
                whiteSpace: 'pre-wrap',
                color: isTerminal ? '#d1d5db' : 'var(--text-muted)',
                fontFamily: isTerminal ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit',
              }}
            >
              {block.content}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

function PlanBlockView({ block }: { block: PlanBlock }) {
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: '85%',
        padding: '6px 10px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 6,
        fontSize: 12,
      }}
    >
      {block.entries.map((entry, i) => {
        const icon = entry.status === 'completed' ? '✓' : entry.status === 'in_progress' ? '⏳' : '○'
        const color = entry.status === 'completed' ? 'var(--success)'
          : entry.status === 'in_progress' ? 'var(--accent)'
          : 'var(--text-faint)'
        return (
          <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline', padding: '1px 0' }}>
            <span style={{ color, fontSize: 11 }}>{icon}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{entry.content}</span>
          </div>
        )
      })}
    </div>
  )
}

function TextBlockView({ text, caret }: { text: string; caret?: boolean }) {
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: '85%',
        padding: '8px 12px',
        borderRadius: 8,
        background: 'var(--bg-surface)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-subtle)',
        fontFamily: READER_FONT,
        fontSize: 13,
        lineHeight: 1.5,
        wordBreak: 'break-word',
      }}
    >
      <Markdown text={text} />
      {caret && <span className="chat-streaming-caret" />}
    </div>
  )
}

function renderBlock(block: ContentBlock, idx: number, isLast: boolean, streaming: boolean) {
  switch (block.type) {
    case 'text':
      return <TextBlockView key={idx} text={block.text} caret={isLast && streaming} />
    case 'thought':
      return <ThoughtBlockView key={idx} text={block.text} />
    case 'tool_call':
      return <ToolCallBlockView key={idx} block={block} />
    case 'plan':
      return <PlanBlockView key={idx} block={block} />
    case 'system':
      return (
        <span key={idx} style={{ alignSelf: 'flex-start', color: 'var(--text-faint)', fontSize: 11 }}>
          [{block.label}]
        </span>
      )
  }
}

export function ChatMessageView({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  const label = (
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
  )

  if (isUser) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', padding: '4px 12px' }}>
        {label}
        <div
          style={{
            padding: '8px 12px',
            borderRadius: 8,
            maxWidth: '85%',
            background: 'var(--accent-14)',
            color: 'var(--text-primary)',
            border: '1px solid var(--accent-14)',
            fontFamily: READER_FONT,
            fontSize: 13,
            lineHeight: 1.5,
            wordBreak: 'break-word',
          }}
        >
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
          </pre>
        </div>
      </div>
    )
  }

  // Assistant/system: stack distinct blocks (thought / tool card / text bubble)
  // rather than collapsing everything into a single bubble.
  const lastIdx = message.blocks.length - 1
  const showLooseCaret = message.streaming && (lastIdx < 0 || message.blocks[lastIdx].type !== 'text')
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        padding: '4px 12px',
        gap: 6,
      }}
    >
      {label}
      {message.blocks.map((b, i) => renderBlock(b, i, i === lastIdx, message.streaming))}
      {showLooseCaret && <span className="chat-streaming-caret" style={{ alignSelf: 'flex-start' }} />}
    </div>
  )
}
