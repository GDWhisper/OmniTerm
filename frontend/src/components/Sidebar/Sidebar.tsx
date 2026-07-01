import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { useAttention, type AttentionReason } from '../../hooks/useAttention'
import { api, ApiError } from '../../api/client'
import { GitBranchIcon } from '../Icons/GitBranchIcon'
import { BookIcon } from '../Icons/BookIcon'
import { IconFolder, IconFolderPlus, IconArrowUp, IconRefresh, IconWarning, IconWorkbench } from '../FileManager/icons'
import type { Session, DuplicateGroup, FileEntry, ExternalSession } from '../../api/client'
import { getParentPath } from '../../utils/path'
import { APP_VERSION } from '../../version'
import { Modal } from '../Modal/Modal'
import { ConfirmDialog } from '../Modal/ConfirmDialog'
import { DuplicateProjectsDialog } from './DuplicateProjectsDialog'

const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

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
      className={`flex items-center justify-center rounded transition-all ${className}`}
      style={{
        width: size,
        height: size,
        border: '1px solid var(--border-strong)',
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
    setActiveExternalSession,
    setConnected,
    workspaceSessionMemory,
    setWorkspaceSession,
    clearWorkspaceSession,
    fmSessionStates,
    resetFmToFollowing,
  } = useAppStore()

  const activeExternalSession = useAppStore((s) => s.activeExternalSession)

  const toggleSidebarCollapsed = useAppStore((s) => s.toggleSidebarCollapsed)
  const toggleSettings = useAppStore((s) => s.toggleSettings)
  const toggleTmuxCheatsheet = useAppStore((s) => s.toggleTmuxCheatsheet)

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
  const [renameTarget, setRenameTarget] = useState<{ type: 'project' | 'session'; id: string; name: string } | null>(null)
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

  // Browse state for the create-project modal's embedded directory list
  const [browsePath, setBrowsePath] = useState('')
  const [browseEntries, setBrowseEntries] = useState<FileEntry[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  // True when the fetched path doesn't exist (404). The backend's
  // create_project auto-creates non-existent paths, so this is friendly
  // info rather than a hard error — the UI shows a "will be created" hint.
  const [browseNotFound, setBrowseNotFound] = useState(false)
  // 409 Conflict response data when creating a project whose path is
  // already covered by an existing project.
  const [coverConflict, setCoverConflict] = useState<{
    coveringProject: { id: string; name: string; path: string }
    reason: 'exact_path' | 'worktree_child'
  } | null>(null)
  // Repair project path dialog — shown when user clicks a workspace whose
  // path no longer exists on disk. Lets them browse to the new location.
  const [repairDialogOpen, setRepairDialogOpen] = useState(false)
  const [repairProject, setRepairProject] = useState<{ project: Project; workspace: Workspace; oldPath: string } | null>(null)
  const [repairPath, setRepairPath] = useState('')
  const [repairBrowsePath, setRepairBrowsePath] = useState('')
  const [repairBrowseEntries, setRepairBrowseEntries] = useState<FileEntry[]>([])
  const [repairBrowseLoading, setRepairBrowseLoading] = useState(false)
  const [repairBrowseError, setRepairBrowseError] = useState<string | null>(null)
  const [repairSubmitting, setRepairSubmitting] = useState(false)

  // External tmux sessions (not yet adopted into any project)
  const [externalSessions, setExternalSessions] = useState<ExternalSession[]>([])
  const [externalExpanded, setExternalExpanded] = useState(false)
  const [adoptTarget, setAdoptTarget] = useState<{ tmux_name: string } | null>(null)
  const [adoptProjectId, setAdoptProjectId] = useState('')

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

  // ── External sessions polling (every 10s) ──
  useEffect(() => {
    const fetchExternal = () => {
      api.listExternalSessions()
        .then(data => setExternalSessions(data.sessions))
        .catch(() => {})
    }
    fetchExternal()
    const interval = setInterval(fetchExternal, 10_000)
    return () => clearInterval(interval)
  }, [])

  // ── Restore active state from localStorage on page load ──
  // Use refs so each step fires exactly once when its data first arrives,
  // regardless of whether appStore already read the saved IDs on init.
  const restoredProjectRef = useRef(false)
  const restoredWorkspaceRef = useRef(false)
  const restoredSessionRef = useRef(false)

  // After projects load, expand the saved project and load its data.
  useEffect(() => {
    if (restoredProjectRef.current || projects.length === 0) return
    const savedProjectId = localStorage.getItem('omniterm_active_project')
    if (savedProjectId && projects.some(p => p.id === savedProjectId)) {
      setExpandedProjects(prev => {
        const next = new Set(prev)
        next.add(savedProjectId)
        return next
      })
      setActiveProject(savedProjectId)
      loadWorktrees(savedProjectId)
      // loadSessions fires via its own useEffect when activeProjectId changes
    }
    restoredProjectRef.current = true
  }, [projects, setActiveProject, loadWorktrees])

  // After worktrees load, restore the active workspace (or clean up stale saved ID).
  useEffect(() => {
    if (!activeProjectId) return
    const wtList = worktrees[activeProjectId]
    if (!wtList || wtList.length === 0) return
    const savedWorkspaceId = localStorage.getItem('omniterm_active_workspace')
    if (!savedWorkspaceId) {
      restoredWorkspaceRef.current = true
      return
    }
    if (restoredWorkspaceRef.current) return
    if (wtList.some(w => w.id === savedWorkspaceId)) {
      if (activeWorkspaceId !== savedWorkspaceId) setActiveWorkspace(savedWorkspaceId)
    } else {
      localStorage.removeItem('omniterm_active_workspace')
    }
    restoredWorkspaceRef.current = true
  }, [worktrees, activeProjectId, activeWorkspaceId, setActiveWorkspace])

  // After sessions load, restore the active session (or clean up stale saved ID).
  useEffect(() => {
    const allSessions = Object.values(sessions).flat()
    if (allSessions.length === 0) return
    const savedSessionId = localStorage.getItem('omniterm_active_session')
    if (!savedSessionId) {
      restoredSessionRef.current = true
      return
    }
    if (restoredSessionRef.current) return
    if (allSessions.some(s => s.id === savedSessionId)) {
      if (activeSessionId !== savedSessionId) setActiveSession(savedSessionId)
    } else {
      localStorage.removeItem('omniterm_active_session')
    }
    restoredSessionRef.current = true
  }, [sessions, activeSessionId, setActiveSession])

  // Fetch directory entries for the new-project modal's browse list.
  const fetchDirs = useCallback(async (path: string) => {
    setBrowseLoading(true)
    setBrowseError(null)
    setBrowseNotFound(false)
    try {
      const data = await api.listDirs(path)
      setBrowseEntries(
        data.files.filter(
          (f) => f.path_type === 'Dir' || f.path_type === 'SymlinkDir',
        ),
      )
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 404) {
        setBrowseNotFound(true)
        setBrowseEntries([])
      } else {
        setBrowseError(e.message || '无法访问该目录')
      }
    } finally {
      setBrowseLoading(false)
    }
  }, [])

  // Fetch directory entries for the repair-project-path dialog's browse list.
  const fetchRepairDirs = useCallback(async (path: string) => {
    setRepairBrowseLoading(true)
    setRepairBrowseError(null)
    try {
      const data = await api.listDirs(path)
      setRepairBrowseEntries(
        data.files.filter(
          (f) => f.path_type === 'Dir' || f.path_type === 'SymlinkDir',
        ),
      )
    } catch (e: any) {
      if (e instanceof ApiError && e.status === 404) {
        setRepairBrowseEntries([])
      } else {
        setRepairBrowseError(e.message || '无法访问该目录')
      }
    } finally {
      setRepairBrowseLoading(false)
    }
  }, [])

  // Auto-fetch when repairBrowsePath changes
  useEffect(() => {
    if (!repairBrowsePath) return
    fetchRepairDirs(repairBrowsePath)
  }, [repairBrowsePath, fetchRepairDirs])

  // Auto-fetch when browsePath changes (covers click-dir, go-up, and type-apply)
  useEffect(() => {
    if (!browsePath) return
    fetchDirs(browsePath)
  }, [browsePath, fetchDirs])

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
      setProjPath(info.home_dir)
    }).catch(() => {
      // fallback: leave projPath empty, user fills it in
    })
  }, [])

  // Reset browse state when the create-project modal opens
  useEffect(() => {
    if (createProjOpen && homeDir) {
      setBrowsePath(homeDir)
      setProjPath(homeDir)
      setBrowseError(null)
      setBrowseNotFound(false)
    }
  }, [createProjOpen, homeDir])

  // Unified close: clear form + browse state
  const closeCreateProj = () => {
    setCreateProjOpen(false)
    setProjName('')
    setProjPath(homeDir)
    setBrowsePath('')
    setBrowseEntries([])
    setBrowseError(null)
    setBrowseNotFound(false)
  }

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

  // Browse handlers for the new-project modal
  const handleEnterDir = (entry: FileEntry) => {
    const newPath = browsePath.endsWith('/')
      ? `${browsePath}${entry.name}`
      : `${browsePath}/${entry.name}`
    setProjPath(newPath)
    setBrowsePath(newPath)
  }

  const handleGoUp = () => {
    const parent = getParentPath(browsePath)
    if (!parent) return
    setProjPath(parent)
    setBrowsePath(parent)
  }

  const handlePathApply = () => {
    const trimmed = projPath.trim()
    if (!trimmed || trimmed === browsePath) return
    setBrowsePath(trimmed)
  }

  const handleRefresh = () => {
    if (browsePath) fetchDirs(browsePath)
  }

  // Repair dialog browse handlers
  const handleRepairEnterDir = (entry: FileEntry) => {
    const newPath = repairBrowsePath.endsWith('/')
      ? `${repairBrowsePath}${entry.name}`
      : `${repairBrowsePath}/${entry.name}`
    setRepairPath(newPath)
    setRepairBrowsePath(newPath)
  }

  const handleRepairGoUp = () => {
    const parent = getParentPath(repairBrowsePath)
    if (!parent) return
    setRepairPath(parent)
    setRepairBrowsePath(parent)
  }

  const handleRepairPathApply = () => {
    const trimmed = repairPath.trim()
    if (!trimmed || trimmed === repairBrowsePath) return
    setRepairBrowsePath(trimmed)
  }

  const handleRepairRefresh = () => {
    if (repairBrowsePath) fetchRepairDirs(repairBrowsePath)
  }

  const handleRepairUpdate = async () => {
    if (!repairProject || !repairPath.trim()) return
    setRepairSubmitting(true)
    try {
      await api.updateProject(repairProject.project.id, { path: repairPath.trim() })
      addToast('success', t('sidebar.repairUpdated') ?? `Project path updated to "${repairPath.trim()}"`)
      // Refresh projects + worktrees + sessions so the UI reflects the new path
      await Promise.all([loadProjects(), loadWorktrees(repairProject.project.id), loadSessions(repairProject.project.id)])
      // Activate the workspace after successful update
      setActiveProject(repairProject.project.id)
      setActiveSession(null)
      setActiveWorkspace(repairProject.workspace.id)
      setRepairDialogOpen(false)
      setRepairProject(null)
    } catch {
      // api client already shows error toast
    } finally {
      setRepairSubmitting(false)
    }
  }

  const openRepairDialog = (project: Project, workspace: Workspace, oldPath: string) => {
    setRepairProject({ project, workspace, oldPath })
    setRepairPath('')
    setRepairBrowsePath(oldPath ? getParentPath(oldPath) : '')
    setRepairBrowseEntries([])
    setRepairBrowseError(null)
    setRepairDialogOpen(true)
  }

  const closeRepairDialog = () => {
    setRepairDialogOpen(false)
    setRepairProject(null)
    setRepairPath('')
    setRepairBrowsePath('')
    setRepairBrowseEntries([])
    setRepairBrowseError(null)
  }

  const handleWorkspaceClick = async (proj: Project, wt: Workspace) => {
    // Check if the workspace path exists on disk
    try {
      const { exists } = await api.pathExists(wt.path)
      if (!exists) {
        openRepairDialog(proj, wt, proj.path)
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
    } catch (e) {
      // 409 Conflict: the new path is already covered by an existing
      // project. Surface a switch-to-existing dialog instead of letting
      // the generic toast dismiss.
      if (e instanceof ApiError && e.status === 409 && e.body?.error === 'already_covered') {
        setCoverConflict({
          coveringProject: e.body.covering_project,
          reason: e.body.reason,
        })
        return
      }
      // api client already shows error toast for other failures
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

  const handleRename = async () => {
    if (!renameTarget) return
    const newName = renameName.trim()
    if (!newName || newName === renameTarget.name) {
      setRenameOpen(false)
      return
    }
    setSubmitting(true)
    try {
      if (renameTarget.type === 'project') {
        await api.updateProject(renameTarget.id, { name: newName })
        await loadProjects()
        addToast('success', t('sidebar.projectRenamed', { name: newName }) ?? `Project renamed to "${newName}"`)
      } else {
        await api.updateSession(renameTarget.id, { name: newName })
        await loadSessions()
        addToast('success', t('sidebar.sessionRenamed', { name: newName }) ?? `Session renamed to "${newName}"`)
      }
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
        setSessions(confirmDelete.id, [])
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
      // Clean workspace session memory for the deleted session
      for (const wsId of Object.keys(workspaceSessionMemory)) {
        if (workspaceSessionMemory[wsId] === confirmDelete.id) {
          clearWorkspaceSession(wsId)
        }
      }
      addToast('success', t('sidebar.sessionDeleted', { name: confirmDelete.name }) ?? `Session deleted`)
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
      setConfirmDelete(null)
    }
  }

  // Enter in name field = create project
  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreateProject()
    }
  }

  // Enter in path field = apply path (don't create)
  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handlePathApply()
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
      handleRename()
    }
  }

  const inputClass = "w-full px-3 py-2 rounded-lg text-sm focus:outline-none transition-all"
  const inputStyle: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-strong)',
    color: 'var(--text-primary)',
  }

  // Filter sessions for a specific worktree.
  // "Orphan" sessions (whose workspace_path doesn't match any worktree)
  // are shown under the main worktree (or first worktree) so that
  // adopted external sessions remain visible even when their CWD
  // doesn't correspond to a known worktree path.
  const sessionsForWorktree = (projectId: string, wtPath: string): Session[] => {
    const allSessions = sessions[projectId] || []
    const worktreeList = worktrees[projectId] || []

    // Sessions that exactly match this worktree
    const exactMatches = allSessions.filter(s => s.workspace_path === wtPath)

    // For the primary worktree, also include sessions that don't match
    // any worktree (e.g. adopted external sessions whose tmux CWD is
    // outside the project's worktree paths).
    const primaryWt = worktreeList.find(w => w.is_main) || worktreeList[0]
    if (primaryWt && wtPath === primaryWt.path) {
      const matchedPaths = new Set(worktreeList.map(w => w.path))
      const orphans = allSessions.filter(s => !matchedPaths.has(s.workspace_path))
      return [...exactMatches, ...orphans]
    }

    return exactMatches
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
          icon="⚙"
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
            <span style={{ fontSize: 14, color: '#fbbf24' }}>⚠</span>
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
            const projHasActiveSession = wtList.some((wt) =>
              sessionsForWorktree(proj.id, wt.path).some((s) => s.is_active)
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
                  <div className="flex items-center gap-1">
                    <EditButton
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenameTarget({ type: 'project', id: proj.id, name: proj.name })
                        setRenameName(proj.name)
                        setRenameOpen(true)
                      }}
                    />
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
                        const wtSessions = sessionsForWorktree(proj.id, wt.path)
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
                              onClick={() => handleWorkspaceClick(proj, wt)}
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
                                        setActiveExternalSession(null)
                                        if (activeWorkspaceId) {
                                          setWorkspaceSession(activeWorkspaceId, s.id)
                                        }
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
                                          setRenameTarget({ type: 'session', id: s.id, name: s.name || '' })
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

        {/* External Sessions — tmux sessions not yet adopted into any project */}
        {externalSessions.length > 0 && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
            <div
              className="flex items-center justify-between px-1 mb-1.5 cursor-pointer rounded transition-all"
              onClick={() => setExternalExpanded(!externalExpanded)}
            >
              <div className="flex items-center gap-1.5">
                <span
                  style={{
                    fontSize: 12,
                    color: externalExpanded ? 'var(--accent)' : 'var(--text-dim)',
                    transition: 'transform 0.15s',
                    display: 'inline-block',
                    transform: externalExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  }}
                >▸</span>
                <span style={{ fontSize: 11, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 2, fontWeight: 600 }}>
                  {t('sidebar.externalSessions') ?? 'External Sessions'}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{externalSessions.length}</span>
              </div>
            </div>

            {externalExpanded && (
              <div className="pl-4 pr-1">
                {externalSessions.map((s) => (
                  <div
                    key={s.name}
                    className="flex items-center gap-2 rounded-md transition-all mb-1 cursor-pointer"
                    style={{
                      padding: '5px 8px',
                      background: activeExternalSession === s.name ? 'rgba(167,139,250,0.08)' : 'transparent',
                      border: activeExternalSession === s.name ? '1px solid rgba(167,139,250,0.1)' : '1px solid transparent',
                    }}
                    onClick={() => {
                      setActiveSession(null)
                      setActiveExternalSession(activeExternalSession === s.name ? null : s.name)
                    }}
                    onMouseEnter={(e) => {
                      if (activeExternalSession === s.name) return
                      e.currentTarget.style.background = 'rgba(167,139,250,0.06)'
                    }}
                    onMouseLeave={(e) => {
                      if (activeExternalSession === s.name) return
                      e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    {/* Activity dot */}
                    <div
                      className="rounded-full flex-shrink-0"
                      style={{
                        width: 5,
                        height: 5,
                        background: s.attached ? 'var(--success)' : 'var(--text-dim)',
                        boxShadow: s.attached ? 'var(--success-glow)' : 'none',
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="block truncate" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                        {s.name}
                      </span>
                      {s.cwd && (
                        <span className="block truncate" style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 1 }}>
                          {s.cwd}
                        </span>
                      )}
                      <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                        {s.windows} {s.windows === 1 ? 'window' : 'windows'}
                      </span>
                    </div>

                    {adoptTarget?.tmux_name === s.name ? (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <select
                          value={adoptProjectId}
                          onChange={(e) => setAdoptProjectId(e.target.value)}
                          style={{
                            background: 'var(--bg-surface)',
                            border: '1px solid var(--border-strong)',
                            color: 'var(--text-primary)',
                            fontSize: 11,
                            borderRadius: 4,
                            padding: '2px 4px',
                            maxWidth: 100,
                            fontFamily: FONT,
                          }}
                        >
                          {projects.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => {
                            if (!adoptTarget || !adoptProjectId) return
                            const name = adoptTarget.tmux_name
                            api.adoptSession(name, adoptProjectId).then(() => {
                              setExternalSessions(prev => prev.filter(s => s.name !== name))
                              loadSessions(adoptProjectId)
                              addToast('success', t('sidebar.adoptSuccess', { name }) ?? `Session "${name}" adopted`)
                            }).catch((e: any) => {
                              addToast('error', t('sidebar.adoptFailed', { msg: e.message }) ?? `Failed to adopt session: ${e.message}`)
                            }).finally(() => {
                              setAdoptTarget(null)
                              setAdoptProjectId('')
                            })
                          }}
                          disabled={!adoptProjectId}
                          className="flex items-center justify-center rounded transition-all"
                          style={{
                            padding: '2px 6px',
                            border: '1px solid var(--accent)',
                            color: 'var(--accent)',
                            fontSize: 11,
                            fontWeight: 500,
                            opacity: adoptProjectId ? 1 : 0.5,
                          }}
                          onMouseEnter={(e) => {
                            if (!adoptProjectId) return
                            e.currentTarget.style.background = 'var(--accent-14)'
                            e.currentTarget.style.boxShadow = '0 0 8px rgba(167,139,250,0.2)'
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent'
                            e.currentTarget.style.boxShadow = 'none'
                          }}
                        >
                          ✓
                        </button>
                        <button
                          onClick={() => { setAdoptTarget(null); setAdoptProjectId('') }}
                          className="flex items-center justify-center rounded transition-all"
                          style={{ width: 18, height: 18, border: '1px solid var(--border-strong)', color: 'var(--text-faint)', fontSize: 10 }}
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setAdoptTarget({ tmux_name: s.name })
                          setAdoptProjectId(activeProjectId || projects[0]?.id || '')
                        }}
                        className="flex-shrink-0 flex items-center justify-center rounded transition-all"
                        style={{
                          padding: '2px 8px',
                          border: '1px solid var(--accent)',
                          color: 'var(--accent)',
                          fontSize: 11,
                          fontWeight: 500,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'var(--accent-14)'
                          e.currentTarget.style.boxShadow = '0 0 8px rgba(167,139,250,0.2)'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent'
                          e.currentTarget.style.boxShadow = 'none'
                        }}
                      >
                        {t('sidebar.adopt') ?? 'Adopt'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
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
            icon="⚙"
            title={t('settings.title')}
            onClick={toggleSettings}
            size={26}
          />
        </div>
      </div>

      {/* ── Create Project Modal ── */}
      <Modal
        open={createProjOpen}
        onClose={closeCreateProj}
        title={t('sidebar.createProject') ?? 'Create Project'}
        maxWidth="max-w-lg"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.projectName') ?? 'Project Name'}
            </label>
            <input
              type="text"
              value={projName}
              onChange={(e) => setProjName(e.target.value)}
              onKeyDown={handleNameKeyDown}
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
              onKeyDown={handlePathKeyDown}
              onBlur={(e) => {
                handlePathApply()
                e.currentTarget.style.borderColor = 'var(--border-strong)'
                e.currentTarget.style.boxShadow = 'none'
              }}
              placeholder={homeDir}
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.2)' }}
            />
            <div className="text-[10px] mt-1" style={{ color: 'var(--text-faint)' }}>
              {t('sidebar.pathHint') ?? '回车或失焦以应用路径'}
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                {t('sidebar.browse') ?? '浏览'}
              </label>
              <button
                onClick={handleRefresh}
                title={t('sidebar.refresh') ?? '刷新'}
                className="flex items-center gap-1 px-2 py-0.5 rounded transition-all"
                style={{
                  border: '1px solid var(--border-strong)',
                  color: 'var(--text-secondary)',
                  fontSize: 11,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent)'
                  e.currentTarget.style.color = 'var(--accent)'
                  e.currentTarget.style.background = 'var(--accent-10)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-strong)'
                  e.currentTarget.style.color = 'var(--text-secondary)'
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <IconRefresh width={10} height={10} />
                {t('sidebar.refresh') ?? '刷新'}
              </button>
            </div>
            <div
              className="overflow-y-auto"
              style={{
                height: 200,
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 5,
                padding: 4,
              }}
            >
              {/* ".." parent entry */}
              <div
                onClick={handleGoUp}
                className="flex items-center gap-2 px-2.5 py-1.5 text-xs transition-all"
                style={{
                  borderRadius: 4,
                  color: 'var(--text-faint)',
                  cursor: getParentPath(browsePath) ? 'pointer' : 'not-allowed',
                  opacity: getParentPath(browsePath) ? 1 : 0.5,
                }}
                onMouseEnter={(e) => {
                  if (!getParentPath(browsePath)) return
                  e.currentTarget.style.background = 'rgba(167,139,250,0.08)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <IconArrowUp width={14} height={14} />
                <span>..</span>
              </div>

              {/* Loading state */}
              {browseLoading && (
                <div className="flex items-center justify-center py-6 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {t('sidebar.loading') ?? '加载中…'}
                </div>
              )}

              {/* Error state */}
              {!browseLoading && !browseNotFound && browseError && (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-xs">
                  <IconWarning width={20} height={20} style={{ color: 'var(--warning)' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{browseError}</div>
                  <button
                    onClick={handleRefresh}
                    className="px-2 py-0.5 rounded transition-all"
                    style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', fontSize: 11 }}
                  >
                    {t('sidebar.retry') ?? '重试'}
                  </button>
                </div>
              )}

              {/* Path doesn't exist — will be auto-created on submit */}
              {!browseLoading && browseNotFound && (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-xs">
                  <IconFolderPlus width={20} height={20} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 6px rgba(167,139,250,0.4))' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{t('sidebar.pathWillBeCreated') ?? '该路径不存在，创建项目时将自动创建'}</div>
                </div>
              )}

              {/* Empty state */}
              {!browseLoading && !browseNotFound && !browseError && browseEntries.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-1 py-6 text-xs">
                  <IconFolder width={24} height={24} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 6px rgba(167,139,250,0.4))' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{t('sidebar.emptyDir') ?? '空目录'}</div>
                </div>
              )}

              {/* Directory entries */}
              {!browseLoading && !browseNotFound && !browseError && browseEntries.map((entry) => (
                <div
                  key={entry.name}
                  onClick={() => handleEnterDir(entry)}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs transition-all"
                  style={{
                    borderRadius: 4,
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(167,139,250,0.08)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <IconFolder width={14} height={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                  <span className="truncate">{entry.name}</span>
                  <span className="ml-auto" style={{ color: 'var(--text-faint)', fontSize: 11 }}>{entry.size ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <ModalCancel onClick={closeCreateProj}>
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

      {/* ── Rename Modal (Project or Session, reused) ── */}
      <Modal
        open={renameOpen}
        onClose={() => { setRenameOpen(false); setRenameTarget(null); setRenameName('') }}
        title={
          renameTarget?.type === 'project'
            ? (t('sidebar.renameProject') ?? 'Rename Project')
            : (t('sidebar.renameSession') ?? 'Rename Session')
        }
        maxWidth="max-w-sm"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {renameTarget?.type === 'project'
                ? (t('sidebar.projectName') ?? 'Project Name')
                : t('sidebar.sessionName')}
            </label>
            <input
              type="text"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              placeholder={
                renameTarget?.type === 'project'
                  ? (t('sidebar.projectName') ?? 'my-project')
                  : (t('sidebar.sessionName') ?? 'dev-server')
              }
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
              onClick={handleRename}
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

      {/* ── Repair Project Path Modal: shown when user clicks a workspace whose path no longer exists. */}
      <Modal
        open={repairDialogOpen}
        onClose={closeRepairDialog}
        title={t('sidebar.repairTitle') ?? 'Project Path Not Found'}
        maxWidth="max-w-lg"
      >
        {repairProject && (
          <div className="space-y-4">
            <div
              className="rounded-md px-3 py-2"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--danger-30)',
                fontSize: 12,
                color: 'var(--text-secondary)',
              }}
            >
              <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>
                {t('sidebar.repairOldPathLabel') ?? 'Original path (no longer exists)'}
              </div>
              <div
                className="truncate"
                style={{
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
                  fontSize: 11,
                  color: 'var(--danger)',
                }}
              >
                {repairProject.project.path}
              </div>
            </div>

            <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>
              {t('sidebar.repairHint') ??
                'The project directory may have been moved or renamed. Browse to its new location below.'}
            </p>

            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
                {t('sidebar.repairNewPathLabel') ?? 'New Path'}
              </label>
              <input
                type="text"
                value={repairPath}
                onChange={(e) => setRepairPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleRepairPathApply()
                  }
                }}
                onBlur={(e) => {
                  handleRepairPathApply()
                  e.currentTarget.style.borderColor = 'var(--border-strong)'
                  e.currentTarget.style.boxShadow = 'none'
                }}
                placeholder="/home/user/project"
                className={inputClass}
                style={inputStyle}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.2)' }}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                  {t('sidebar.repairBrowse') ?? 'Browse'}
                </label>
                <button
                  onClick={handleRepairRefresh}
                  title={t('sidebar.refresh') ?? 'Refresh'}
                  className="flex items-center gap-1 px-2 py-0.5 rounded transition-all"
                  style={{
                    border: '1px solid var(--border-strong)',
                    color: 'var(--text-secondary)',
                    fontSize: 11,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--accent)'
                    e.currentTarget.style.color = 'var(--accent)'
                    e.currentTarget.style.background = 'var(--accent-10)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--border-strong)'
                    e.currentTarget.style.color = 'var(--text-secondary)'
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <IconRefresh width={10} height={10} />
                  {t('sidebar.refresh') ?? 'Refresh'}
                </button>
              </div>
              <div
                className="overflow-y-auto"
                style={{
                  height: 200,
                  background: 'var(--bg-base)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 5,
                  padding: 4,
                }}
              >
                {/* ".." parent entry */}
                <div
                  onClick={handleRepairGoUp}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs transition-all"
                  style={{
                    borderRadius: 4,
                    color: 'var(--text-faint)',
                    cursor: getParentPath(repairBrowsePath) ? 'pointer' : 'not-allowed',
                    opacity: getParentPath(repairBrowsePath) ? 1 : 0.5,
                  }}
                  onMouseEnter={(e) => {
                    if (!getParentPath(repairBrowsePath)) return
                    e.currentTarget.style.background = 'rgba(167,139,250,0.08)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <IconArrowUp width={14} height={14} />
                  <span>..</span>
                </div>

                {/* Loading state */}
                {repairBrowseLoading && (
                  <div className="flex items-center justify-center py-6 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('sidebar.loading') ?? 'Loading…'}
                  </div>
                )}

                {/* Error state */}
                {!repairBrowseLoading && repairBrowseError && (
                  <div className="flex flex-col items-center justify-center gap-2 py-6 text-xs">
                    <IconWarning width={20} height={20} style={{ color: 'var(--warning)' }} />
                    <div style={{ color: 'var(--text-muted)' }}>{repairBrowseError}</div>
                    <button
                      onClick={handleRepairRefresh}
                      className="px-2 py-0.5 rounded transition-all"
                      style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', fontSize: 11 }}
                    >
                      {t('sidebar.retry') ?? 'Retry'}
                    </button>
                  </div>
                )}

                {/* Empty state */}
                {!repairBrowseLoading && !repairBrowseError && repairBrowseEntries.length === 0 && (
                  <div className="flex flex-col items-center justify-center gap-1 py-6 text-xs">
                    <IconFolder width={24} height={24} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 6px rgba(167,139,250,0.4))' }} />
                    <div style={{ color: 'var(--text-muted)' }}>{t('sidebar.emptyDir') ?? 'Empty directory'}</div>
                  </div>
                )}

                {/* Directory entries */}
                {!repairBrowseLoading && !repairBrowseError && repairBrowseEntries.map((entry) => (
                  <div
                    key={entry.name}
                    onClick={() => handleRepairEnterDir(entry)}
                    className="flex items-center gap-2 px-2.5 py-1.5 text-xs transition-all"
                    style={{
                      borderRadius: 4,
                      color: 'var(--text-secondary)',
                      cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(167,139,250,0.08)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <IconFolder width={14} height={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
                    <span className="truncate">{entry.name}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <ModalCancel onClick={closeRepairDialog}>
                {t('sidebar.cancel') ?? 'Cancel'}
              </ModalCancel>
              <ModalPrimary onClick={handleRepairUpdate} disabled={!repairPath.trim() || repairSubmitting}>
                {repairSubmitting ? t('sidebar.repairUpdating') ?? 'Updating…' : t('sidebar.repairUpdate') ?? 'Update Path'}
              </ModalPrimary>
            </div>
          </div>
        )}
      </Modal>

      {/* ── Cover-Conflict Modal: shown when POST /projects returns 409.
          Offers to switch to the existing project that already covers the
          requested path (instead of creating a duplicate). */}
      <Modal
        open={!!coverConflict}
        onClose={() => setCoverConflict(null)}
        title={t('sidebar.coverConflictTitle') ?? 'Project Already Exists'}
        maxWidth="max-w-md"
      >
        {coverConflict && (
          <div className="space-y-4">
            <p style={{ fontSize: 13, color: 'var(--text-primary)' }}>
              {coverConflict.reason === 'exact_path'
                ? (t('sidebar.coverConflictExact', { name: coverConflict.coveringProject.name }) ??
                  `A project named "${coverConflict.coveringProject.name}" already uses this exact path.`)
                : (t('sidebar.coverConflictWorktree', { name: coverConflict.coveringProject.name }) ??
                  `A project named "${coverConflict.coveringProject.name}" already covers this path — they belong to the same git repository.`)}
            </p>
            <div
              className="rounded-md px-3 py-2 truncate"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-strong)',
                fontSize: 11,
                color: 'var(--text-muted)',
                fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
              }}
              title={coverConflict.coveringProject.path}
            >
              {coverConflict.coveringProject.path}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>
              {t('sidebar.coverConflictHint') ??
                'Switch to the existing project instead, or choose a different path.'}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <ModalCancel onClick={() => setCoverConflict(null)}>
                {t('sidebar.cancel') ?? 'Cancel'}
              </ModalCancel>
              <ModalPrimary
                onClick={() => {
                  const coverId = coverConflict.coveringProject.id
                  setActiveProject(coverId)
                  setActiveWorkspace(null)
                  setCoverConflict(null)
                  setCreateProjOpen(false)
                  setProjName('')
                  setProjPath(homeDir)
                  addToast(
                    'success',
                    t('sidebar.coverConflictSwitched', { name: coverConflict.coveringProject.name }) ??
                      `Switched to project "${coverConflict.coveringProject.name}"`,
                  )
                }}
              >
                {t('sidebar.coverConflictSwitch') ?? 'Switch to existing'}
              </ModalPrimary>
            </div>
          </div>
        )}
      </Modal>

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
