import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type GitBind, type GitLogEntry, type GitStatusEntry } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useGitStore, GIT_POLL_INTERVAL_MS } from '../../stores/gitStore'
import { useToastStore } from '../../stores/toastStore'
import { OverlayScroll } from '../Common/OverlayScroll'
import { GitDrawer, type GitDrawerTarget } from './GitDrawer'
import { IconRefresh } from '../FileManager/icons'

const LOG_PAGE_SIZE = 50

function statusChar(entry: GitStatusEntry, staged: boolean): string {
  if (entry.conflicted) return 'U'
  if (entry.index_status === '?') return '?'
  return staged ? entry.index_status : entry.worktree_status
}

/** A file is shown in the staged zone when its index status differs from HEAD. */
function isStaged(e: GitStatusEntry): boolean {
  return !e.conflicted && e.index_status !== '.' && e.index_status !== '?'
}

/** A file is shown in the unstaged zone when the working tree differs from the index. */
function isUnstaged(e: GitStatusEntry): boolean {
  return e.conflicted || e.index_status === '?' || e.worktree_status !== '.'
}

interface GitPanelProps {
  /** Polling only runs while the GIT tab is visible and the panel expanded (ADR-4). */
  visible: boolean
}

export function GitPanel({ visible }: GitPanelProps) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeProjectId = useAppStore((s) => s.activeProjectId)

  const status = useGitStore((s) => s.status)
  const branches = useGitStore((s) => s.branches)
  const mutating = useGitStore((s) => s.mutating)
  const refreshHint = useGitStore((s) => s.refreshHint)
  const fetchStatus = useGitStore((s) => s.fetchStatus)
  const fetchBranches = useGitStore((s) => s.fetchBranches)
  const mutate = useGitStore((s) => s.mutate)
  const resetGit = useGitStore((s) => s.reset)

  const bind: GitBind | null = useMemo(() => {
    if (activeSessionId) return { session: activeSessionId }
    if (activeWorkspaceId) return { workspaceId: activeWorkspaceId, projectId: activeProjectId ?? undefined }
    return null
  }, [activeSessionId, activeWorkspaceId, activeProjectId])
  const bindKey = bind ? (bind.session ?? `ws:${bind.workspaceId}`) : null

  const [view, setView] = useState<'changes' | 'history'>('changes')
  const [message, setMessage] = useState('')
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const branchMenuRef = useRef<HTMLDivElement>(null)
  const [drawerTarget, setDrawerTarget] = useState<GitDrawerTarget | null>(null)
  const [drawerHeight, setDrawerHeight] = useState(() => {
    const stored = sessionStorage.getItem('omniterm_git_drawer_height')
    return stored ? parseInt(stored) : 256
  })
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [logHasMore, setLogHasMore] = useState(false)
  const [logLoading, setLogLoading] = useState(false)
  /** Bumped on every completed status fetch; keeps the open file diff live. */
  const [statusTick, setStatusTick] = useState(0)

  useEffect(() => {
    sessionStorage.setItem('omniterm_git_drawer_height', String(drawerHeight))
  }, [drawerHeight])

  // Reset per-repo UI state when the binding changes
  useEffect(() => {
    resetGit()
    setDrawerTarget(null)
    setLog([])
    setLogHasMore(false)
    setMessage('')
    setBranchMenuOpen(false)
  }, [bindKey, resetGit])

  // ── Visible-time serial polling (ADR-4): schedule the next poll
  //    GIT_POLL_INTERVAL_MS after the previous one COMPLETES. ──
  const bindRef = useRef(bind)
  bindRef.current = bind
  useEffect(() => {
    if (!visible || !bind) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      const b = bindRef.current
      if (cancelled || !b) return
      await fetchStatus(b)
      if (cancelled) return
      setStatusTick((n) => n + 1)
      timer = setTimeout(tick, GIT_POLL_INTERVAL_MS)
    }
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // refreshHint restarts the loop for an immediate poll (ACP edit hint / manual ops)
  }, [visible, bindKey, refreshHint, fetchStatus])

  // Branch list: fetched when the panel becomes visible or repo changes
  useEffect(() => {
    if (!visible || !bind) return
    fetchBranches(bind)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, bindKey, refreshHint])

  // Close branch menu on outside click
  useEffect(() => {
    if (!branchMenuOpen) return
    const onClick = (e: MouseEvent) => {
      if (branchMenuRef.current && !branchMenuRef.current.contains(e.target as Node)) {
        setBranchMenuOpen(false)
        setNewBranchName('')
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [branchMenuOpen])

  const fetchLog = useCallback(async (skip: number, append: boolean) => {
    if (!bind) return
    setLogLoading(true)
    try {
      const data = await api.gitLog(bind, { skip, limit: LOG_PAGE_SIZE })
      if ('entries' in data) {
        setLog((prev) => append ? [...prev, ...data.entries] : data.entries)
        setLogHasMore(data.has_more)
      }
    } catch {
      // request() already toasts
    } finally {
      setLogLoading(false)
    }
  }, [bind])

  // Load history when switching to the HISTORY view
  useEffect(() => {
    if (view !== 'history' || !visible) return
    fetchLog(0, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, bindKey, visible])

  const runMutation = useCallback(async (op: () => Promise<unknown>, successMsg?: string) => {
    if (!bind) return
    try {
      await mutate(bind, op)
      setStatusTick((n) => n + 1)
      if (successMsg) addToast('success', successMsg)
    } catch {
      // request() already toasts the refined backend error
    }
  }, [bind, mutate, addToast])

  const entries = status?.entries ?? []
  const stagedEntries = entries.filter(isStaged)
  const unstagedEntries = entries.filter(isUnstaged)
  const isRepo = status?.is_repo ?? false

  const handleCommit = () => {
    if (!message.trim() || stagedEntries.length === 0) return
    runMutation(() => api.gitCommit(bind!, message), t('git.committed')).then(() => {
      // Only clear when the commit actually landed (status no longer has those staged rows)
      if (useGitStore.getState().status?.entries?.some(isStaged) === false) setMessage('')
    })
  }

  const handleDiscard = (entry: GitStatusEntry) => {
    if (!confirm(t('git.confirmDiscard', { name: entry.path }))) return
    runMutation(
      () => api.gitDiscard(bind!, [{ path: entry.path, untracked: entry.index_status === '?' }]),
      t('git.discarded'),
    )
  }

  const handleCheckout = (name: string) => {
    setBranchMenuOpen(false)
    runMutation(async () => {
      await api.gitCheckout(bind!, name)
      await fetchBranches(bind!)
    }, t('git.switchedBranch', { name }))
  }

  const handleCreateBranch = () => {
    const name = newBranchName.trim()
    if (!name) return
    setBranchMenuOpen(false)
    setNewBranchName('')
    runMutation(async () => {
      await api.gitCreateBranch(bind!, name)
      await fetchBranches(bind!)
    }, t('git.createdBranch', { name }))
  }

  if (!bind) {
    return <div className="git-empty">{t('git.selectSessionFirst')}</div>
  }
  if (status && !isRepo) {
    return <div className="git-empty">{t('git.notARepo')}</div>
  }
  if (!status) {
    return <div className="git-empty">{t('git.loading')}</div>
  }

  const branchLabel = status.detached ? t('git.detached') : (status.branch ?? '—')

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* ── Top persistent row: branch selector + remote ops ── */}
      <div className="git-topbar">
        <div className="git-branch-wrap" ref={branchMenuRef}>
          <button
            className="git-branch-btn"
            onClick={() => setBranchMenuOpen((v) => !v)}
            disabled={mutating}
            title={status.upstream ? `${branchLabel} → ${status.upstream}` : branchLabel}
          >
            <span className="git-branch-glyph">⎇</span>
            <span className="git-branch-name">{branchLabel}</span>
            <span style={{ fontSize: 9 }}>▼</span>
          </button>
          {branchMenuOpen && (
            <div className="git-branch-menu">
              <OverlayScroll style={{ maxHeight: 180 }} contentStyle={{ flex: '0 0 auto', maxHeight: 180 }}>
                {branches.map((b) => (
                  <button
                    key={b.name}
                    className={`git-branch-item ${b.current ? 'active' : ''}`}
                    onClick={() => { if (!b.current) handleCheckout(b.name) }}
                  >
                    {b.current ? '● ' : ''}{b.name}
                  </button>
                ))}
              </OverlayScroll>
              <div className="git-branch-create">
                <input
                  className="git-input"
                  placeholder={t('git.newBranchPlaceholder')}
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateBranch()
                    if (e.key === 'Escape') { setBranchMenuOpen(false); setNewBranchName('') }
                  }}
                />
                <button className="git-btn" onClick={handleCreateBranch} disabled={!newBranchName.trim()}>+</button>
              </div>
            </div>
          )}
        </div>
        <span className="title-bar-spacer" />
        {(status.ahead ?? 0) > 0 && <span className="git-ab-badge">↑{status.ahead}</span>}
        {(status.behind ?? 0) > 0 && <span className="git-ab-badge">↓{status.behind}</span>}
        <button className="git-btn" disabled={mutating} onClick={() => runMutation(() => api.gitFetch(bind), t('git.fetched'))} title={t('git.fetch')}>
          {t('git.fetchBtn')}
        </button>
        <button className="git-btn" disabled={mutating} onClick={() => runMutation(() => api.gitPull(bind), t('git.pulled'))} title={t('git.pull')}>
          {t('git.pullBtn')}
        </button>
        <button className="git-btn" disabled={mutating} onClick={() => runMutation(() => api.gitPush(bind), t('git.pushed'))} title={t('git.push')}>
          {t('git.pushBtn')}
        </button>
      </div>

      {/* ── Secondary view switch: CHANGES | HISTORY ── */}
      <div className="git-viewbar">
        <button className={`git-view-tab ${view === 'changes' ? 'active' : ''}`} onClick={() => setView('changes')}>
          {t('git.changesTab')}
          {entries.length > 0 && <span className="git-count-badge">{entries.length}</span>}
        </button>
        <button className={`git-view-tab ${view === 'history' ? 'active' : ''}`} onClick={() => setView('history')}>
          {t('git.historyTab')}
        </button>
        <span className="title-bar-spacer" />
        <button
          className="fm-btn"
          onClick={() => {
            useGitStore.getState().notifyExternalChange()
            if (view === 'history') fetchLog(0, false)
          }}
          title={t('git.refresh')}
        >
          <IconRefresh />
        </button>
      </div>

      {view === 'changes' ? (
        <>
          <OverlayScroll style={{ flex: 1, minHeight: 0 }}>
            {entries.length === 0 ? (
              <div className="git-empty">{t('git.cleanWorktree')}</div>
            ) : (
              <>
                <FileSection
                  label={t('git.stagedSection')}
                  entries={stagedEntries}
                  staged
                  mutating={mutating}
                  onOpen={(e) => setDrawerTarget({ kind: 'file', path: e.path, staged: true, untracked: false })}
                  onAction={(e) => runMutation(() => api.gitUnstage(bind, [e.path]))}
                  onActionAll={() => runMutation(() => api.gitUnstage(bind, stagedEntries.map((e) => e.path)))}
                  actionGlyph="−"
                  actionTitle={t('git.unstage')}
                  actionAllTitle={t('git.unstageAll')}
                />
                <FileSection
                  label={t('git.changesSection')}
                  entries={unstagedEntries}
                  staged={false}
                  mutating={mutating}
                  onOpen={(e) => setDrawerTarget({ kind: 'file', path: e.path, staged: false, untracked: e.index_status === '?' })}
                  onAction={(e) => runMutation(() => api.gitStage(bind, [e.path]))}
                  onActionAll={() => runMutation(() => api.gitStage(bind, unstagedEntries.map((e) => e.path)))}
                  actionGlyph="+"
                  actionTitle={t('git.stage')}
                  actionAllTitle={t('git.stageAll')}
                  onDiscard={handleDiscard}
                  discardTitle={t('git.discard')}
                />
              </>
            )}
          </OverlayScroll>

          {/* ── Bottom-fixed commit box ── */}
          <div className="git-commit-box">
            <textarea
              className="git-commit-input"
              placeholder={t('git.commitPlaceholder')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCommit()
              }}
            />
            <button
              className="git-commit-btn"
              disabled={mutating || !message.trim() || stagedEntries.length === 0}
              onClick={handleCommit}
              title={stagedEntries.length === 0 ? t('git.nothingStaged') : undefined}
            >
              {t('git.commitBtn', { count: stagedEntries.length })}
            </button>
          </div>
        </>
      ) : (
        <OverlayScroll style={{ flex: 1, minHeight: 0 }}>
          {log.length === 0 && !logLoading ? (
            <div className="git-empty">{t('git.noCommits')}</div>
          ) : (
            <div>
              {log.map((entry) => (
                <button
                  key={entry.sha}
                  className="git-log-row"
                  onClick={() => setDrawerTarget({ kind: 'commit', sha: entry.sha })}
                >
                  <span className="git-log-subject">{entry.subject}</span>
                  <span className="git-log-meta">
                    <span className="git-log-sha">{entry.short_sha}</span>
                    <span>{entry.author}</span>
                    <span>{new Date(entry.date).toLocaleDateString()}</span>
                  </span>
                </button>
              ))}
              {logHasMore && (
                <button className="git-load-more" disabled={logLoading} onClick={() => fetchLog(log.length, true)}>
                  {logLoading ? t('git.loading') : t('git.loadMore')}
                </button>
              )}
            </div>
          )}
        </OverlayScroll>
      )}

      {drawerTarget && (
        <GitDrawer
          target={drawerTarget}
          bind={bind}
          onClose={() => setDrawerTarget(null)}
          height={drawerHeight}
          onHeightChange={setDrawerHeight}
          refreshTick={statusTick}
        />
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

function FileSection({
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
        <div key={`${staged ? 's' : 'u'}:${e.path}`} className="git-file-row" onClick={() => onOpen(e)}>
          <span className={`git-status-char git-status-${e.conflicted ? 'conflict' : statusChar(e, staged)}`}>
            {statusChar(e, staged)}
          </span>
          <span className="git-file-path" title={e.orig_path ? `${e.orig_path} → ${e.path}` : e.path}>
            {e.path}
          </span>
          <span className="git-file-actions" onClick={(ev) => ev.stopPropagation()}>
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
          </span>
        </div>
      ))}
    </div>
  )
}
