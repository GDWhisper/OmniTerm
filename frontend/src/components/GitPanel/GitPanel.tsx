import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError, type GitBind, type GitBranch, type GitLogEntry, type GitStatusEntry } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useGitStore, GIT_POLL_INTERVAL_MS } from '../../stores/gitStore'
import { useToastStore } from '../../stores/toastStore'
import { getInitialDrawerHeight } from '../../utils/drawer'
import { copyText } from '../../utils/clipboard'
import { hapticTap } from '../../utils/haptics'
import { LONG_PRESS_CLICK_SUPPRESS_MS, useLongPress } from '../../hooks/useLongPress'
import { OverlayScroll } from '../Common/OverlayScroll'
import { ContextMenu } from '../Common/ContextMenu'
import { ConfirmDialog } from '../Modal/ConfirmDialog'
import { FileDrawer } from '../FileManager/FileDrawer'
import { GitDrawer, type GitDrawerTarget } from './GitDrawer'
import { BranchDeleteDialog, BranchRenameDialog } from './BranchDialogs'
import { GeneratedMessageDialog } from './GeneratedMessageDialog'
import { StashPanel } from './StashPanel'
import {
  IconArrowDown, IconCopy, IconGitBranch, IconPencil, IconRefresh, IconTrash,
} from '../FileManager/icons'

const LOG_PAGE_SIZE = 50

/** Backend error codes (ADR-6 refined stderr) with localized toast copy. */
const KNOWN_ERROR_CODES = [
  'auth', 'non_fast_forward', 'no_upstream', 'dirty_worktree', 'timeout', 'not_merged', 'conflict',
  'nothing_to_stash', 'stash_conflict', 'nothing_staged',
  'ai_not_configured', 'ai_auth', 'ai_rate_limited', 'ai_timeout', 'ai_network', 'ai_upstream',
  'ai_invalid_response',
] as const

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
  const isMobile = useAppStore((s) => s.isMobile)
  const settingsOpen = useAppStore((s) => s.settingsOpen)

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
  const [amend, setAmend] = useState(false)
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [renameTarget, setRenameTarget] = useState<GitBranch | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<GitBranch | null>(null)
  /** True after `-d` refused; the delete dialog then requires the force checkbox. */
  const [deleteUnmerged, setDeleteUnmerged] = useState(false)
  const [branchBusy, setBranchBusy] = useState(false)
  const [stashOpen, setStashOpen] = useState(false)
  const [aiCommitReady, setAiCommitReady] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generatedMessage, setGeneratedMessage] = useState<string | null>(null)
  const [commitMenu, setCommitMenu] = useState<{ sha: string; x: number; y: number } | null>(null)
  const [resetTarget, setResetTarget] = useState<
    { sha: string; shortSha: string; mode: 'soft' | 'mixed' } | null
  >(null)
  const longPressAtRef = useRef(0)
  const branchMenuRef = useRef<HTMLDivElement>(null)
  const [drawerTarget, setDrawerTarget] = useState<GitDrawerTarget | null>(null)
  /** Absolute path of a file opened in the shared FileDrawer from the diff view. */
  const [editorTarget, setEditorTarget] = useState<string | null>(null)
  /** Repo root of the file opened in the editor — FileDrawer 用它判断越界保存确认 */
  const [editorWorkspaceRoot, setEditorWorkspaceRoot] = useState<string | null>(null)
  const [drawerHeight, setDrawerHeight] = useState(() => getInitialDrawerHeight('omniterm_git_drawer_height'))
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [logHasMore, setLogHasMore] = useState(false)
  const [logLoading, setLogLoading] = useState(false)
  /** Bumped on every completed status fetch; keeps the open file diff live. */
  const [statusTick, setStatusTick] = useState(0)

  // 拖拽松手才落盘：逐帧写 sessionStorage 会在一次拖拽里写上百次
  const commitDrawerHeight = useCallback((h: number) => {
    sessionStorage.setItem('omniterm_git_drawer_height', String(h))
  }, [])

  // Reset per-repo UI state when the binding changes
  useEffect(() => {
    resetGit()
    setDrawerTarget(null)
    setEditorTarget(null)
    setLog([])
    setLogHasMore(false)
    setMessage('')
    setAmend(false)
    setBranchMenuOpen(false)
    setRenameTarget(null)
    setDeleteTarget(null)
    setDeleteUnmerged(false)
    setStashOpen(false)
    setCommitMenu(null)
    setResetTarget(null)
    setGeneratedMessage(null)
    setGenerating(false)
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

  // AI commit availability: refetch when the panel becomes visible and when
  // Settings closes (the user may have just changed the provider there).
  useEffect(() => {
    if (!visible || settingsOpen) return
    let cancelled = false
    api.getAiCommitConfig()
      .then((cfg) => {
        if (cancelled) return
        setAiCommitReady(
          cfg.provider !== 'off' && cfg.base_url.trim() !== '' && cfg.model.trim() !== '',
        )
      })
      .catch(() => {
        if (!cancelled) setAiCommitReady(false)
      })
    return () => {
      cancelled = true
    }
  }, [visible, settingsOpen])

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

  // History rows: desktop right-click and touch long-press open the same menu.
  const longPressHandlers = useLongPress({
    disabled: !isMobile,
    onLongPress: (point, e) => {
      const sha = (e.target as HTMLElement | null)
        ?.closest('[data-git-sha]')
        ?.getAttribute('data-git-sha')
      if (!sha) return
      longPressAtRef.current = Date.now()
      hapticTap()
      setCommitMenu({ sha, x: point.x, y: point.y })
    },
  })

  const toastError = useCallback((err: unknown) => {
    // Mutation calls are silent — map the refined backend code to localized copy here
    const body = err instanceof ApiError ? (err.body as { code?: string }) : undefined
    const code = KNOWN_ERROR_CODES.find((c) => c === body?.code)
    addToast('error', code ? t(`git.error.${code}`) : (err instanceof Error ? err.message : String(err)))
  }, [addToast, t])

  const runMutation = useCallback(async (
    op: () => Promise<unknown>,
    successMsg?: string,
  ): Promise<boolean> => {
    if (!bind) return false
    try {
      await mutate(bind, op)
      setStatusTick((n) => n + 1)
      if (successMsg) addToast('success', successMsg)
      return true
    } catch (err: unknown) {
      toastError(err)
      return false
    }
  }, [bind, mutate, addToast, toastError])

  const entries = status?.entries ?? []
  const stagedEntries = entries.filter(isStaged)
  const unstagedEntries = entries.filter(isUnstaged)
  const isRepo = status?.is_repo ?? false

  // Amend may rewrite only the message (no staged files required); a plain
  // commit still needs both a message and something staged.
  const canCommit = !mutating && (amend || (message.trim().length > 0 && stagedEntries.length > 0))

  const canGenerate = !mutating && !generating && aiCommitReady && stagedEntries.length > 0

  const handleGenerate = async () => {
    if (!bind || !canGenerate) return
    setGenerating(true)
    try {
      const result = await api.gitGenerateCommitMessage(bind)
      if (message.trim()) {
        // Never discard typed text without an explicit replace/append choice.
        setGeneratedMessage(result.message)
      } else {
        setMessage(result.message)
      }
      addToast('success', t('git.generated'))
      if (result.omitted_files > 0 || result.omitted_chars > 0) {
        addToast('warning', t('git.generatedTruncated', {
          files: result.omitted_files,
          chars: result.omitted_chars,
        }))
      }
    } catch (err) {
      toastError(err)
    } finally {
      setGenerating(false)
    }
  }

  const applyGeneratedMessage = (mode: 'replace' | 'append') => {
    const generated = generatedMessage
    if (!generated) return
    setMessage((prev) =>
      mode === 'append' && prev.trim() ? `${prev.trimEnd()}\n\n${generated}` : generated)
    setGeneratedMessage(null)
  }

  const handleCommit = async (push: boolean) => {
    if (!bind || !canCommit) return
    const hadMessage = message.trim().length > 0
    const committed = await runMutation(
      () => api.gitCommit(bind, message, amend),
      t('git.committed'),
    )
    if (!committed) return
    // Only clear when the commit actually landed (status no longer has those staged rows)
    if (hadMessage && useGitStore.getState().status?.entries?.some(isStaged) === false) setMessage('')
    setAmend(false)
    if (!push) return
    // Commit succeeded; a failed push is reported separately and must not
    // retract the commit success above.
    await runMutation(() => api.gitPush(bind), t('git.pushed'))
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

  const handleRenameBranch = async (newName: string) => {
    const target = renameTarget
    if (!bind || !target) return
    setBranchBusy(true)
    try {
      await mutate(bind, async () => {
        await api.gitRenameBranch(bind, target.name, newName)
        await fetchBranches(bind)
      })
      addToast('success', t('git.renamedBranch', { name: newName }))
      setRenameTarget(null)
    } catch (err) {
      toastError(err)
    } finally {
      setBranchBusy(false)
    }
  }

  const handleDeleteBranch = async (force: boolean, alsoRemote: boolean) => {
    const target = deleteTarget
    if (!bind || !target) return
    setBranchBusy(true)
    try {
      await mutate(bind, async () => {
        await api.gitDeleteBranch(bind, target.name, force)
        await fetchBranches(bind)
      })
    } catch (err) {
      const code = err instanceof ApiError ? (err.body as { code?: string }).code : undefined
      if (code === 'not_merged' && !force) {
        // Keep the dialog open and surface the force checkbox instead of
        // losing the user's intent in a toast.
        setDeleteUnmerged(true)
      }
      toastError(err)
      setBranchBusy(false)
      return
    }
    setDeleteTarget(null)
    setDeleteUnmerged(false)
    addToast('success', t('git.deletedBranch', { name: target.name }))

    if (alsoRemote && target.upstream) {
      const remote = target.upstream.split('/')[0] || 'origin'
      try {
        await mutate(bind, () => api.gitDeleteRemoteBranch(bind, target.name, remote))
        addToast('success', t('git.deletedRemoteBranch', { name: target.upstream }))
      } catch (err) {
        toastError(err)
      }
    }
    setBranchBusy(false)
  }

  const handleCopySha = async (sha: string) => {
    if (await copyText(sha)) addToast('success', t('git.shaCopied'))
  }

  const handleHistoryAction = (sha: string, action: 'cherry-pick' | 'revert') => {
    if (!bind) return
    runMutation(async () => {
      if (action === 'cherry-pick') await api.gitCherryPick(bind, sha)
      else await api.gitRevertCommit(bind, sha)
      await fetchLog(0, false)
    }, t(action === 'cherry-pick' ? 'git.cherryPicked' : 'git.reverted'))
  }

  const openReset = (sha: string, mode: 'soft' | 'mixed') => {
    const entry = log.find((e) => e.sha === sha)
    setResetTarget({ sha, shortSha: entry?.short_sha ?? sha.slice(0, 7), mode })
  }

  const handleReset = () => {
    const target = resetTarget
    if (!bind || !target) return
    setResetTarget(null)
    runMutation(async () => {
      await api.gitReset(bind, target.sha, target.mode)
      await fetchLog(0, false)
    }, t('git.resetDone', { sha: target.shortSha }))
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
                  <div key={b.name} className="git-branch-row">
                    <button
                      className={`git-branch-item ${b.current ? 'active' : ''}`}
                      title={b.upstream ? `${b.name} → ${b.upstream}` : b.name}
                      onClick={() => { if (!b.current) handleCheckout(b.name) }}
                    >
                      {b.current ? '● ' : ''}{b.name}
                    </button>
                    <span className="git-branch-actions">
                      <button
                        className="git-row-btn"
                        disabled={mutating || branchBusy}
                        title={t('git.renameBranch')}
                        onClick={() => {
                          setBranchMenuOpen(false)
                          setRenameTarget(b)
                        }}
                      >
                        <IconPencil width={12} height={12} />
                      </button>
                      {!b.current && (
                        <button
                          className="git-row-btn git-row-btn-danger"
                          disabled={mutating || branchBusy}
                          title={t('git.deleteBranch')}
                          onClick={() => {
                            setBranchMenuOpen(false)
                            setDeleteUnmerged(false)
                            setDeleteTarget(b)
                          }}
                        >
                          <IconTrash width={12} height={12} />
                        </button>
                      )}
                    </span>
                  </div>
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
        <button
          className={`git-view-tab ${view === 'changes' ? 'active' : ''}`}
          onClick={() => {
            setView('changes')
            setCommitMenu(null)
          }}
        >
          {t('git.changesTab')}
          {entries.length > 0 && <span className="git-count-badge">{entries.length}</span>}
        </button>
        <button
          className={`git-view-tab ${view === 'history' ? 'active' : ''}`}
          onClick={() => {
            setView('history')
            setCommitMenu(null)
          }}
        >
          {t('git.historyTab')}
        </button>
        <span className="title-bar-spacer" />
        <button className="git-btn" onClick={() => setStashOpen(true)} title={t('git.stashTitle')}>
          {t('git.stashBtn')}
        </button>
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
              className="git-commit-input overlay-scroll-content"
              placeholder={t('git.commitPlaceholder')}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void handleCommit(false)
              }}
            />
            <div className="git-commit-tools">
              <label className="git-commit-amend">
                <input
                  type="checkbox"
                  className="fm-checkbox"
                  style={{ accentColor: 'var(--warning)', flexShrink: 0 }}
                  checked={amend}
                  disabled={mutating}
                  onChange={(e) => setAmend(e.target.checked)}
                />
                <span className="font-pixel" style={{ fontSize: 11, letterSpacing: 'var(--pixel-tracking-sm)' }}>
                  {t('git.amendBtn')}
                </span>
                {amend && <span className="git-commit-amend-hint">{t('git.amendHint')}</span>}
              </label>
              <button
                className="git-btn git-generate-btn"
                disabled={!canGenerate}
                onClick={() => void handleGenerate()}
                title={
                  !aiCommitReady
                    ? t('git.generateNeedsConfig')
                    : stagedEntries.length === 0
                      ? t('git.generateNeedsStaged')
                      : t('git.generateTitle')
                }
              >
                {generating ? t('git.generating') : t('git.generate')}
              </button>
            </div>
            <div className="git-commit-actions">
              <button
                className="git-commit-btn"
                disabled={!canCommit}
                onClick={() => void handleCommit(false)}
                title={!amend && stagedEntries.length === 0 ? t('git.nothingStaged') : undefined}
              >
                {t('git.commitBtn', { count: stagedEntries.length })}
              </button>
              <button
                className="git-commit-btn"
                disabled={!canCommit}
                onClick={() => void handleCommit(true)}
                title={!amend && stagedEntries.length === 0 ? t('git.nothingStaged') : undefined}
              >
                {t('git.commitPushBtn')}
              </button>
            </div>
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
                  data-git-sha={entry.sha}
                  {...longPressHandlers}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setCommitMenu({ sha: entry.sha, x: e.clientX, y: e.clientY })
                  }}
                  onClick={() => {
                    // Suppress the click browsers emit after a long-press.
                    if (Date.now() - longPressAtRef.current < LONG_PRESS_CLICK_SUPPRESS_MS) return
                    setDrawerTarget({ kind: 'commit', sha: entry.sha })
                  }}
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
          onHeightCommit={commitDrawerHeight}
          refreshTick={statusTick}
          onOpenInEditor={(absolutePath, repoRoot) => {
            setDrawerTarget(null)
            setEditorTarget(absolutePath)
            setEditorWorkspaceRoot(repoRoot)
          }}
        />
      )}

      {editorTarget && (
        <FileDrawer
          filePath={editorTarget}
          sessionId={bind.session}
          workspaceId={bind.workspaceId}
          projectId={bind.projectId}
          workspaceRoot={editorWorkspaceRoot ?? undefined}
          onClose={() => setEditorTarget(null)}
          height={drawerHeight}
          onHeightChange={setDrawerHeight}
          onHeightCommit={commitDrawerHeight}
          fileChangeEvent={null}
        />
      )}

      <GeneratedMessageDialog
        message={generatedMessage}
        onClose={() => setGeneratedMessage(null)}
        onApply={applyGeneratedMessage}
      />

      <StashPanel
        open={stashOpen}
        bind={bind}
        hasChanges={entries.length > 0}
        busy={mutating}
        onClose={() => setStashOpen(false)}
        onChanged={() => setStatusTick((n) => n + 1)}
        runOp={runMutation}
      />

      <ContextMenu
        point={commitMenu ? { x: commitMenu.x, y: commitMenu.y } : null}
        onClose={() => setCommitMenu(null)}
        minWidth={220}
        items={commitMenu ? [
          {
            id: 'copy',
            icon: <IconCopy width={14} height={14} />,
            label: t('git.copySha'),
            run: () => handleCopySha(commitMenu.sha),
          },
          {
            id: 'cherry-pick',
            icon: <IconGitBranch width={14} height={14} />,
            label: t('git.cherryPick'),
            run: () => handleHistoryAction(commitMenu.sha, 'cherry-pick'),
          },
          {
            id: 'revert',
            icon: <IconRefresh width={14} height={14} />,
            label: t('git.revertCommit'),
            run: () => handleHistoryAction(commitMenu.sha, 'revert'),
          },
          {
            id: 'reset-soft',
            icon: <IconArrowDown width={14} height={14} />,
            label: t('git.resetSoft'),
            danger: true,
            run: () => openReset(commitMenu.sha, 'soft'),
          },
          {
            id: 'reset-mixed',
            icon: <IconArrowDown width={14} height={14} />,
            label: t('git.resetMixed'),
            danger: true,
            run: () => openReset(commitMenu.sha, 'mixed'),
          },
        ] : []}
      />

      <ConfirmDialog
        open={resetTarget !== null}
        onClose={() => setResetTarget(null)}
        onConfirm={handleReset}
        title={t('git.resetTitle')}
        message={t('git.resetConfirm', {
          sha: resetTarget?.shortSha ?? '',
          mode: resetTarget?.mode ?? '',
        })}
        confirmText={t('git.resetAction')}
        destructive
      />

      <BranchRenameDialog
        target={renameTarget}
        busy={branchBusy}
        onClose={() => setRenameTarget(null)}
        onConfirm={handleRenameBranch}
      />
      <BranchDeleteDialog
        target={deleteTarget}
        unmerged={deleteUnmerged}
        busy={branchBusy}
        onClose={() => {
          setDeleteTarget(null)
          setDeleteUnmerged(false)
        }}
        onConfirm={handleDeleteBranch}
      />
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
          {/* 容器 direction:rtl 只为左侧省略号；bdi 隔离避免前导 . 等中性字符被 bidi 重排 */}
          <span className="git-file-path" title={e.orig_path ? `${e.orig_path} → ${e.path}` : e.path}>
            <bdi dir="ltr">{e.path}</bdi>
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
