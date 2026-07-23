import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TodoEntry, TodoStatus, TodoPriority } from '../../stores/chatStore'

const STATUS_ORDER: TodoStatus[] = ['in_progress', 'pending', 'completed']

const STATUS_META: Record<TodoStatus, { dot: string; labelKey: string }> = {
  in_progress: { dot: 'var(--accent)', labelKey: 'todo.status.active' },
  pending:     { dot: 'var(--text-faint)', labelKey: 'todo.status.pending' },
  completed:   { dot: 'var(--success)', labelKey: 'todo.status.done' },
}

const ICON: Record<TodoStatus, string> = {
  completed: '✓',
  in_progress: '◌',
  pending: '○',
}

const PRIORITY_MARK: Record<TodoPriority, string> = {
  high: '●',
  medium: '◐',
  low: '○',
}

interface TodoBoardProps {
  entries: TodoEntry[]
  title: string | undefined
}

export function TodoBoard({ entries, title }: TodoBoardProps) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)

  const toggle = useCallback(() => setCollapsed((c) => !c), [])

  if (entries.length === 0) return null

  const grouped: Record<TodoStatus, TodoEntry[]> = {
    in_progress: [],
    pending: [],
    completed: [],
  }
  for (const e of entries) {
    grouped[e.status].push(e)
  }

  const header = title ?? t('todo.header', { count: entries.length })

  return (
    <div className="todo-board">
      <div className="todo-board-header" onClick={toggle}>
        <span>☑</span>
        <span>{header}</span>
        <span className={`todo-toggle ${collapsed ? 'collapsed' : ''}`}>▾</span>
        <span className="todo-count">
          {grouped.completed.length}/{entries.length}
        </span>
      </div>
      {!collapsed && (
        <div className="todo-board-columns">
          {STATUS_ORDER.map((status) => {
            const items = grouped[status]
            const meta = STATUS_META[status]
            return (
              <div key={status} className="todo-column">
                <div className="todo-column-header">
                  <span className="todo-col-dot" style={{ background: meta.dot }} />
                  <span>{t(meta.labelKey)}</span>
                  <span className="todo-col-count">{items.length}</span>
                </div>
                {items.length === 0 ? (
                  <div className="todo-column-empty">—</div>
                ) : (
                  items.map((entry, i) => (
                    <div key={i} className={`todo-card status-${entry.status}`}>
                      <span
                        className="todo-card-icon"
                        style={{
                          color:
                            entry.status === 'completed'
                              ? 'var(--success)'
                              : entry.status === 'in_progress'
                                ? 'var(--accent)'
                                : 'var(--text-faint)',
                        }}
                      >
                        {ICON[entry.status]}
                      </span>
                      <span
                        className="todo-card-priority"
                        style={{
                          color:
                            entry.priority === 'high'
                              ? 'var(--danger)'
                              : entry.priority === 'medium'
                                ? 'var(--text-secondary)'
                                : 'var(--text-faint)',
                        }}
                      >
                        {PRIORITY_MARK[entry.priority]}
                      </span>
                      <span className="todo-card-text">{entry.content}</span>
                    </div>
                  ))
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
