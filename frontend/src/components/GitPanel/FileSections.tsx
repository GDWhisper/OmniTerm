import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitRangeFile, GitStatusEntry } from '../../api/client'

function statusChar(entry: GitStatusEntry, staged: boolean): string {
  if (entry.conflicted) return 'U'
  if (entry.index_status === '?') return '?'
  return staged ? entry.index_status : entry.worktree_status
}

interface GitFileRowProps {
  path: string
  origPath?: string
  char: string
  conflict?: boolean
  onOpen: () => void
  /** Hover/focus action buttons; omitted for read-only lists (range view). */
  actions?: ReactNode
}

function GitFileRow({ path, origPath, char, conflict, onOpen, actions }: GitFileRowProps) {
  return (
    <div className="git-file-row" onClick={onOpen}>
      <span className={`git-status-char git-status-${conflict ? 'conflict' : char}`}>
        {char}
      </span>
      {/* 容器 direction:rtl 只为左侧省略号；bdi 隔离避免前导 . 等中性字符被 bidi 重排 */}
      <span className="git-file-path" title={origPath ? `${origPath} → ${path}` : path}>
        <bdi dir="ltr">{path}</bdi>
      </span>
      {actions && (
        <span className="git-file-actions" onClick={(ev) => ev.stopPropagation()}>
          {actions}
        </span>
      )}
    </div>
  )
}

interface FileSectionProps {
  label: string
  entries: GitStatusEntry[]
  staged: boolean
  mutating: boolean
  onOpen: (e: GitStatusEntry) => void
  onAction: (e: GitStatusEntry) => void
  onActionAll: () => void
  actionGlyph: string
  actionTitle: string
  actionAllTitle: string
  onDiscard?: (e: GitStatusEntry) => void
  discardTitle?: string
}

export function FileSection({
  label, entries, staged, mutating,
  onOpen, onAction, onActionAll, actionGlyph, actionTitle, actionAllTitle,
  onDiscard, discardTitle,
}: FileSectionProps) {
  if (entries.length === 0) return null
  return (
    <div className="git-section">
      <div className="git-section-header">
        <span>{label}</span>
        <span className="git-count-badge">{entries.length}</span>
        <span className="title-bar-spacer" />
        <button className="git-row-btn" disabled={mutating} onClick={onActionAll} title={actionAllTitle}>
          {actionGlyph}
        </button>
      </div>
      {entries.map((e) => (
        <GitFileRow
          key={`${staged ? 's' : 'u'}:${e.path}`}
          path={e.path}
          origPath={e.orig_path}
          char={statusChar(e, staged)}
          conflict={e.conflicted}
          onOpen={() => onOpen(e)}
          actions={
            <>
              {onDiscard && !e.conflicted && (
                <button className="git-row-btn git-row-btn-danger" disabled={mutating} onClick={() => onDiscard(e)} title={discardTitle}>
                  ↺
                </button>
              )}
              {!e.conflicted && (
                <button className="git-row-btn" disabled={mutating} onClick={() => onAction(e)} title={actionTitle}>
                  {actionGlyph}
                </button>
              )}
            </>
          }
        />
      ))}
    </div>
  )
}

interface RangeFileSectionProps {
  base: string
  files: GitRangeFile[]
  filesTruncated: boolean
  onOpen: (file: GitRangeFile) => void
}

/** Read-only file list for BASE...HEAD comparisons: no stage/discard actions. */
export function RangeFileSection({ base, files, filesTruncated, onOpen }: RangeFileSectionProps) {
  const { t } = useTranslation()
  if (files.length === 0) {
    return <div className="git-empty">{t('git.rangeEmpty')}</div>
  }
  return (
    <div className="git-section">
      <div className="git-section-header">
        <span>{t('git.rangeSection', { base })}</span>
        <span className="git-count-badge">{files.length}</span>
      </div>
      {files.map((file) => (
        <GitFileRow
          key={`${file.status}:${file.path}`}
          path={file.path}
          origPath={file.orig_path}
          char={file.status}
          conflict={file.status === 'U'}
          onOpen={() => onOpen(file)}
        />
      ))}
      {filesTruncated && (
        <div className="git-range-note">
          {t('git.rangeFilesTruncated', { count: files.length })}
        </div>
      )}
    </div>
  )
}
