import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { parseUnifiedDiff } from './diffParser'

interface DiffViewProps {
  raw: string
  truncated: boolean
}

export function DiffView({ raw, truncated }: DiffViewProps) {
  const { t } = useTranslation()
  const files = useMemo(() => parseUnifiedDiff(raw), [raw])

  if (!raw.trim()) {
    return <div className="git-diff-empty">{t('git.noDiff')}</div>
  }

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
            file.hunks.map((hunk, hi) => (
              <div key={hi} className="git-diff-hunk">
                <div className="git-diff-line git-diff-line-hunk">
                  <span className="git-diff-lineno" />
                  <span className="git-diff-lineno" />
                  <span className="git-diff-text">{hunk.header}</span>
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
            ))
          )}
        </div>
      ))}
      {truncated && <div className="git-diff-truncated">{t('git.diffTruncated')}</div>}
    </div>
  )
}
