import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useAttention, type AttentionReason } from '../../hooks/useAttention'
import { api } from '../../api/client'
import { BookIcon } from '../Icons/BookIcon'
import { IconPlus, IconSettings } from '../FileManager/icons'
import { GitHubIcon } from '../Icons/GitHubIcon'
import type { DuplicateGroup, Project, Workspace } from '../../api/client'
import { type AcpActivity } from '../../utils/agentAggregate'
import { APP_VERSION, GITHUB_REPO_URL } from '../../version'
import { DuplicateProjectsDialog } from './DuplicateProjectsDialog'
import { UpdateBadge } from './UpdateBadge'
import { ProjectCard } from './ProjectCard'
import { RenameDialog, type RenameTarget } from './RenameDialog'
import { DeleteConfirmDialog, type DeleteTarget } from './DeleteConfirmDialog'
import { DeleteWorktreeDialog, type DeleteWorktreeTarget } from './DeleteWorktreeDialog'
import { ReleaseConfirmDialog, type ReleaseTarget } from './ReleaseConfirmDialog'
import { RepairPathDialog, type RepairTarget } from './RepairPathDialog'
import { CreateSessionModal } from './CreateSessionModal'
import { CreateProjectModal } from './CreateProjectModal'
import { CreateWorktreeModal } from './CreateWorktreeModal'
import { ExternalSessionsSection } from './ExternalSessionsSection'
import { OmniTermLogo } from '../PixelUI/OmniTermLogo'
import { CountBadge } from '../Common/CountBadge'
import { SignalBarsSprite } from '../PixelUI'
import { READER_FONT } from '../../utils/fonts'


function SidebarBottomButton({
  toggle,
  icon,
  title,
  onClick,
  size = 26,
  className = '',
}: {
  toggle: string
  icon: ReactNode
  title: string
  onClick: () => void
  size?: number
  className?: string
}) {
  return (
    <button
      data-toggle={toggle}
      onClick={onClick}
      className={`row-action flex items-center justify-center transition-all ${className}`}
      style={{
        width: size,
        height: size,
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'var(--border-strong)',
        color: 'var(--text-faint)',
        fontSize: 14,
      }}
      title={title}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--accent)'
        e.currentTarget.style.color = 'var(--accent)'
        e.currentTarget.style.background = 'var(--accent-10)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-strong)'
        e.currentTarget.style.color = 'var(--text-faint)'
        e.currentTarget.style.background = 'transparent'
      }}
    >
      {icon}
    </button>
  )
}

export function Sidebar() {
  const {
    projects,
    worktrees,
    sessions,
    activeProjectId,
    activeWorkspaceId,
    activeSessionId,
    sidebarCollapsed,
    connected,
    setProjects,
    setWorktrees,
    setSessions,
    setActiveProject,
    setActiveWorkspace,
    setActiveSession,
    setActiveExternalSession,
    setConnected,
    workspaceSessionMemory,
    clearWorkspaceSession,
  } = useAppStore()

  const toggleSidebarCollapsed = useAppStore((s) => s.toggleSidebarCollapsed)
  const setMultiplexer = useAppStore((s) => s.setMultiplexer)
  const toggleSettings = useAppStore((s) => s.toggleSettings)
  const toggleTmuxCheatsheet = useAppStore((s) => s.toggleTmuxCheatsheet)

  const addToast = useToastStore((s) => s.addToast)
  const { t } = useTranslation()
  const attention = useAttention()

  // ACP 会话活动状态（chatStore 派生）：与 tmux 屏幕检测的 agent_state 归一，
  // 使两类会话的 Sidebar 状态点/聚合徽标表现一致。useShallow 保证仅在
  // waiting/running 归属变化时重渲染（流式 chunk 不触发）。
  const acpActivityMap = useChatStore(
    useShallow((s) => {
      const m: Record<string, AcpActivity> = {}
      for (const [id, st] of Object.entries(s.states)) {
        if (st.pendingPermission) m[id] = 'waiting'
        else if (st.sending) m[id] = 'running'
      }
      return m
    }),
  )
  const acpActivityFor = useCallback(
    (sessionId: string): AcpActivity | undefined => acpActivityMap[sessionId],
    [acpActivityMap],
  )

  // Terminal button pulse: only when session exists and browsing outside its CWD


  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [createProjOpen, setCreateProjOpen] = useState(false)
  const [createSessWorkspaceId, setCreateSessWorkspaceId] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget | null>(null)
  const [confirmRelease, setConfirmRelease] = useState<ReleaseTarget | null>(null)

  const [homeDir, setHomeDir] = useState('')

  // Create worktree modal switch（保存目标项目 id；null = 关闭）。
  // 表单/分支列表/git-init 确认等状态均由 CreateWorktreeModal 自持。
  const [createWtProjectId, setCreateWtProjectId] = useState<string | null>(null)

  // Delete worktree confirmation dialog
  const [confirmDeleteWt, setConfirmDeleteWt] = useState<DeleteWorktreeTarget | null>(null)

  // Repair project path dialog — shown when user clicks a workspace whose
  // path no longer exists on disk. Lets them browse to the new location.
  // 表单/目录浏览等状态均由 RepairPathDialog 自持；null = 关闭。
  const [repairTarget, setRepairTarget] = useState<RepairTarget | null>(null)

  // Groups of legacy duplicate projects (e.g. before the coverage check
  // existed, the user may have added the same repo twice).
  const [duplicates, setDuplicates] = useState<DuplicateGroup[]>([])
  const [duplicateDialogOpen, setDuplicateDialogOpen] = useState(false)
  const [duplicatesDismissed, setDuplicatesDismissed] = useState(false)
  // Agent enable button state — commented out pending notification scheme decision.
  // See docs/requirements.md "Agent 状态监控与通知".
  // const [enablingSessionId, setEnablingSessionId] = useState<string | null>(null)
  // const [tooltipSessionId, setTooltipSessionId] = useState<string | null>(null)
  // const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load projects. `projectsLoaded` distinguishes "fetched but empty" from
  // "not yet fetched" so the restore effects below can clean up stale saved
  // IDs even when the server has zero projects (e.g. after a DB reset).
  const [projectsLoaded, setProjectsLoaded] = useState(false)
  const loadProjects = useCallback(async () => {
    try {
      const p = await api.listProjects()
      setProjects(p)
      setProjectsLoaded(true)
    } catch {
      // api client already shows error toast
    }
  }, [setProjects])

  // Load worktrees for a project
  const loadWorktrees = useCallback(async (projectId: string) => {
    try {
      const wt = await api.listWorktrees(projectId)
      setWorktrees(projectId, wt)
    } catch {
      // api client already shows error toast
    }
  }, [setWorktrees])

  // Load sessions for a project. Defaults to activeProjectId so existing
  // callers (create/rename/delete, polling) work unchanged. Pass an explicit
  // projectId to load on demand (e.g. when expanding a project to show
  // per-worktree session counts before any worktree is activated).
  const loadSessions = useCallback(async (projectId?: string) => {
    const pid = projectId ?? activeProjectId
    if (!pid) return
    try {
      const s = await api.listSessions(pid)
      setSessions(pid, s)
    } catch {
      // api client already shows error toast
    }
  }, [activeProjectId, setSessions])

  useEffect(() => { loadProjects() }, [loadProjects])
  useEffect(() => { loadSessions() }, [loadSessions])

  // Check for legacy duplicate projects (created before the coverage check).
  // Surface a banner; the user can open the merge dialog to consolidate.
  const loadDuplicates = useCallback(async () => {
    try {
      const groups = await api.listDuplicates()
      setDuplicates(groups)
    } catch {
      // Quietly ignore — duplicate detection is non-critical
    }
  }, [])
  useEffect(() => { loadDuplicates() }, [loadDuplicates])

  // ── Restore active state from localStorage on page load ──
  // Use refs so each step fires exactly once when its data first arrives,
  // regardless of whether appStore already read the saved IDs on init.
  const restoredProjectRef = useRef(false)
  const restoredWorkspaceRef = useRef(false)
  const restoredSessionRef = useRef(false)

  // After projects load, expand the saved project and load its data.
  // A saved ID no longer on the server (deleted project / DB reset) is
  // cleared together with its dependent workspace/session so consumers
  // (FileManager, chat) stop requesting nonexistent resources (404s).
  useEffect(() => {
    if (restoredProjectRef.current || !projectsLoaded) return
    const savedProjectId = localStorage.getItem('omniterm_active_project')
    if (savedProjectId) {
      if (projects.some(p => p.id === savedProjectId)) {
        setExpandedProjects(prev => {
          const next = new Set(prev)
          next.add(savedProjectId)
          return next
        })
        setActiveProject(savedProjectId)
        loadWorktrees(savedProjectId)
        // loadSessions fires via its own useEffect when activeProjectId changes
      } else {
        setActiveProject(null)
        setActiveWorkspace(null)
        setActiveSession(null)
      }
    }
    restoredProjectRef.current = true
  }, [projectsLoaded, projects, setActiveProject, setActiveWorkspace, setActiveSession, loadWorktrees])

  // After worktrees load, restore the active workspace (or clean up stale saved ID).
  useEffect(() => {
    if (!activeProjectId) return
    const wtList = worktrees[activeProjectId]
    if (!wtList) return // not yet fetched for this project
    const savedWorkspaceId = localStorage.getItem('omniterm_active_workspace')
    if (!savedWorkspaceId) {
      restoredWorkspaceRef.current = true
      return
    }
    if (restoredWorkspaceRef.current) return
    if (wtList.some(w => w.id === savedWorkspaceId)) {
      if (activeWorkspaceId !== savedWorkspaceId) setActiveWorkspace(savedWorkspaceId)
    } else {
      setActiveWorkspace(null)
    }
    restoredWorkspaceRef.current = true
  }, [worktrees, activeProjectId, activeWorkspaceId, setActiveWorkspace])

  // After sessions load, restore the active session (or clean up stale saved ID).
  useEffect(() => {
    if (restoredSessionRef.current || !activeProjectId) return
    if (!sessions[activeProjectId]) return // not yet fetched for this project
    const savedSessionId = localStorage.getItem('omniterm_active_session')
    if (savedSessionId) {
      const allSessions = Object.values(sessions).flat()
      if (allSessions.some(s => s.id === savedSessionId)) {
        if (activeSessionId !== savedSessionId) setActiveSession(savedSessionId)
      } else {
        setActiveSession(null)
      }
    }
    restoredSessionRef.current = true
  }, [sessions, activeProjectId, activeSessionId, setActiveSession])

  // Prune workspaceSessionMemory entries pointing at sessions that no longer
  // exist server-side (deleted session / DB reset). Scoped to the active
  // project's workspaces — only its session list is loaded, so entries for
  // other projects can't be judged and are left untouched.
  useEffect(() => {
    if (!activeProjectId) return
    const sessList = sessions[activeProjectId]
    const wtList = worktrees[activeProjectId]
    if (!sessList || !wtList) return
    const ids = new Set(sessList.map(s => s.id))
    for (const wt of wtList) {
      const remembered = workspaceSessionMemory[wt.id]
      if (remembered && !ids.has(remembered)) clearWorkspaceSession(wt.id)
    }
  }, [sessions, worktrees, activeProjectId, workspaceSessionMemory, clearWorkspaceSession])

  // ── Smart diff: session polling + attention detection ──
  const lastAgentEventRef = useRef<Map<string, string>>(new Map())
  const decisionCandidatesRef = useRef<Set<string>>(new Set())
  const firedWaitingRef = useRef<Set<string>>(new Set())
  const prevAgentStateRef = useRef<Map<string, string>>(new Map())

  useEffect(() => {
    // 每 3 秒轮询：服务 **tmux** 会话的 agent_state / attention_reason 检测
    // （tmux 无 WS 推送，仍需轮询）。注意：ACP 会话的 `acp_process_alive`
    // 已由后端 WS 的 `process_alive` 事件驱动即时更新（见 useAcpChat），
    // 不再依赖本轮询回流；轮询整体覆盖时 ACP 的 alive 值与推送最终一致，无副作用。
    const interval = setInterval(async () => {
      if (!activeProjectId) return
      try {
        const freshSessions = await api.listSessions(activeProjectId)
        const currentSessionKeys = new Set<string>()

        for (const s of freshSessions) {
          const sessionKey = s.id
          currentSessionKeys.add(sessionKey)

          // Build event key from agent state fields
          const eventKey = [
            s.agent_kind ?? '',
            s.agent_state ?? '',
            s.attention_reason ?? '',
            s.agent_event ?? '',
            s.agent_nonce ?? '',
          ].join(':')

          const lastKey = lastAgentEventRef.current.get(sessionKey)
          if (eventKey && eventKey !== lastKey) {
            lastAgentEventRef.current.set(sessionKey, eventKey)

            const state = s.agent_state
            const reason = s.attention_reason as AttentionReason | undefined
            const prevState = prevAgentStateRef.current.get(sessionKey)

            if (state === 'idle' && reason === 'done') {
              // Done — fire immediately
              attention.fire(s.id, sessionKey, 'done')
            } else if (state === 'idle' && reason === 'error') {
              // Error — fire immediately
              attention.fire(s.id, sessionKey, 'error')
            } else if (state === 'idle' && !reason && prevState === 'running') {
              // 屏幕检测：running → idle 转变即完成（done = idle + 未查看，
              // 查看会话时 AttentionProvider.setActive 清除）
              attention.fire(s.id, sessionKey, 'done')
            } else if (state === 'running') {
              // Running — clear any alert
              attention.clearAlert(sessionKey)
            }
          }

          // Decision debounce（eventKey 不变也要推进：屏幕检测的 waiting 无 nonce 变化）：
          // 连续两轮 waiting 才告警；每个 waiting 周期只告警一次
          if (s.agent_state === 'waiting') {
            if (!firedWaitingRef.current.has(sessionKey)) {
              if (decisionCandidatesRef.current.has(sessionKey)) {
                attention.fire(s.id, sessionKey, 'decision')
                decisionCandidatesRef.current.delete(sessionKey)
                firedWaitingRef.current.add(sessionKey)
              } else {
                decisionCandidatesRef.current.add(sessionKey)
              }
            }
          } else {
            decisionCandidatesRef.current.delete(sessionKey)
            firedWaitingRef.current.delete(sessionKey)
          }

          if (s.agent_state) {
            prevAgentStateRef.current.set(sessionKey, s.agent_state)
          }
        }

        // Clear alerts for sessions that disappeared
        for (const key of lastAgentEventRef.current.keys()) {
          if (!currentSessionKeys.has(key)) {
            attention.clearAlert(key)
            lastAgentEventRef.current.delete(key)
            decisionCandidatesRef.current.delete(key)
            firedWaitingRef.current.delete(key)
            prevAgentStateRef.current.delete(key)
          }
        }

        setSessions(activeProjectId, freshSessions)
      } catch {
        // Quietly ignore poll errors
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [activeProjectId, setSessions, attention])

  useEffect(() => {
    api.systemInfo().then((info) => {
      setHomeDir(info.home_dir)
      if (info.multiplexer) setMultiplexer(info.multiplexer)
    }).catch(() => {
      // fallback: leave homeDir empty, user fills the path in manually
    })
  }, [setMultiplexer])

  // Health polling
  useEffect(() => {
    const check = () => api.health().then(() => setConnected(true)).catch(() => setConnected(false))
    check()
    const id = setInterval(check, 5000)
    return () => clearInterval(id)
  }, [setConnected])

  // Cleanup tooltip timeout on unmount — commented out pending notification scheme decision.
  // useEffect(() => {
  //   return () => {
  //     if (tooltipTimeoutRef.current) {
  //       clearTimeout(tooltipTimeoutRef.current)
  //     }
  //   }
  // }, [])

  // Toggle project expansion
  const toggleProject = (projectId: string) => {
    const newSet = new Set(expandedProjects)
    if (newSet.has(projectId)) {
      newSet.delete(projectId)
    } else {
      newSet.add(projectId)
      // Fire-and-forget：展开立即生效，不等网络往返（Windows 上 git spawn 慢，
      // await 会让展开卡 100ms+）。未加载时渲染侧显示 loading 占位。
      void Promise.all([loadWorktrees(projectId), loadSessions(projectId)])
    }
    setExpandedProjects(newSet)
  }

  const handleWorkspaceClick = async (proj: Project, wt: Workspace) => {
    // Check if the workspace path exists on disk
    try {
      const { exists } = await api.pathExists(wt.path)
      if (!exists) {
        setRepairTarget({ project: proj, workspace: wt, oldPath: proj.path })
        return
      }
    } catch {
      // If the API call fails, proceed normally (don't block the user)
    }
    // Path exists — activate normally
    setActiveProject(proj.id)
    setActiveExternalSession(null)
    // Restore last-used session for this workspace, if remembered
    if (wt.id !== activeWorkspaceId) {
      const rememberedId = workspaceSessionMemory[wt.id]
      const wtSessions = (sessions[proj.id] || []).filter(
        (s) => s.workspace_path === wt.path
      )
      if (rememberedId && wtSessions.some((s) => s.id === rememberedId)) {
        setActiveSession(rememberedId)
      } else {
        setActiveSession(null)
      }
    }
    setActiveWorkspace(wt.id === activeWorkspaceId ? null : wt.id)
  }

  // Agent enable handler — commented out pending notification scheme decision.
  // const handleHookEnable = useCallback(async (sessionId: string) => {
  //   setEnablingSessionId(sessionId)
  //   try {
  //     await api.hookEnable(sessionId)
  //     addToast('success', 'Agent 监控已启用')
  //     await loadSessions()
  //   } catch {
  //     addToast('error', '启用 Agent 监控失败')
  //   } finally {
  //     setEnablingSessionId(null)
  //   }
  // }, [loadSessions, addToast])

  // 手动释放 ACP agent 子进程（保留会话记录，进程可后续恢复）。
  // 区别于删除：不删 DB 记录，仅 kill supervisor 中驻留的 codebuddy --acp 等进程。
  const releaseSessionNow = async (id: string) => {
    try {
      await api.releaseSession(id)
      await loadSessions()
      // 若释放的正是当前聚焦的会话，立即标记结束，使 ChatView 即时显示
      // 「恢复会话」按钮，无需等待列表轮询或刷新页面。
      if (id === activeSessionId) {
        useChatStore.getState().markEnded(id)
      }
      addToast('success', t('sidebar.sessionReleased') ?? `Session process released`)
    } catch {
      // api client already shows error toast
    }
  }

  if (sidebarCollapsed) {
    return (
      <div
        className="h-full flex flex-col items-center relative"
        style={{ background: 'var(--bg-base)', fontFamily: READER_FONT, color: 'var(--text-primary)', width: 40 }}
      >
        <button
          onClick={toggleSidebarCollapsed}
          className="flex items-center justify-center rounded-md transition-all mt-3"
          style={{ width: 24, height: 24, color: 'var(--text-faint)', fontSize: 14 }}
          title={t('sidebar.expand')}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; e.currentTarget.style.background = 'transparent' }}
        >
          ▶
        </button>

        <div className="flex-1 flex items-center justify-center">
          <button
            onClick={toggleSidebarCollapsed}
            className="flex items-center justify-center rounded-md transition-all"
            style={{ width: 28, height: 28, color: 'var(--text-faint)', fontSize: 14 }}
            title={t('sidebar.expand')}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; e.currentTarget.style.background = 'transparent' }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <rect x="1" y="2" width="6" height="12" rx="1" />
              <rect x="9" y="2" width="6" height="12" rx="1" />
              <line x1="4" y1="5" x2="4" y2="5" strokeWidth="2" />
            </svg>
          </button>
        </div>

        <SidebarBottomButton
          toggle="tmux-cheatsheet"
          icon={<BookIcon width={16} height={16} />}
          title={t('tmuxCheatsheet.title')}
          onClick={toggleTmuxCheatsheet}
          size={28}
          className="mb-2"
        />
        <SidebarBottomButton
          toggle="settings"
          icon={<IconSettings width={16} height={16} />}
          title={t('settings.title')}
          onClick={toggleSettings}
          size={28}
          className="mb-3"
        />
      </div>
    )
  }

  return (
    <div
      className="h-full flex flex-col text-base relative"
      style={{ background: 'var(--bg-base)', fontFamily: READER_FONT, color: 'var(--text-primary)' }}
    >
      {/* Header — logo title bar */}
      <div className="logo-title-bar">
        <OmniTermLogo size={48} />
        <div style={{ flex: 1, minWidth: 0, lineHeight: 1.1 }}>
          <div className="logo-wordmark">OmniTerm</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className="logo-version">v{APP_VERSION}</div>
            <UpdateBadge />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={toggleSidebarCollapsed}
            className="flex items-center justify-center rounded-md transition-all"
            style={{ width: 24, height: 24, color: '#FAF2DE', fontSize: 14 }}
            title={t('sidebar.collapse')}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#FAF2DE'; e.currentTarget.style.background = 'transparent' }}
          >
            ◀
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-2.5 pt-4 pb-16 overlay-scroll-content">
        {/* Duplicate projects banner — surfaces legacy data that should
            be consolidated. Click to open the merge dialog. */}
        {duplicates.length > 0 && !duplicatesDismissed && (
          <div
            data-testid="dup-banner"
            onClick={(e) => {
              // Dismiss if the user clicked the ✕ (or its icon descendant);
              // otherwise open the merge dialog.
              if ((e.target as HTMLElement).closest('[data-dup-dismiss]')) {
                setDuplicatesDismissed(true)
              } else {
                setDuplicateDialogOpen(true)
              }
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setDuplicateDialogOpen(true) }}
            className="w-full mb-3 px-3 py-2 rounded-lg text-left transition-all flex items-center gap-2 cursor-pointer"
            style={{
              background: 'rgba(251, 191, 36, 0.08)',
              border: '1px solid rgba(251, 191, 36, 0.3)',
              color: 'var(--text-primary)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(251, 191, 36, 0.14)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(251, 191, 36, 0.08)' }}
            title={t('sidebar.dupBannerTitle') ?? 'Click to reconcile duplicate projects'}
          >
            <span style={{ fontSize: 14, color: 'var(--warning)' }}>⚠</span>
            <span style={{ fontSize: 12, flex: 1 }}>
              {t('sidebar.dupBanner', { n: duplicates.length }) ??
                `Detected ${duplicates.length} group${duplicates.length === 1 ? '' : 's'} of duplicate projects. Click to merge.`}
            </span>
            <button
              data-dup-dismiss
              style={{ fontSize: 14, color: 'var(--text-dim)', padding: '0 4px', background: 'transparent', border: 'none', cursor: 'pointer' }}
              title={t('sidebar.dupDismiss') ?? 'Dismiss'}
            >
              ✕
            </button>
          </div>
        )}

        {/* Agent onboarding banner — commented out pending notification scheme decision.
        <AgentOnboardingBanner sessions={sessions} />
        */}

        {/* Section label — Projects */}
        <div className="panel-title-bar mb-2.5">
          <span>◆</span>
          <span>{t('sidebar.projects') ?? 'Projects'}</span>
          <CountBadge count={projects.length} />
          <span className="title-bar-spacer" />
          <button
            onClick={() => setCreateProjOpen(true)}
            className="sidebar-proj-add-btn"
            title={t('sidebar.createProject') ?? 'Create Project'}
          >
            <IconPlus strokeWidth={2.25} />
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="px-2 py-3" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            {t('sidebar.noProjects') ?? 'No projects yet'}
          </div>
        ) : (
          projects.map((proj) => (
            <ProjectCard
              key={proj.id}
              project={proj}
              isExpanded={expandedProjects.has(proj.id)}
              worktrees={worktrees[proj.id]}
              sessions={sessions[proj.id] || []}
              activeWorkspaceId={activeWorkspaceId}
              activeSessionId={activeSessionId}
              acpActivityFor={acpActivityFor}
              onToggle={() => toggleProject(proj.id)}
              onOpenCreateWorktree={() => {
                if (!expandedProjects.has(proj.id)) {
                  setExpandedProjects(prev => { const next = new Set(prev); next.add(proj.id); return next })
                  void Promise.all([loadWorktrees(proj.id), loadSessions(proj.id)])
                }
                setCreateWtProjectId(proj.id)
              }}
              onRename={setRenameTarget}
              onDeleteProject={() => setConfirmDelete({ type: 'project', id: proj.id, name: proj.name })}
              onWorkspaceClick={(wt) => handleWorkspaceClick(proj, wt)}
              onOpenCreateSession={(wt) => {
                setActiveProject(proj.id)
                setActiveWorkspace(wt.id)
                setCreateSessWorkspaceId(wt.id)
              }}
              onDeleteWorktree={setConfirmDeleteWt}
              onDeleteSession={setConfirmDelete}
              onReleaseRequest={(s) => {
                const chatState = useChatStore.getState().states[s.id]
                if (chatState?.sending) setConfirmRelease({ id: s.id, name: s.name ?? null })
                else releaseSessionNow(s.id)
              }}
            />
          ))
        )}

        {/* External Sessions — tmux sessions not yet adopted into any project */}
        <ExternalSessionsSection reloadSessions={loadSessions} />
      </div>

      {/* Bottom status bar */}
      <div
        className="absolute bottom-0 left-0 right-0 px-3.5 py-3 flex items-center justify-between"
        style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-base)' }}
      >
        <div
          className="flex items-center gap-1.5 status-badge-3d"
          style={{
            padding: '2px 6px',
            background: 'var(--wood-shadow, #3A2E1F)',
            flexShrink: 0,
          }}
        >
          <SignalBarsSprite size={14} connected={connected} />
          <span
            className="font-pixel"
            style={{
              fontSize: 13,
              letterSpacing: 'var(--pixel-tracking-md)',
              color: connected ? '#7EE787' : '#FF7B72',
              whiteSpace: 'nowrap',
            }}
          >
            {connected ? t('sidebar.link') : t('sidebar.lost')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SidebarBottomButton
            toggle="tmux-cheatsheet"
            icon={<BookIcon width={16} height={16} />}
            title={t('tmuxCheatsheet.title')}
            onClick={toggleTmuxCheatsheet}
            size={26}
          />
          <SidebarBottomButton
            toggle="settings"
            icon={<IconSettings width={16} height={16} />}
            title={t('settings.title')}
            onClick={toggleSettings}
            size={26}
          />
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center transition-all"
            style={{
              width: 26,
              height: 26,
              borderWidth: '1px',
              borderStyle: 'solid',
              borderColor: 'var(--border-strong)',
              color: 'var(--text-faint)',
              fontSize: 14,
            }}
            title={t('sidebar.githubRepo')}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)'
              e.currentTarget.style.color = 'var(--accent)'
              e.currentTarget.style.background = 'var(--accent-10)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-strong)'
              e.currentTarget.style.color = 'var(--text-faint)'
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <GitHubIcon size={16} />
          </a>
        </div>
      </div>

      {/* ── Create Project Modal ── */}
      <CreateProjectModal
        open={createProjOpen}
        homeDir={homeDir}
        onClose={() => setCreateProjOpen(false)}
        reloadProjects={loadProjects}
      />

      {/* ── Create Session Modal ── */}
      <CreateSessionModal
        workspaceId={createSessWorkspaceId}
        onClose={() => setCreateSessWorkspaceId(null)}
        reloadSessions={loadSessions}
      />

      {/* ── Create Worktree Modal ── */}
      <CreateWorktreeModal
        projectId={createWtProjectId}
        onClose={() => setCreateWtProjectId(null)}
        reloadWorktrees={loadWorktrees}
      />

      {/* ── Rename Modal (Project or Session, reused) ── */}
      <RenameDialog
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
        onRenamed={(type) => (type === 'project' ? loadProjects() : loadSessions())}
      />

      {/* ── Delete Confirmation Dialog ── */}
      <DeleteConfirmDialog
        target={confirmDelete}
        onClose={() => setConfirmDelete(null)}
        reloadProjects={loadProjects}
        reloadSessions={loadSessions}
      />

      {/* ── Delete Worktree Confirmation Dialog ── */}
      <DeleteWorktreeDialog
        target={confirmDeleteWt}
        onClose={() => setConfirmDeleteWt(null)}
        reloadWorktrees={loadWorktrees}
      />

      {/* ── Release Confirmation Dialog ── */}
      <ReleaseConfirmDialog
        target={confirmRelease}
        onClose={() => setConfirmRelease(null)}
        onRelease={releaseSessionNow}
      />

      {/* ── Repair Project Path Modal: shown when user clicks a workspace whose path no longer exists. */}
      <RepairPathDialog
        target={repairTarget}
        onClose={() => setRepairTarget(null)}
        onRepaired={(pid) => Promise.all([loadProjects(), loadWorktrees(pid), loadSessions(pid)]).then(() => {})}
      />

      {/* ── Legacy Duplicate Projects Reconciliation Dialog ── */}
      <DuplicateProjectsDialog
        open={duplicateDialogOpen}
        groups={duplicates}
        onClose={() => setDuplicateDialogOpen(false)}
        onResolved={() => {
          setDuplicateDialogOpen(false)
          setDuplicates([])
          setDuplicatesDismissed(false)
          loadProjects()
          loadSessions()
        }}
      />
    </div>
  )
}

/**
 * AgentOnboardingBanner — shown at the top of the sidebar when
 * an agent (Claude Code / Codex) is detected in any session.
 * Disappears when user clicks ✕ (persisted in localStorage).
 *
 * COMMENTED OUT pending notification scheme decision.
 * See docs/requirements.md "Agent 状态监控与通知".
 */
/*
function AgentOnboardingBanner({ sessions }: { sessions: Session[] }) {
  const [dismissed, setDismissed] = useState(() => {
    return localStorage.getItem('omniterm_onboarding_agent_done') === 'true'
  })

  const hasAgentSession = sessions.some(s => s.agent_detected != null)

  if (dismissed || !hasAgentSession) return null

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 mx-1 mb-2 rounded-md"
      style={{
        background: 'rgba(167, 139, 250, 0.1)',
        border: '1px solid rgba(167, 139, 250, 0.2)',
        fontSize: 11,
        color: 'var(--text-secondary)',
      }}
    >
      <span className="flex-shrink-0" style={{ color: 'var(--accent)', fontSize: 13, display: 'flex', alignItems: 'center' }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="7" cy="7" r="5" />
          <line x1="11" y1="11" x2="14" y2="14" />
        </svg>
      </span>
      <span className="flex-1">
        检测到 AI Agent — 开启 Agent 监控，实时掌握运行状态、接收决策提醒
      </span>
      <button
        onClick={() => {
          localStorage.setItem('omniterm_onboarding_agent_done', 'true')
          setDismissed(true)
        }}
        className="flex-shrink-0 flex items-center justify-center rounded transition-all"
        style={{
          width: 18,
          height: 18,
          borderWidth: '1px',
          borderStyle: 'solid',
          borderColor: 'var(--border-strong)',
          color: 'var(--text-faint)',
          fontSize: 10,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = 'var(--accent)'
          e.currentTarget.style.color = 'var(--accent)'
          e.currentTarget.style.background = 'var(--accent-10)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = 'var(--border-strong)'
          e.currentTarget.style.color = 'var(--text-faint)'
          e.currentTarget.style.background = 'transparent'
        }}
      >
        ✕
      </button>
    </div>
  )
}
*/
