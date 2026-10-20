import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { GitHunk, GitHunkAction } from '../../api/client'
import { parseUnifiedDiff } from './diffParser'

interface DiffViewProps {
  raw: string
  truncated: boolean
  /** Backend-authoritative hunk patches, aligned by header with the parsed raw diff. */
  hunks?: GitHunk[]
  /** Actions offered per hunk (omit for read-only commit/untracked diffs). */
  hunkActions?: GitHunkAction[]
  onHunkAction?: (hunk: GitHunk, action: GitHunkAction) => void
  /** Disables hunk buttons while a mutation is in flight. */
  hunkBusy?: boolean
}

const HUNK_ACTION_LABEL: Record<GitHunkAction, string> = {
  stage: 'git.stageHunk',
  unstage: 'git.unstageHunk',
  revert: 'git.revertHunk',
}

const HUNK_ACTION_GLYPH: Record<GitHunkAction, string> = {
  stage: '+',
  unstage: '−',
  revert: '↺',
}

export function DiffView({
  raw, truncated, hunks, hunkActions, onHunkAction, hunkBusy,
}: DiffViewProps) {
  const { t } = useTranslation()
  const files = useMemo(() => parseUnifiedDiff(raw), [raw])
  const parsedHunks = useMemo(() => files.flatMap((file) => file.hunks), [files])

  // Fail closed: only offer actions when every parsed hunk maps 1:1 to a
  // backend patch by header. A mismatch means the two views disagree about
  // the diff, and applying an unrelated patch would be worse than no button.
  const aligned = useMemo(() => {
    if (!hunks || !hunkActions || hunkActions.length === 0 || !onHunkAction) return false
    if (hunks.length !== parsedHunks.length) return false
    return parsedHunks.every((hunk, index) => hunk.header === hunks[index].header)
  }, [hunks, hunkActions, onHunkAction, parsedHunks])

  if (!raw.trim()) {
    return <div className="git-diff-empty">{t('git.noDiff')}</div>
  }

  let hunkIndex = -1
  return (
    <div className="git-diff">
      {files.map((file, fi) => (
        <div key={fi} className="git-diff-file">
          {files.length > 1 && (
            <div className="git-diff-file-header">
              {file.newPath === '/dev/null' ? file.oldPath : file.newPath}
            </div>
          )}
          {file.binary ? (
            <div className="git-diff-empty">{t('git.binaryFile')}</div>
          ) : (
            file.hunks.map((hunk, hi) => {
              hunkIndex += 1
              const actionHunk = aligned ? hunks![hunkIndex] : null
              return (
                <div key={hi} className="git-diff-hunk">
                  <div className="git-diff-line git-diff-line-hunk">
                    <span className="git-diff-lineno" />
                    <span className="git-diff-lineno" />
                    <span className="git-diff-text">{hunk.header}</span>
                    {actionHunk && (
                      <span className="git-diff-hunk-actions">
                        {hunkActions!.map((action) => (
                          <button
                            key={action}
                            className={`git-row-btn ${action === 'revert' ? 'git-row-btn-danger' : ''}`}
                            disabled={hunkBusy}
                            title={t(HUNK_ACTION_LABEL[action])}
                            onClick={() => onHunkAction!(actionHunk, action)}
                          >
                            {HUNK_ACTION_GLYPH[action]}
                          </button>
                        ))}
                      </span>
                    )}
                  </div>
                  {hunk.lines.map((line, li) => (
                    <div key={li} className={`git-diff-line git-diff-line-${line.type}`}>
                      <span className="git-diff-lineno">{line.oldNo ?? ''}</span>
                      <span className="git-diff-lineno">{line.newNo ?? ''}</span>
                      <span className="git-diff-text">
                        {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                        {line.text}
                      </span>
                    </div>
                  ))}
                </div>
              )
            })
          )}
        </div>
      ))}
      {truncated && <div className="git-diff-truncated">{t('git.diffTruncated')}</div>}
    </div>
  )
}
