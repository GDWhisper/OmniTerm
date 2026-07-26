import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type GitBind, type GitCommitDetail } from '../../api/client'
import { OverlayScroll } from '../Common/OverlayScroll'
import { DiffView } from './DiffView'
import { READER_FONT } from '../../utils/fonts'
import { IconX } from '../FileManager/icons'

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
}

export function GitDrawer({ target, bind, onClose, height, onHeightChange, refreshTick }: GitDrawerProps) {
  const { t } = useTranslation()
  const [diff, setDiff] = useState('')
  const [truncated, setTruncated] = useState(false)
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
          setCommit(null)
        } else {
          const data = await api.gitShow(bind, target.sha)
          if (cancelled) return
          setCommit(data)
          setDiff(data.diff)
          setTruncated(data.truncated)
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

  // Drag bar resize (same interaction as FileDrawer)
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - e.clientY
      const newH = Math.max(120, Math.min(window.innerHeight - 60, dragRef.current.startH + delta))
      onHeightChange(newH)
    }
    const onMouseUp = () => {
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [onHeightChange])

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: height }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  const title = target.kind === 'file'
    ? target.path.split('/').pop() || target.path
    : commit?.short_sha || target.sha.slice(0, 7)

  return (
    <div
      style={{
        height,
        minHeight: 120,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border-strong)',
        flexShrink: 0,
      }}
    >
      <div className="panel-title-bar">
        <span>◆</span>
        <span>{target.kind === 'file' ? 'diff' : 'commit'}</span>
      </div>

      <div
        onMouseDown={handleDragStart}
        style={{
          height: 6,
          cursor: 'ns-resize',
          background: 'var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          transition: 'background 0.15s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--border-subtle)' }}
      >
        <div style={{ width: 32, height: 2, borderRadius: 1, background: 'var(--text-dim)' }} />
      </div>

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
    </div>
  )
}
