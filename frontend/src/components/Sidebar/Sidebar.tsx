import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { useAttention, type AttentionReason } from '../../hooks/useAttention'
import { api } from '../../api/client'
import { GitBranchIcon } from '../Icons/GitBranchIcon'
import { IconWorkbench } from '../FileManager/icons'
import type { Project, Workspace, Session } from '../../api/client'
import { APP_VERSION } from '../../version'
import { Modal } from '../Modal/Modal'
import { ConfirmDialog } from '../Modal/ConfirmDialog'


const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

function ProjectPath({ path }: { path: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setOverflow(el.scrollWidth > el.clientWidth)
    const ro = new ResizeObserver(check)
    ro.observe(el)
    check()
    return () => ro.disconnect()
  }, [path])

  return (
    <span
      ref={ref}
      className="block truncate"
      style={{
        fontSize: 11,
        color: 'var(--text-faint)',
        direction: overflow ? 'rtl' : 'ltr',
      }}
    >
      {path}
    </span>
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
    setConnected,
    fmSessionStates,
    resetFmToFollowing,
  } = useAppStore()

  const toggleSidebarCollapsed = useAppStore((s) => s.toggleSidebarCollapsed)
  const toggleSettings = useAppStore((s) => s.toggleSettings)

  const addToast = useToastStore((s) => s.addToast)
  const { t } = useTranslation()
  const attention = useAttention()

  // Terminal button pulse: only when session exists and browsing outside its CWD
  const fmState = activeSessionId ? (fmSessionStates[activeSessionId] ?? { mode: 'following' as const, manualPath: null, drawerPath: null, drawerMode: 'view' as const }) : null
  const isOutsideTerminalCwd = !!activeSessionId && fmState?.mode === 'manual'

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [createProjOpen, setCreateProjOpen] = useState(false)
  const [createSessOpen, setCreateSessOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ id: string; name: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{
    type: 'project' | 'session'
    id: string
    name: string
  } | null>(null)

  const [projName, setProjName] = useState('')
  const [projPath, setProjPath] = useState('')
  const [sessName, setSessName] = useState('')
  const [renameName, setRenameName] = useState('')
  const [homeDir, setHomeDir] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Agent enable button state — commented out pending notification scheme decision.
  // See docs/requirements.md "Agent 状态监控与通知".
  // const [enablingSessionId, setEnablingSessionId] = useState<string | null>(null)
  // const [tooltipSessionId, setTooltipSessionId] = useState<string | null>(null)
  // const tooltipTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load projects
  const loadProjects = useCallback(async () => {
    try {
      const p = await api.listProjects()
      setProjects(p)
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
      setSessions(s)
    } catch {
      // api client already shows error toast
    }
  }, [activeProjectId, setSessions])

  useEffect(() => { loadProjects() }, [loadProjects])
  useEffect(() => { loadSessions() }, [loadSessions])

  // ── Smart diff: session polling + attention detection ──
  const lastAgentEventRef = useRef<Map<string, string>>(new Map())
  const decisionCandidatesRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    // Poll sessions every 3 seconds for agent state changes
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

            if (state === 'idle' && reason === 'done') {
              // Done — fire immediately
              attention.fire(s.id, sessionKey, 'done')
              decisionCandidatesRef.current.delete(sessionKey)
            } else if (state === 'idle' && reason === 'error') {
              // Error — fire immediately
              attention.fire(s.id, sessionKey, 'error')
              decisionCandidatesRef.current.delete(sessionKey)
            } else if (state === 'waiting' && reason === 'decision') {
              // Decision — debounce: wait one more cycle
              if (decisionCandidatesRef.current.has(sessionKey)) {
                attention.fire(s.id, sessionKey, 'decision')
                decisionCandidatesRef.current.delete(sessionKey)
              } else {
                decisionCandidatesRef.current.add(sessionKey)
              }
            } else if (state === 'running') {
              // Running — clear any alert
              attention.clearAlert(sessionKey)
              decisionCandidatesRef.current.delete(sessionKey)
            }
          }
        }

        // Clear alerts for sessions that disappeared
        for (const key of lastAgentEventRef.current.keys()) {
          if (!currentSessionKeys.has(key)) {
            attention.clearAlert(key)
            lastAgentEventRef.current.delete(key)
            decisionCandidatesRef.current.delete(key)
          }
        }

        setSessions(freshSessions)
      } catch {
        // Quietly ignore poll errors
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [activeProjectId, setSessions, attention])

  useEffect(() => {
    api.systemInfo().then((info) => {
      setHomeDir(info.home_dir)
      setProjPath(info.home_dir)
    }).catch(() => {
      // fallback: leave projPath empty, user fills it in
    })
  }, [])

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
  const toggleProject = async (projectId: string) => {
    const newSet = new Set(expandedProjects)
    if (newSet.has(projectId)) {
      newSet.delete(projectId)
    } else {
      newSet.add(projectId)
      // Load worktrees + sessions in parallel so per-worktree session counts
      // are correct at expand time, not only after a worktree is activated.
      await Promise.all([loadWorktrees(projectId), loadSessions(projectId)])
    }
    setExpandedProjects(newSet)
  }

  const handleCreateProject = async () => {
    if (!projName.trim()) return
    setSubmitting(true)
    try {
      await api.createProject({ name: projName.trim(), path: projPath.trim() })
      await loadProjects()
      addToast('success', t('sidebar.projectCreated', { name: projName.trim() }) ?? `Project "${projName.trim()}" created`)
      setCreateProjOpen(false)
      setProjName('')
      setProjPath(homeDir)
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
    }
  }

  const handleCreateSession = async () => {
    if (!activeProjectId || !activeWorkspaceId) return
    // Find the active worktree path
    const wtList = worktrees[activeProjectId] || []
    const activeWt = wtList.find(w => w.id === activeWorkspaceId)
    if (!activeWt) return

    setSubmitting(true)
    try {
      await api.createSession(activeProjectId, activeWt.path, sessName.trim() || undefined)
      await loadSessions()
      addToast('success', t('sidebar.sessionCreated', { name: sessName.trim() || t('sidebar.unnamed') }) ?? `Session created`)
      setCreateSessOpen(false)
      setSessName('')
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
    }
  }

  const handleRenameSession = async () => {
    if (!renameTarget) return
    const newName = renameName.trim()
    if (!newName || newName === renameTarget.name) {
      setRenameOpen(false)
      return
    }
    setSubmitting(true)
    try {
      await api.updateSession(renameTarget.id, { name: newName })
      await loadSessions()
      addToast('success', t('sidebar.sessionRenamed', { name: newName }) ?? `Session renamed to "${newName}"`)
      setRenameOpen(false)
      setRenameTarget(null)
      setRenameName('')
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
    }
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

  const handleDeleteProject = async () => {
    if (!confirmDelete || confirmDelete.type !== 'project') return
    setSubmitting(true)
    try {
      await api.deleteProject(confirmDelete.id)
      await loadProjects()
      if (activeProjectId === confirmDelete.id) {
        setActiveProject(null)
        setActiveWorkspace(null)
        setSessions([])
      }
      addToast('success', t('sidebar.projectDeleted', { name: confirmDelete.name }) ?? `Project "${confirmDelete.name}" deleted`)
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
      setConfirmDelete(null)
    }
  }

  const handleDeleteSession = async () => {
    if (!confirmDelete || confirmDelete.type !== 'session') return
    setSubmitting(true)
    try {
      await api.deleteSession(confirmDelete.id)
      await loadSessions()
      if (activeSessionId === confirmDelete.id) {
        setActiveSession(null)
      }
      addToast('success', t('sidebar.sessionDeleted', { name: confirmDelete.name }) ?? `Session deleted`)
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
      setConfirmDelete(null)
    }
  }

  const handleProjKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreateProject()
    }
  }

  const handleSessKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreateSession()
    }
  }

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleRenameSession()
    }
  }

  const inputClass = "w-full px-3 py-2 rounded-lg text-sm focus:outline-none transition-all"
  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-primary)',
  }

  // Filter sessions for a specific worktree
  const sessionsForWorktree = (wtPath: string): Session[] => {
    return sessions.filter(s => s.workspace_path === wtPath)
  }

  if (sidebarCollapsed) {
    return (
      <div
        className="h-full flex flex-col items-center relative"
        style={{ background: 'var(--bg-base)', fontFamily: FONT, color: 'var(--text-primary)', width: 40 }}
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
            className={`flex items-center justify-center rounded-md transition-all ${isOutsideTerminalCwd ? 'fm-btn-terminal-active' : ''}`}
            style={{ width: 24, height: 24, color: isOutsideTerminalCwd ? '#c4b5fd' : 'var(--text-faint)', fontSize: 14 }}
            onClick={() => {
              if (activeSessionId) resetFmToFollowing(activeSessionId)
            }}
            title={t('fm.backToTerminalDir')}
            disabled={!activeSessionId}
          >
            <IconWorkbench width={14} height={14} />
          </button>
        </div>

        <button
          data-settings-toggle
          onClick={() => { toggleSettings() }}
          className="flex items-center justify-center rounded transition-all mb-3"
          style={{ width: 28, height: 28, border: '1px solid var(--border-strong)', color: 'var(--text-faint)', fontSize: 14 }}
          title={t('settings.title')}
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
          ⚙
        </button>
      </div>
    )
  }

  return (
    <div
      className="h-full flex flex-col text-base relative"
      style={{ background: 'var(--bg-base)', fontFamily: FONT, color: 'var(--text-primary)' }}
    >
      {/* Header */}
      <div
        className="px-3.5 py-3 flex items-center justify-between"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="rounded-full"
            style={{ width: 8, height: 8, background: 'var(--accent)', boxShadow: 'var(--accent-glow-md)' }}
          />
          <span
            className="font-bold text-base"
            style={{ background: 'linear-gradient(90deg, var(--accent), #818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}
          >
            OmniTerm
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Terminal CWD button — pulses when outside terminal CWD */}
          <button
            className={`flex items-center justify-center rounded-md transition-all ${isOutsideTerminalCwd ? 'fm-btn-terminal-active' : ''}`}
            style={{ width: 24, height: 24, color: isOutsideTerminalCwd ? '#c4b5fd' : 'var(--text-faint)', fontSize: 14 }}
            onClick={() => {
              if (activeSessionId) resetFmToFollowing(activeSessionId)
            }}
            title={t('fm.backToTerminalDir')}
            disabled={!activeSessionId}
          >
            <IconWorkbench width={13} height={13} />
          </button>
          <button
            onClick={toggleSidebarCollapsed}
            className="flex items-center justify-center rounded-md transition-all"
            style={{ width: 24, height: 24, color: 'var(--text-faint)', fontSize: 14 }}
            title={t('sidebar.collapse')}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; e.currentTarget.style.background = 'transparent' }}
          >
            ◀
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-2.5 pt-4 pb-16">
        {/* Agent onboarding banner — commented out pending notification scheme decision.
        <AgentOnboardingBanner sessions={sessions} />
        */}

        {/* Section label */}
        <div className="flex items-center justify-between px-1 mb-2.5">
          <div className="flex items-center gap-1.5">
            <span style={{ fontSize: 11, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 2, fontWeight: 600 }}>
              {t('sidebar.projects') ?? 'Projects'}
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{projects.length}</span>
          </div>
          <button
            onClick={() => setCreateProjOpen(true)}
            className="flex items-center justify-center rounded transition-all"
            style={{ width: 22, height: 22, border: '1px solid var(--accent)', color: 'var(--accent)', fontSize: 15, fontWeight: 500 }}
            title={t('sidebar.createProject') ?? 'Create Project'}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--accent-14)'
              e.currentTarget.style.boxShadow = '0 0 8px rgba(167,139,250,0.2)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.boxShadow = 'none'
            }}
          >
            +
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="px-2 py-3" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            {t('sidebar.noProjects') ?? 'No projects yet'}
          </div>
        ) : (
          projects.map((proj) => {
            const isExpanded = expandedProjects.has(proj.id)
            const wtList = worktrees[proj.id] || []
            const hasWorktrees = wtList.length > 0
            const projHasActiveSession = wtList.some((wt) =>
              sessionsForWorktree(wt.path).some((s) => s.is_active)
            )

            return (
              <div key={proj.id} className="relative mb-2">
                {/* Project item */}
                <div
                  className="flex items-center justify-between cursor-pointer rounded-lg transition-all"
                  style={{
                    padding: '10px 14px',
                    background: isExpanded
                      ? 'linear-gradient(90deg, rgba(167,139,250,0.08), transparent)'
                      : 'transparent',
                    border: `1px solid ${isExpanded ? 'rgba(167,139,250,0.12)' : 'var(--border-subtle)'}`,
                  }}
                  onClick={() => toggleProject(proj.id)}
                >
                  <div className="flex-1 min-w-0 mr-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={projHasActiveSession ? 'activity-pulse' : ''}
                        style={{
                          color: isExpanded || projHasActiveSession ? 'var(--accent)' : 'var(--text-dim)',
                          fontSize: 12,
                          transition: 'transform 0.15s',
                          display: 'inline-block',
                          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        }}
                      >▸</span>
                      <span style={{ color: isExpanded ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: isExpanded ? 500 : 400, fontSize: 13 }}>
                        {proj.name}
                      </span>
                    </div>
                    <div className="pl-5 mt-0.5">
                      <ProjectPath path={proj.path} />
                    </div>
                  </div>
                  <div className="flex items-center">
                    <DeleteButton
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmDelete({ type: 'project', id: proj.id, name: proj.name })
                      }}
                    />
                  </div>
                </div>

                {/* Worktrees under expanded project */}
                {isExpanded && (
                  <div className="pl-4 pr-1 pt-1 pb-1">
                    {wtList.length === 0 ? (
                      <div className="px-2 py-1.5" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                        {t('sidebar.noWorktrees') ?? 'No worktrees found'}
                      </div>
                    ) : (
                      wtList.map((wt) => {
                        const isWtActive = activeWorkspaceId === wt.id
                        const wtSessions = sessionsForWorktree(wt.path)
                        const wtHasActiveSession = wtSessions.some((s) => s.is_active)
                        const isWtExpanded = isWtActive

                        return (
                          <div key={wt.id} className="mb-1">
                            {/* Worktree item */}
                            <div
                              className="flex items-center justify-between cursor-pointer rounded-md transition-all"
                              style={{
                                padding: '6px 10px',
                                background: isWtActive ? 'rgba(167,139,250,0.1)' : 'transparent',
                                border: `1px solid ${isWtActive ? 'rgba(167,139,250,0.15)' : 'transparent'}`,
                              }}
                              onClick={() => {
                                setActiveProject(proj.id)
                                setActiveWorkspace(wt.id === activeWorkspaceId ? null : wt.id)
                              }}
                            >
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                <span
                                  className={`rounded-full flex items-center justify-center ${wtHasActiveSession ? 'activity-pulse' : ''}`}
                                  style={{
                                    width: 16,
                                    height: 16,
                                    color: isWtActive || wtHasActiveSession ? 'var(--accent)' : 'var(--text-dim)',
                                  }}
                                >
                                  <GitBranchIcon
                                    size={14}
                                    color={isWtActive || wtHasActiveSession ? 'var(--accent)' : 'var(--text-dim)'}
                                  />
                                </span>
                                <span
                                  className="truncate"
                                  style={{
                                    fontSize: 12,
                                    color: isWtActive ? 'var(--accent)' : 'var(--text-muted)',
                                    fontWeight: isWtActive ? 500 : 400,
                                    fontFamily: FONT,
                                  }}
                                >
                                  {wt.label}
                                </span>
                                <span
                                  style={{
                                    fontSize: 11,
                                    color: 'var(--text-dim)',
                                    marginLeft: 4,
                                    fontFamily: FONT,
                                  }}
                                >
                                  {wtSessions.length}
                                </span>
                              </div>
                            </div>

                            {/* Sessions under active worktree */}
                            {isWtExpanded && (
                              <div className="pl-5 pr-1 pt-1 pb-1">
                                <div className="flex items-center justify-between px-0.5 mb-1">
                                  <span style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 1.5 }}>
                                    {t('sidebar.sessions')}
                                  </span>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      setCreateSessOpen(true)
                                    }}
                                    className="flex items-center justify-center rounded transition-all"
                                    style={{ width: 18, height: 18, border: '1px solid var(--accent)', color: 'var(--accent)', fontSize: 13, fontWeight: 500 }}
                                    title={t('sidebar.createSession')}
                                    onMouseEnter={(e) => {
                                      e.currentTarget.style.background = 'var(--accent-14)'
                                      e.currentTarget.style.boxShadow = '0 0 8px rgba(167,139,250,0.2)'
                                    }}
                                    onMouseLeave={(e) => {
                                      e.currentTarget.style.background = 'transparent'
                                      e.currentTarget.style.boxShadow = 'none'
                                    }}
                                  >
                                    +
                                  </button>
                                </div>

                                {wtSessions.map((s) => {
                                  const isSessionActive = activeSessionId === s.id
                                  const sessionKey = s.id
                                  const attnReason = attention.reasonFor(sessionKey)
                                  return (
                                    <div
                                      key={s.id}
                                      className="flex items-center gap-2 rounded-md cursor-pointer transition-all"
                                      style={{
                                        padding: '5px 8px',
                                        marginBottom: 2,
                                        background: isSessionActive ? 'rgba(167,139,250,0.08)' : 'transparent',
                                        border: isSessionActive ? '1px solid rgba(167,139,250,0.1)' : '1px solid transparent',
                                      }}
                                      onClick={() => {
                                        setActiveSession(s.id)
                                        attention.setActive(sessionKey)
                                      }}
                                    >
                                      {/* Running indicator dot */}
                                      <div
                                        className={`rounded-full flex-shrink-0 ${s.is_active && !attnReason ? 'session-activity-pulse' : ''}`}
                                        style={{
                                          width: 5,
                                          height: 5,
                                          background: attnReason
                                            ? attnReason === 'decision'
                                              ? '#f59e0b'
                                              : attnReason === 'error'
                                                ? 'var(--danger)'
                                                : 'var(--success)'
                                            : s.is_active
                                              ? 'var(--accent)'
                                              : 'var(--text-dim)',
                                          boxShadow: attnReason ? 'var(--accent-glow-sm)' : 'none',
                                        }}
                                      />
                                      <span
                                        className="truncate flex-1"
                                        style={{ fontSize: 12, color: isSessionActive ? 'var(--text-primary)' : 'var(--text-muted)' }}
                                      >
                                        {s.name || s.tmux_session_name}
                                      </span>
                                      {/* Attention badge */}
                                      {attnReason && (
                                        <span
                                          className="flex-shrink-0 rounded-full flex items-center justify-center animate-pulse"
                                          style={{
                                            width: 16,
                                            height: 16,
                                            fontSize: 10,
                                            background: attnReason === 'decision'
                                              ? 'rgba(245,158,11,0.2)'
                                              : attnReason === 'error'
                                                ? 'rgba(239,68,68,0.2)'
                                                : 'rgba(34,197,94,0.2)',
                                            color: attnReason === 'decision'
                                              ? '#f59e0b'
                                              : attnReason === 'error'
                                                ? 'var(--danger)'
                                                : 'var(--success)',
                                          }}
                                          title={
                                            attnReason === 'decision' ? 'Needs decision' :
                                            attnReason === 'error' ? 'Error' : 'Done'
                                          }
                                        >
                                          {attnReason === 'decision' ? '⏳' : attnReason === 'error' ? '⚠' : '✓'}
                                        </span>
                                      )}
                                      {/* Agent enable button — commented out pending notification scheme decision.
                                          See docs/requirements.md "Agent 状态监控与通知".
                                      {s.agent_detected && !s.hook_enabled && (
                                        <div className="relative flex-shrink-0">
                                          ...
                                        </div>
                                      )}
                                      */}
                                      <EditButton
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setRenameTarget({ id: s.id, name: s.name || '' })
                                          setRenameName(s.name || '')
                                          setRenameOpen(true)
                                        }}
                                      />
                                      <DeleteButton
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setConfirmDelete({
                                            type: 'session',
                                            id: s.id,
                                            name: s.name || s.tmux_session_name || t('sidebar.unnamed'),
                                          })
                                        }}
                                      />
                                    </div>
                                  )
                                })}

                                {wtSessions.length === 0 && (
                                  <div className="px-1 py-1" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                                    {t('sidebar.noSessions')}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Bottom status bar */}
      <div
        className="absolute bottom-0 left-0 right-0 px-3.5 py-3 flex items-center justify-between"
        style={{ borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-base)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="rounded-full"
            style={{
              width: 6,
              height: 6,
              background: connected ? 'var(--success)' : 'var(--danger)',
              boxShadow: connected ? 'var(--success-glow)' : 'var(--danger-glow)',
            }}
          />
          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{connected ? t('sidebar.connected') : t('sidebar.disconnected')}</span>
          <span style={{ fontSize: 10, color: 'var(--text-dim)', marginLeft: 4 }}>v{APP_VERSION}</span>
        </div>
        <button
          data-settings-toggle
          onClick={toggleSettings}
          className="flex items-center justify-center rounded transition-all"
          style={{ width: 26, height: 26, border: '1px solid var(--border-strong)', color: 'var(--text-faint)', fontSize: 14 }}
          title={t('settings.title')}
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
          ⚙
        </button>
      </div>

      {/* ── Create Project Modal ── */}
      <Modal open={createProjOpen} onClose={() => { setCreateProjOpen(false); setProjName(''); setProjPath(homeDir) }} title={t('sidebar.createProject') ?? 'Create Project'}>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.projectName') ?? 'Project Name'}
            </label>
            <input
              type="text"
              value={projName}
              onChange={(e) => setProjName(e.target.value)}
              onKeyDown={handleProjKeyDown}
              placeholder="my-project"
              autoFocus
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.2)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.repoPath') ?? 'Git Repository Path'}
            </label>
            <input
              type="text"
              value={projPath}
              onChange={(e) => setProjPath(e.target.value)}
              onKeyDown={handleProjKeyDown}
              placeholder={homeDir}
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.2)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <ModalCancel onClick={() => { setCreateProjOpen(false); setProjName(''); setProjPath(homeDir) }}>
              {t('sidebar.cancel')}
            </ModalCancel>
            <ModalPrimary onClick={handleCreateProject} disabled={!projName.trim() || submitting}>
              {submitting ? t('sidebar.creating') : t('sidebar.create')}
            </ModalPrimary>
          </div>
        </div>
      </Modal>

      {/* ── Create Session Modal ── */}
      <Modal open={createSessOpen} onClose={() => { setCreateSessOpen(false); setSessName('') }} title={t('sidebar.createSession')} maxWidth="max-w-sm">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.sessionName')} <span style={{ color: 'var(--text-dim)' }}>{t('sidebar.optional')}</span>
            </label>
            <input
              type="text"
              value={sessName}
              onChange={(e) => setSessName(e.target.value)}
              onKeyDown={handleSessKeyDown}
              placeholder="dev-server"
              autoFocus
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.2)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <ModalCancel onClick={() => { setCreateSessOpen(false); setSessName('') }}>
              {t('sidebar.cancel')}
            </ModalCancel>
            <ModalPrimary onClick={handleCreateSession} disabled={submitting}>
              {submitting ? t('sidebar.creating') : t('sidebar.create')}
            </ModalPrimary>
          </div>
        </div>
      </Modal>

      {/* ── Rename Session Modal ── */}
      <Modal
        open={renameOpen}
        onClose={() => { setRenameOpen(false); setRenameTarget(null); setRenameName('') }}
        title={t('sidebar.renameSession') ?? 'Rename Session'}
        maxWidth="max-w-sm"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.sessionName')}
            </label>
            <input
              type="text"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              placeholder={t('sidebar.sessionName') ?? 'dev-server'}
              autoFocus
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.2)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <ModalCancel onClick={() => { setRenameOpen(false); setRenameTarget(null); setRenameName('') }}>
              {t('sidebar.cancel')}
            </ModalCancel>
            <ModalPrimary
              onClick={handleRenameSession}
              disabled={!renameName.trim() || renameName.trim() === renameTarget?.name || submitting}
            >
              {submitting ? t('sidebar.renaming') : t('sidebar.rename')}
            </ModalPrimary>
          </div>
        </div>
      </Modal>

      {/* ── Delete Confirmation Dialog ── */}
      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={confirmDelete?.type === 'project' ? handleDeleteProject : handleDeleteSession}
        title={confirmDelete?.type === 'project' ? (t('sidebar.deleteProject') ?? 'Remove Project from List') : t('sidebar.deleteSession')}
        message={
          confirmDelete?.type === 'project'
            ? (t('sidebar.confirmDeleteProject', { name: confirmDelete?.name }) ?? `Remove project "${confirmDelete?.name}" from the list? Files on disk are not affected.`)
            : t('sidebar.confirmDeleteSession', { name: confirmDelete?.name })
        }
        confirmText={confirmDelete?.type === 'project' ? t('sidebar.remove') : t('sidebar.delete')}
        destructive={confirmDelete?.type === 'session'}
        loading={submitting}
      />
    </div>
  )
}

function EditButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onClick}
      className="flex-shrink-0 flex items-center justify-center rounded transition-all"
      style={{ width: 20, height: 20, border: '1px solid var(--border-strong)', color: 'var(--text-faint)', fontSize: 11 }}
      title={t('sidebar.rename')}
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
      ✎
    </button>
  )
}

function DeleteButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onClick}
      className="flex-shrink-0 flex items-center justify-center rounded transition-all sidebar-glow-red-hover"
      style={{ width: 20, height: 20, border: '1px solid var(--border-strong)', color: 'var(--text-faint)', fontSize: 11 }}
      title={t('sidebar.delete')}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--danger)'
        e.currentTarget.style.color = 'var(--danger)'
        e.currentTarget.style.background = 'var(--danger-12)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-strong)'
        e.currentTarget.style.color = 'var(--text-faint)'
        e.currentTarget.style.background = 'transparent'
      }}
    >
      ✕
    </button>
  )
}

function ModalCancel({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 text-sm rounded-lg transition-all"
      style={{ border: '1px solid var(--border-strong)', color: 'var(--text-muted)' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'var(--accent-10)'
        e.currentTarget.style.borderColor = 'var(--accent)'
        e.currentTarget.style.color = 'var(--text-primary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.borderColor = 'var(--border-strong)'
        e.currentTarget.style.color = 'var(--text-muted)'
      }}
    >
      {children}
    </button>
  )
}

function ModalPrimary({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-4 py-2 text-sm rounded-lg text-white transition-all disabled:opacity-50"
      style={{ background: 'var(--accent)' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-bright)' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--accent)' }}
    >
      {children}
    </button>
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
          border: '1px solid var(--border-strong)',
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
