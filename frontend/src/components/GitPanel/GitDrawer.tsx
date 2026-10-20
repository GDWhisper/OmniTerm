import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  api, type GitBind, type GitCommitDetail, type GitHunk, type GitHunkAction,
} from '../../api/client'
import { OverlayScroll } from '../Common/OverlayScroll'
import { DrawerShell } from '../Common/DrawerShell'
import { ConfirmDialog } from '../Modal/ConfirmDialog'
import { DiffView } from './DiffView'
import { READER_FONT } from '../../utils/fonts'
import { IconEdit, IconX } from '../FileManager/icons'

export type GitDrawerTarget =
  | { kind: 'file'; path: string; staged: boolean; untracked: boolean }
  | { kind: 'commit'; sha: string }
  /** Read-only single-file diff within a BASE...HEAD comparison. */
  | { kind: 'range'; base: string; path: string }

const DEFAULT_CONTEXT_LINES = 3
const EXPANDED_CONTEXT_LINES = 10
const STAGED_HUNK_ACTIONS: GitHunkAction[] = ['unstage']
const UNSTAGED_HUNK_ACTIONS: GitHunkAction[] = ['stage', 'revert']

interface HunkActionRequest {
  path: string
  action: GitHunkAction
  patch: string
  context_lines: number
}

interface GitDrawerProps {
  target: GitDrawerTarget
  bind: GitBind
  onClose: () => void
  height: number
  onHeightChange: (height: number) => void
  /** Called once on drag release — caller persists the height here */
  onHeightCommit?: (height: number) => void
  /** Status refresh tick — re-fetches the open file diff when the repo changes. */
  refreshTick: number
  /** Open the file in the shared file editor (FileDrawer) instead of the diff. */
  onOpenInEditor: (absolutePath: string, repoRoot: string | null) => void
  /** Serialized hunk mutation; resolves true when git accepted the patch. */
  runHunkAction: (request: HunkActionRequest) => Promise<boolean>
  /** True while any git mutation (including this drawer's) is in flight. */
  busy: boolean
}

export function GitDrawer({
  target, bind, onClose, height, onHeightChange, onHeightCommit, refreshTick,
  onOpenInEditor, runHunkAction, busy,
}: GitDrawerProps) {
  const { t } = useTranslation()
  const [diff, setDiff] = useState('')
  const [truncated, setTruncated] = useState(false)
  /** Repo root returned by the diff endpoints — joins with the relative path for editor opens. */
  const [repoRoot, setRepoRoot] = useState<string | null>(null)
  const [commit, setCommit] = useState<GitCommitDetail | null>(null)
  const [hunks, setHunks] = useState<GitHunk[]>([])
  /** Context value that produced the currently displayed `hunks`. */
  const [hunkContextLines, setHunkContextLines] = useState(DEFAULT_CONTEXT_LINES)
  const [contextLines, setContextLines] = useState(DEFAULT_CONTEXT_LINES)
  const [hunkBusy, setHunkBusy] = useState(false)
  const [pendingRevert, setPendingRevert] = useState<GitHunk | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setPendingRevert(null)
  }, [target])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        if (target.kind === 'file') {
          if (target.untracked) {
            const data = await api.gitDiff(bind, {
              path: target.path,
              staged: target.staged,
              untracked: true,
            })
            if (cancelled) return
            setDiff(data.diff)
            setTruncated(data.truncated)
            setRepoRoot(data.root)
            setHunks([])
          } else {
            const data = await api.gitHunks(bind, {
              path: target.path,
              staged: target.staged,
              context_lines: contextLines,
            })
            if (cancelled) return
            setDiff(data.diff)
            setTruncated(data.truncated)
            setRepoRoot(data.root)
            setHunks(data.hunks)
            setHunkContextLines(data.context_lines)
          }
          setCommit(null)
        } else if (target.kind === 'commit') {
          const data = await api.gitShow(bind, target.sha)
          if (cancelled) return
          setCommit(data)
          setDiff(data.diff)
          setTruncated(data.truncated)
          setRepoRoot(null)
          setHunks([])
        } else {
          const data = await api.gitRangeDiff(bind, target.base, target.path)
          if (cancelled) return
          setCommit(null)
          setDiff(data.diff)
          setTruncated(data.truncated)
          setRepoRoot(data.root)
          setHunks([])
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
  }, [target, bind.session, bind.workspaceId, refreshTick, contextLines])

  const handleHunkAction = async (hunk: GitHunk, action: GitHunkAction) => {
    if (target.kind !== 'file' || hunkBusy || busy) return
    setHunkBusy(true)
    try {
      await runHunkAction({
        path: target.path,
        action,
        patch: hunk.patch,
        context_lines: hunkContextLines,
      })
    } finally {
      setHunkBusy(false)
    }
  }

  const requestHunkAction = (hunk: GitHunk, action: GitHunkAction) => {
    if (action === 'revert') {
      // Reverting a hunk discards working-tree changes irreversibly.
      setPendingRevert(hunk)
      return
    }
    void handleHunkAction(hunk, action)
  }

  const expandable = target.kind === 'file' && !target.untracked && !truncated
  const title = target.kind === 'commit'
    ? (commit?.short_sha || target.sha.slice(0, 7))
    : (target.path.split('/').pop() || target.path)

  return (
    <>
      <DrawerShell height={height} onHeightChange={onHeightChange} onHeightCommit={onHeightCommit} title={target.kind === 'commit' ? 'commit' : 'diff'}>
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
            title={target.kind === 'commit' ? target.sha : target.path}
          >
            {title}
            {target.kind === 'file' && (
              <span style={{ color: 'var(--text-faint)', fontSize: 11, marginLeft: 8 }}>
                {target.staged ? t('git.stagedLabel') : t('git.unstagedLabel')}
              </span>
            )}
            {target.kind === 'range' && (
              <span style={{ color: 'var(--text-faint)', fontSize: 11, marginLeft: 8 }}>
                {t('git.rangeLabel', { base: target.base })}
              </span>
            )}
          </span>
          {expandable && (
            <button
              className="git-row-btn git-ctx-btn"
              disabled={loading || busy}
              title={contextLines === DEFAULT_CONTEXT_LINES ? t('git.expandContext') : t('git.collapseContext')}
              onClick={() => setContextLines((value) =>
                value === DEFAULT_CONTEXT_LINES ? EXPANDED_CONTEXT_LINES : DEFAULT_CONTEXT_LINES)}
            >
              {contextLines === DEFAULT_CONTEXT_LINES ? '+ctx' : '−ctx'}
            </button>
          )}
          {target.kind !== 'commit' && repoRoot && (
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
              <DiffView
                raw={diff}
                truncated={truncated}
                hunks={target.kind === 'file' && !target.untracked ? hunks : undefined}
                hunkActions={target.kind === 'file' && !target.untracked
                  ? (target.staged ? STAGED_HUNK_ACTIONS : UNSTAGED_HUNK_ACTIONS)
                  : undefined}
                onHunkAction={target.kind === 'file' && !target.untracked ? requestHunkAction : undefined}
                hunkBusy={hunkBusy || busy}
              />
            </>
          )}
        </OverlayScroll>
      </DrawerShell>

      <ConfirmDialog
        open={pendingRevert !== null}
        onClose={() => setPendingRevert(null)}
        onConfirm={() => {
          const hunk = pendingRevert
          setPendingRevert(null)
          if (hunk) void handleHunkAction(hunk, 'revert')
        }}
        title={t('git.revertHunkTitle')}
        message={t('git.revertHunkConfirm')}
        confirmText={t('git.revertHunk')}
        destructive
        loading={hunkBusy || busy}
      />
    </>
  )
}
