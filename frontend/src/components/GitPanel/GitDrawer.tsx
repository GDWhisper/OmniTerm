import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type GitBind, type GitCommitDetail } from '../../api/client'
import { OverlayScroll } from '../Common/OverlayScroll'
import { DrawerShell } from '../Common/DrawerShell'
import { DiffView } from './DiffView'
import { READER_FONT } from '../../utils/fonts'
import { IconEdit, IconX } from '../FileManager/icons'

export type GitDrawerTarget =
  | { kind: 'file'; path: string; staged: boolean; untracked: boolean }
  | { kind: 'commit'; sha: string }

interface GitDrawerProps {
  target: GitDrawerTarget
  bind: GitBind
  onClose: () => void
  height: number
  onHeightChange: (height: number) => void
  /** Status refresh tick — re-fetches the open file diff when the repo changes. */
  refreshTick: number
  /** Open the file in the shared file editor (FileDrawer) instead of the diff. */
  onOpenInEditor: (absolutePath: string, repoRoot: string | null) => void
}

export function GitDrawer({ target, bind, onClose, height, onHeightChange, refreshTick, onOpenInEditor }: GitDrawerProps) {
  const { t } = useTranslation()
  const [diff, setDiff] = useState('')
  const [truncated, setTruncated] = useState(false)
  /** Repo root returned by /git/diff — joins with the relative path for editor opens. */
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [commit, setCommit] = useState<GitCommitDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        if (target.kind === 'file') {
          const data = await api.gitDiff(bind, {
            path: target.path,
            staged: target.staged,
            untracked: target.untracked,
          })
          if (cancelled) return
          setDiff(data.diff)
          setTruncated(data.truncated)
          setRepoRoot(data.root)
          setCommit(null)
        } else {
          const data = await api.gitShow(bind, target.sha)
          if (cancelled) return
          setCommit(data)
          setDiff(data.diff)
          setTruncated(data.truncated)
          setRepoRoot(null)
        }
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
    // refreshTick keeps a file diff live while the working tree changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, bind.session, bind.workspaceId, target.kind === 'file' ? refreshTick : 0])

  const title = target.kind === 'file'
    ? target.path.split('/').pop() || target.path
    : commit?.short_sha || target.sha.slice(0, 7)

  return (
    <DrawerShell height={height} onHeightChange={onHeightChange} title={target.kind === 'file' ? 'diff' : 'commit'}>
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px',
          height: 36,
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
          fontFamily: READER_FONT,
        }}
      >
        <span
          style={{
            color: 'var(--text-primary)',
            fontSize: 13,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            flex: 1,
          }}
          title={target.kind === 'file' ? target.path : target.sha}
        >
          {title}
          {target.kind === 'file' && (
            <span style={{ color: 'var(--text-faint)', fontSize: 11, marginLeft: 8 }}>
              {target.staged ? t('git.stagedLabel') : t('git.unstagedLabel')}
            </span>
          )}
        </span>
        {target.kind === 'file' && repoRoot && (
          <button
            onClick={() => onOpenInEditor(`${repoRoot}/${target.path}`, repoRoot)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, border: 'none', borderRadius: 0,
              background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; e.currentTarget.style.background = 'transparent' }}
            title={t('git.openInEditor')}
          >
            <IconEdit width={14} height={14} />
          </button>
        )}
        <button
          onClick={onClose}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, border: 'none', borderRadius: 5,
            background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--danger)'; e.currentTarget.style.background = 'var(--danger-12)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; e.currentTarget.style.background = 'transparent' }}
          title={t('drawer.close')}
        >
          <IconX width={14} height={14} />
        </button>
      </div>

      {/* Content */}
      <OverlayScroll style={{ flex: 1, minHeight: 0 }}>
        {loading ? (
          <div className="git-drawer-message">{t('drawer.loading')}</div>
        ) : error ? (
          <div className="git-drawer-message" style={{ color: 'var(--danger)' }}>{error}</div>
        ) : (
          <>
            {commit && (
              <div className="git-commit-meta">
                <div className="git-commit-meta-row">
                  <span className="git-commit-sha">{commit.sha}</span>
                </div>
                <div className="git-commit-meta-row">
                  <span>{commit.author} &lt;{commit.email}&gt;</span>
                  <span style={{ color: 'var(--text-faint)' }}>{new Date(commit.date).toLocaleString()}</span>
                </div>
                <pre className="git-commit-message">{commit.message}</pre>
              </div>
            )}
            <DiffView raw={diff} truncated={truncated} />
          </>
        )}
      </OverlayScroll>
    </DrawerShell>
  )
}
