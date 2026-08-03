import { useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../stores/appStore'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { useAttention, type AttentionReason } from '../../hooks/useAttention'
import { api, ApiError } from '../../api/client'
import { BookIcon } from '../Icons/BookIcon'
import { IconFolder, IconFolderPlus, IconArrowUp, IconRefresh, IconWarning, IconPlus, IconPower, IconPencil, IconTrash, IconSettings } from '../FileManager/icons'
import { GitHubIcon } from '../Icons/GitHubIcon'
import type { Session, DuplicateGroup, FileEntry, ExternalSession, Project, Workspace } from '../../api/client'
import { getParentPath } from '../../utils/path'
import { aggregateStatus, type AcpActivity } from '../../utils/agentAggregate'
import { APP_VERSION, GITHUB_REPO_URL } from '../../version'
import { Modal } from '../Modal/Modal'
import { ConfirmDialog } from '../Modal/ConfirmDialog'
import { DuplicateProjectsDialog } from './DuplicateProjectsDialog'
import { UpdateBadge } from './UpdateBadge'
import { AgentPicker } from '../AgentPicker/AgentPicker'
import { useAgentStore } from '../../stores/agentStore'
import { OmniTermLogo } from '../PixelUI/OmniTermLogo'
import { CountBadge } from '../Common/CountBadge'
import { FolderSprite, GitBranchSprite, SignalBarsSprite } from '../PixelUI'
import { PixelButton } from '../PixelUI/PixelButton'
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
    activateSession,
    setConnected,
    workspaceSessionMemory,
    clearWorkspaceSession,
  } = useAppStore()

  const activeExternalSession = useAppStore((s) => s.activeExternalSession)

  const toggleSidebarCollapsed = useAppStore((s) => s.toggleSidebarCollapsed)
  const multiplexer = useAppStore((s) => s.multiplexer)
  const setMultiplexer = useAppStore((s) => s.setMultiplexer)
  const toggleSettings = useAppStore((s) => s.toggleSettings)
  const toggleTmuxCheatsheet = useAppStore((s) => s.toggleTmuxCheatsheet)
  const pixelAnimationsEnabled = useAppStore((s) => s.pixelAnimationsEnabled)

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
  const [createSessOpen, setCreateSessOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<{ type: 'project' | 'session'; id: string; name: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{
    type: 'project' | 'session'
    id: string
    name: string
  } | null>(null)
  const [confirmRelease, setConfirmRelease] = useState<{ id: string; name: string | null } | null>(null)

  const [projName, setProjName] = useState('')
  const [projPath, setProjPath] = useState('')
  const [sessName, setSessName] = useState('')
  const [sessAgentId, setSessAgentId] = useState<string | null>(null)
  const [sessWorkspaceId, setSessWorkspaceId] = useState<string | null>(null)
  const [renameName, setRenameName] = useState('')
  const [homeDir, setHomeDir] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Create worktree modal state
  const [createWtOpen, setCreateWtOpen] = useState(false)
  const [createWtProjectId, setCreateWtProjectId] = useState<string | null>(null)
  const [createWtBranch, setCreateWtBranch] = useState('')
  const [createWtPath, setCreateWtPath] = useState('')
  const [createWtBaseBranch, setCreateWtBaseBranch] = useState('')
  const [createWtBranches, setCreateWtBranches] = useState<string[]>([])
  const [createWtCurrentBranch, setCreateWtCurrentBranch] = useState('')
  const [createWtBranchesLoading, setCreateWtBranchesLoading] = useState(false)
  // 非 git 仓库时弹确认框：询问是否先初始化 git（用户确认后自动 init + 继续）
  const [gitInitConfirm, setGitInitConfirm] = useState<{
    projectId: string
    projectName: string
    /** open-modal = 打开创建弹窗前检测到；submit-worktree = 提交创建时检测到（带表单参数重试） */
    mode: 'open-modal' | 'submit-worktree'
    /** 项目目录是否有 .gitignore——无则初始化会提交全部现有文件，确认框需附加警告 */
    hasGitignore: boolean
    params?: { branch: string; path: string; baseBranch: string }
  } | null>(null)

  // Delete worktree confirmation dialog
  const [confirmDeleteWt, setConfirmDeleteWt] = useState<{ projectId: string; path: string; label: string } | null>(null)
  const [confirmDeleteWtChecked, setConfirmDeleteWtChecked] = useState(false)

  // Browse state for the create-project modal's embedded directory list
  const [browsePath, setBrowsePath] = useState('')
  const [browseEntries, setBrowseEntries] = useState<FileEntry[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  // True when the fetched path doesn't exist (404). The backend's
  // create_project auto-creates non-existent paths, so this is friendly
  // info rather than a hard error — the UI shows a "will be created" hint.
  const [browseNotFound, setBrowseNotFound] = useState(false)
  const [autocompleteActiveIndex, setAutocompleteActiveIndex] = useState(-1)
  const autocompleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  // Fetch directory entries for the new-project modal's browse list.
  // When `prefix` is provided, only entries whose name starts with it
  // (case-insensitive) are kept — this powers real-time path autocomplete.
  const fetchDirs = useCallback(async (path: string, prefix?: string) => {
    setBrowseLoading(true)
    setBrowseError(null)
    setBrowseNotFound(false)
    try {
      const data = await api.listDirs(path)
      let dirs = data.files.filter(
        (f) => f.path_type === 'Dir' || f.path_type === 'SymlinkDir',
      )
      if (prefix) {
        const lower = prefix.toLowerCase()
        dirs = dirs.filter((f) => f.name.toLowerCase().startsWith(lower))
      }
      setBrowseEntries(dirs)
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 404) {
        setBrowseNotFound(true)
        setBrowseEntries([])
      } else {
        setBrowseError((e instanceof Error ? e.message : String(e)) || '无法访问该目录')
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
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 404) {
        setRepairBrowseEntries([])
      } else {
        setRepairBrowseError((e instanceof Error ? e.message : String(e)) || '无法访问该目录')
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

  // Real-time path autocomplete — debounced fetch on every keystroke.
  // Parses the input: "/home/pax/Om" → list "/home/pax/" and filter by "Om".
  useEffect(() => {
    const input = projPath.trim()
    if (!input || input === '/') {
      setBrowsePath('')
      setBrowseEntries([])
      setBrowseError(null)
      setBrowseNotFound(false)
      return
    }

    const lastSlash = input.lastIndexOf('/')
    const dirPart = lastSlash >= 0 ? input.slice(0, lastSlash + 1) : input
    const prefix = lastSlash >= 0 ? input.slice(lastSlash + 1) : ''

    if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current)
    autocompleteTimerRef.current = setTimeout(() => {
      setBrowsePath(dirPart)
      fetchDirs(dirPart, prefix || undefined)
    }, 200)

    return () => {
      if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current)
    }
  }, [projPath, fetchDirs])

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
      setProjPath(info.home_dir)
      if (info.multiplexer) setMultiplexer(info.multiplexer)
    }).catch(() => {
      // fallback: leave projPath empty, user fills it in
    })
  }, [setMultiplexer])

  // Reset browse state when the create-project modal opens
  useEffect(() => {
    if (createProjOpen && homeDir) {
      setBrowsePath(homeDir)
      setProjPath(homeDir + '/')
      setBrowseError(null)
      setBrowseNotFound(false)
    }
  }, [createProjOpen, homeDir])

  // Unified close: clear form + browse state
  const closeCreateProj = () => {
    setCreateProjOpen(false)
    setProjName('')
    setProjPath(homeDir + '/')
    setBrowsePath('')
    setBrowseEntries([])
    setBrowseError(null)
    setBrowseNotFound(false)
    setAutocompleteActiveIndex(-1)
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

  // Browse handlers for the new-project modal
  const handleEnterDir = (entry: FileEntry) => {
    const dirPart = browsePath.endsWith('/') ? browsePath : `${browsePath}/`
    setProjPath(`${dirPart}${entry.name}/`)
  }

  const handleGoUp = () => {
    const parent = getParentPath(browsePath)
    if (!parent) return
    setProjPath(parent)
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
      setProjPath(homeDir + '/')
    } catch (e) {
      // 409 Conflict: the new path is already covered by an existing
      // project. Surface a switch-to-existing dialog instead of letting
      // the generic toast dismiss.
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as Record<string, unknown> | undefined
        if (body?.error === 'already_covered') {
          const coveringProject = body.covering_project as { id: string; name: string; path: string }
          const reason = body.reason as 'exact_path' | 'worktree_child'
          setCoverConflict({
            coveringProject,
            reason,
          })
          return
        }
      }
      // api client already shows error toast for other failures
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteWorktree = async () => {
    if (!confirmDeleteWt) return
    setSubmitting(true)
    try {
      await api.deleteWorktree(confirmDeleteWt.projectId, confirmDeleteWt.path)
      await loadWorktrees(confirmDeleteWt.projectId)
      // If the deleted worktree was active, clear the workspace selection
      if (activeWorkspaceId) {
        const wtList = worktrees[confirmDeleteWt.projectId] || []
        const stillExists = wtList.some(w => w.id === activeWorkspaceId)
        if (!stillExists) {
          setActiveWorkspace(null)
          setActiveSession(null)
        }
      }
      addToast('success', t('sidebar.worktreeDeleted', { name: confirmDeleteWt.label }) ?? `Worktree "${confirmDeleteWt.label}" deleted`)
      setConfirmDeleteWt(null)
      setConfirmDeleteWtChecked(false)
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
    }
  }

  // 创建 worktree 的公共提交逻辑：成功时刷新 + 清理弹窗状态；失败时若
  // 后端返回 not_a_git_repo 且未带 init，则弹确认框询问是否先初始化 git。
  const submitWorktree = async (params: {
    projectId: string
    branch: string
    path: string
    baseBranch: string
    init: boolean
  }): Promise<boolean> => {
    try {
      await api.createWorktree(params.projectId, {
        branch: params.branch,
        path: params.path.trim() || undefined,
        base_branch: params.baseBranch.trim() || undefined,
        init: params.init,
      })
      await loadWorktrees(params.projectId)
      addToast('success', t('sidebar.worktreeCreated', { branch: params.branch }) ?? `Worktree "${params.branch}" created`)
      setCreateWtOpen(false)
      setCreateWtProjectId(null)
      setCreateWtBranch('')
      setCreateWtPath('')
      setCreateWtBaseBranch('')
      setCreateWtBranches([])
      setCreateWtCurrentBranch('')
      return true
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { code?: string; has_gitignore?: boolean }) : undefined
      if (body?.code === 'not_a_git_repo' && !params.init) {
        const project = projects.find((p) => p.id === params.projectId)
        setGitInitConfirm({
          projectId: params.projectId,
          projectName: project?.name ?? params.projectId,
          mode: 'submit-worktree',
          hasGitignore: body.has_gitignore ?? true,
          params: { branch: params.branch, path: params.path, baseBranch: params.baseBranch },
        })
      } else {
        addToast('error', err instanceof Error ? err.message : String(err))
      }
      return false
    }
  }

  const handleCreateWorktree = async () => {
    if (!createWtProjectId || !createWtBranch.trim()) return
    setSubmitting(true)
    await submitWorktree({
      projectId: createWtProjectId,
      branch: createWtBranch.trim(),
      path: createWtPath,
      baseBranch: createWtBaseBranch,
      init: false,
    })
    setSubmitting(false)
  }

  // 用户确认初始化 git 后：先 init，再继续（打开弹窗 or 带 init 重试创建）
  const handleConfirmGitInit = async () => {
    if (!gitInitConfirm) return
    setSubmitting(true)
    try {
      await api.initGit(gitInitConfirm.projectId)
      if (gitInitConfirm.mode === 'submit-worktree' && gitInitConfirm.params) {
        const { branch, path, baseBranch } = gitInitConfirm.params
        const ok = await submitWorktree({
          projectId: gitInitConfirm.projectId,
          branch,
          path,
          baseBranch,
          init: true,
        })
        if (ok) setGitInitConfirm(null)
      } else {
        // open-modal 模式：初始化成功后重新加载分支并打开创建弹窗
        setGitInitConfirm(null)
        setCreateWtProjectId(gitInitConfirm.projectId)
        setCreateWtBranch('')
        setCreateWtPath('')
        setCreateWtBaseBranch('')
        setCreateWtBranches([])
        setCreateWtCurrentBranch('')
        setCreateWtBranchesLoading(true)
        try {
          const data = await api.listBranches(gitInitConfirm.projectId)
          setCreateWtBranches(data.branches)
          setCreateWtCurrentBranch(data.current)
        } catch {
          // 分支加载失败也照常打开弹窗（下拉显示默认项）
        } finally {
          setCreateWtBranchesLoading(false)
        }
        setCreateWtOpen(true)
      }
    } catch (err) {
      addToast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleCreateSession = async () => {
    if (!activeProjectId || !sessWorkspaceId) return
    // Find the target worktree path (captured when "+" was clicked)
    const wtList = worktrees[activeProjectId] || []
    const targetWt = wtList.find(w => w.id === sessWorkspaceId)
    if (!targetWt) return

    setSubmitting(true)
    try {
      const name = sessName.trim() || (sessAgentId
        ? (() => {
            const agent = useAgentStore.getState().agents.find((a) => a.id === sessAgentId)
            if (!agent) return undefined
            const now = new Date()
            const ts = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
            return `${agent.display_name}_${ts}`
          })()
        : undefined)
      const newSession = await api.createSession(
        activeProjectId,
        targetWt.path,
        name || undefined,
        undefined,
        sessAgentId ? 'acp' : 'tmux',
        sessAgentId ?? undefined,
      )
      await loadSessions()
      // Auto-activate the newly created session so the terminal pane
      // switches to it immediately. Atomic (clears external + sets
      // activeSession + updates workspace memory in one set()).
      activateSession(newSession.id)
      addToast('success', t('sidebar.sessionCreated', { name: sessName.trim() || t('sidebar.unnamed') }) ?? `Session created`)
      setCreateSessOpen(false)
      setSessName('')
      setSessAgentId(null)
      setSessWorkspaceId(null)
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
    // Clear active session immediately so FileManager stops requesting
    // files for a session whose tmux process is about to be killed.
    if (activeSessionId === confirmDelete.id) {
      setActiveSession(null)
    }
    try {
      await api.deleteSession(confirmDelete.id)
      await loadSessions()
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

  // 手动释放 ACP agent 子进程（保留会话记录，进程可后续恢复）。
  // 区别于删除：不删 DB 记录，仅 kill supervisor 中驻留的 codebuddy --acp 等进程。
  const handleReleaseSession = async (id: string) => {
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

  const handleConfirmRelease = () => {
    if (!confirmRelease) return
    handleReleaseSession(confirmRelease.id)
    setConfirmRelease(null)
  }

  // Enter in name field = create project
  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreateProject()
    }
  }

  // Path field keyboard navigation for autocomplete
  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setAutocompleteActiveIndex((prev) => {
        const next = prev + 1
        return next < browseEntries.length ? next : prev
      })
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setAutocompleteActiveIndex((prev) => {
        const next = prev - 1
        return next >= 0 ? next : prev
      })
      return
    }
    if (e.key === 'Tab' && browseEntries.length > 0) {
      e.preventDefault()
      completAutocomplete(
        autocompleteActiveIndex >= 0 ? autocompleteActiveIndex : 0,
      )
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (autocompleteActiveIndex >= 0) {
        completAutocomplete(autocompleteActiveIndex)
      }
    }
    if (e.key === 'Escape') {
      setAutocompleteActiveIndex(-1)
    }
  }

  // Complete the autocomplete suggestion at the given index
  const completAutocomplete = (index: number) => {
    const entry = browseEntries[index]
    if (!entry) return
    const dirPart = browsePath.endsWith('/') ? browsePath : `${browsePath}/`
    setProjPath(`${dirPart}${entry.name}/`)
    setAutocompleteActiveIndex(-1)
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

  const inputClass = "w-full px-3 py-2 text-sm focus:outline-none transition-all"
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
          projects.map((proj) => {
            const isExpanded = expandedProjects.has(proj.id)
            // undefined = 尚未加载（显示 loading），[] = 已加载但为空
            const wtLoaded = worktrees[proj.id] !== undefined
            const wtList = worktrees[proj.id] || []
            const projAgg = aggregateStatus(
              wtList.flatMap((wt) => sessionsForWorktree(proj.id, wt.path)),
              attention.reasonFor,
              acpActivityFor,
            )

            return (
              <div key={proj.id} className="sidebar-project-card">
                {/* Project header — stacked name + path */}
                <div
                  className="sidebar-project-header"
                  onClick={() => toggleProject(proj.id)}
                >
                  <span
                    className={projAgg === 'working' || projAgg === 'blocked' ? 'activity-pulse' : ''}
                    style={{
                      fontSize: 10,
                      color: projAgg === 'blocked'
                        ? 'var(--warning)'
                        : projAgg === 'done'
                          ? 'var(--success)'
                          : isExpanded || projAgg === 'working'
                            ? 'var(--text-secondary)'
                            : 'var(--text-faint)',
                      marginTop: 2,
                    }}
                  >
                    {isExpanded ? '▼' : '▶'}
                  </span>
                  <div className="proj-info">
                    <span className="proj-name">{proj.name}</span>
                    {/* 容器 direction:rtl 只为左侧省略号；bdi 隔离避免尾部 / 被 bidi 挪到开头 */}
                    <span className="proj-path"><bdi dir="ltr">{proj.path}</bdi></span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={async (e) => {
                        e.stopPropagation()
                        if (!isExpanded) {
                          setExpandedProjects(prev => {
                            const next = new Set(prev)
                            next.add(proj.id)
                            return next
                          })
                          await Promise.all([loadWorktrees(proj.id), loadSessions(proj.id)])
                        }
                        setCreateWtProjectId(proj.id)
                        setCreateWtBranch('')
                        setCreateWtPath('')
                        setCreateWtBaseBranch('')
                        setCreateWtBranches([])
                        setCreateWtCurrentBranch('')
                        // 预检 git 仓库：非 git 仓库先弹确认框询问是否初始化，
                        // 确认前不打开创建弹窗（避免填完分支名后才发现创建不了）
                        setCreateWtBranchesLoading(true)
                        try {
                          const data = await api.listBranches(proj.id)
                          setCreateWtBranches(data.branches)
                          setCreateWtCurrentBranch(data.current)
                          setCreateWtOpen(true)
                        } catch (err) {
                          const body = err instanceof ApiError ? (err.body as { code?: string; has_gitignore?: boolean }) : undefined
                          if (body?.code === 'not_a_git_repo') {
                            setGitInitConfirm({
                              projectId: proj.id,
                              projectName: proj.name,
                              mode: 'open-modal',
                              hasGitignore: body.has_gitignore ?? true,
                            })
                          } else {
                            // 其他错误（网络/权限等）：照常打开弹窗，分支下拉显示默认
                            setCreateWtOpen(true)
                          }
                        } finally {
                          setCreateWtBranchesLoading(false)
                        }
                      }}
                      className="row-action flex-shrink-0 flex items-center justify-center transition-all"
                      style={{ width: 20, height: 20, borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--border-strong)', color: 'var(--text-faint)', fontSize: 11 }}
                      title={t('sidebar.createWorktree') ?? 'Create Worktree'}
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
                      <IconPlus width={14} height={14} />
                    </button>
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
                  <div className="sidebar-project-body">
                    {wtList.length === 0 ? (
                      <div className="px-2 py-1.5" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                        {wtLoaded
                          ? (t('sidebar.noWorktrees') ?? 'No worktrees found')
                          : (t('sidebar.loading') ?? 'Loading...')}
                      </div>
                    ) : (
                      wtList.map((wt) => {
                        const isWtActive = activeWorkspaceId === wt.id
                        const wtSessions = sessionsForWorktree(proj.id, wt.path)
                        const wtAgg = aggregateStatus(wtSessions, attention.reasonFor, acpActivityFor)
                        const isWtExpanded = isWtActive

                        return (
                          <div key={wt.id} className={`sidebar-wt-slot ${isWtActive ? 'active' : ''}`}>
                            {/* Worktree row */}
                            <div
                              className="sidebar-wt-row"
                              onClick={() => handleWorkspaceClick(proj, wt)}
                            >
                              <span className={`selected-cursor ${isWtActive ? (pixelAnimationsEnabled ? '' : 'no-blink') : 'inactive'}`}>▶</span>
                              <GitBranchSprite
                                size={14}
                                color={
                                  wtAgg === 'blocked'
                                    ? 'var(--warning)'
                                    : wtAgg === 'done'
                                      ? 'var(--success)'
                                      : isWtActive || wtAgg === 'working'
                                        ? '#58A6FF'
                                        : '#A89474'
                                }
                                className={wtAgg === 'working' || wtAgg === 'blocked' ? 'activity-pulse' : ''}
                              />
                              <span className="branch-name">{wt.label}</span>
                              <CountBadge count={wtSessions.length} />
                              <button
                                className="sidebar-wt-add-btn"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setActiveProject(proj.id)
                                  setActiveWorkspace(wt.id)
                                  setSessWorkspaceId(wt.id)
                                  setCreateSessOpen(true)
                                }}
                                title={t('sidebar.createSession')}
                              >
                                <IconPlus />
                              </button>
                              {!wt.is_main && (
                                <button
                                  className="sidebar-wt-add-btn"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setConfirmDeleteWt({ projectId: proj.id, path: wt.path, label: wt.label })
                                    setConfirmDeleteWtChecked(false)
                                  }}
                                  title={t('sidebar.deleteWorktree') ?? 'Delete Worktree'}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.borderColor = 'var(--danger)'
                                    e.currentTarget.style.color = 'var(--danger)'
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.borderColor = ''
                                    e.currentTarget.style.color = ''
                                  }}
                                >
                                  <IconTrash width={14} height={14} />
                                </button>
                              )}
                            </div>

                            {/* Sessions inline under active worktree */}
                            {isWtExpanded && (
                              <div className="sidebar-session-list">
                                {wtSessions.map((s) => {
                                  const isSessionActive = activeSessionId === s.id
                                  const sessionKey = s.id
                                  const attnReason = attention.reasonFor(sessionKey)
                                  // tmux 的 agent_state 与 ACP 的 chatStore 派生状态归一，
                                  // 状态点/tooltip 两类会话表现一致
                                  const activity =
                                    s.runtime_kind === 'acp'
                                      ? acpActivityFor(s.id)
                                      : s.agent_state === 'waiting'
                                        ? 'waiting'
                                        : s.agent_state === 'running' || s.is_active
                                          ? 'running'
                                          : undefined
                                  const dotColor = attnReason
                                    ? attnReason === 'decision'
                                      ? 'var(--warning)'
                                      : attnReason === 'error'
                                        ? 'var(--danger)'
                                        : 'var(--success)'
                                    : activity === 'waiting'
                                      ? 'var(--warning)'
                                      : activity === 'running'
                                        ? 'var(--accent)'
                                        : 'var(--text-faint)'
                                  return (
                                    <div
                                      key={s.id}
                                      className={`sidebar-session-item ${isSessionActive ? 'active' : ''}`}
                                      onClick={() => {
                                        activateSession(s.id)
                                        attention.setActive(sessionKey)
                                      }}
                                    >
                                      {/* ACP kind badge — 绝对定位叠加在左侧 28px 缩进槽，不占行内布局；
                                          绿字=进程驻留（未释放），灰字=已释放 */}
                                      {s.runtime_kind === 'acp' && (
                                        <span
                                          className="status-badge-3d font-pixel"
                                          style={{
                                            position: 'absolute',
                                            left: -22,
                                            top: '50%',
                                            transform: 'translateY(-50%)',
                                            padding: '1px 3px',
                                            background: 'var(--wood-shadow, #3A2E1F)',
                                            fontSize: 8,
                                            lineHeight: '10px',
                                            color: s.acp_process_alive ? '#7EE787' : 'var(--text-faint)',
                                          }}
                                          title={
                                            s.acp_process_alive
                                              ? t('sidebar.acpRunning')
                                              : t('sidebar.acpReleased')
                                          }
                                        >
                                          A
                                        </span>
                                      )}
                                      {/* Running indicator dot */}
                                      <div
                                        className="flex-shrink-0"
                                        style={{
                                          width: 6,
                                          height: 6,
                                          background: dotColor,
                                        }}
                                        title={
                                          activity === 'waiting'
                                            ? t('sidebar.agentWaiting')
                                            : undefined
                                        }
                                      />
                                      <span className="session-name">
                                        {s.name || s.tmux_session_name}
                                      </span>
                                      {/* Attention badge */}
                                      {attnReason && (
                                        <span
                                          className="session-attn animate-pulse"
                                          style={{
                                            color: attnReason === 'decision'
                                              ? 'var(--warning)'
                                              : attnReason === 'error'
                                                ? 'var(--danger)'
                                                : 'var(--success)',
                                          }}
                                          title={
                                            attnReason === 'decision' ? t('sidebar.attnDecision') :
                                            attnReason === 'error' ? t('sidebar.attnError') : t('sidebar.attnDone')
                                          }
                                        >
                                          {attnReason === 'decision' ? '⏳' : attnReason === 'error' ? '⚠' : '✓'}
                                        </span>
                                      )}
                                      {/* Release 按钮仅在进程驻留时可用——已释放会话无可释放对象 */}
                                      {s.runtime_kind === 'acp' && s.acp_process_alive && (
                                        <ReleaseButton
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            const chatState = useChatStore.getState().states[s.id]
                                            if (chatState?.sending) {
                                              setConfirmRelease({ id: s.id, name: s.name ?? null })
                                            } else {
                                              handleReleaseSession(s.id)
                                            }
                                          }}
                                        />
                                      )}
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
                      background: activeExternalSession === s.name ? 'var(--accent-10)' : 'transparent',
                      border: activeExternalSession === s.name ? '1px solid var(--accent-14)' : '1px solid transparent',
                    }}
                    onClick={() => {
                      setActiveSession(null)
                      setActiveExternalSession(activeExternalSession === s.name ? null : s.name)
                    }}
                    onMouseEnter={(e) => {
                      if (activeExternalSession === s.name) return
                      e.currentTarget.style.background = 'var(--accent-10)'
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
                            fontFamily: READER_FONT,
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
                            }).catch((e: unknown) => {
                              const msg = e instanceof Error ? e.message : String(e)
                              addToast('error', t('sidebar.adoptFailed', { msg }) ?? `Failed to adopt session: ${msg}`)
                            }).finally(() => {
                              setAdoptTarget(null)
                              setAdoptProjectId('')
                            })
                          }}
                          disabled={!adoptProjectId}
                          className="flex items-center justify-center pixel-press transition-all"
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
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent'
                          }}
                        >
                          ✓
                        </button>
                        <button
                          onClick={() => { setAdoptTarget(null); setAdoptProjectId('') }}
                          className="flex items-center justify-center transition-all"
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
                        className="flex-shrink-0 flex items-center justify-center pixel-press transition-all"
                        style={{
                          padding: '2px 8px',
                          border: '1px solid var(--accent)',
                          color: 'var(--accent)',
                          fontSize: 11,
                          fontWeight: 500,
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'var(--accent-14)'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent'
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
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
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
              onChange={(e) => {
                setProjPath(e.target.value)
                setAutocompleteActiveIndex(-1)
              }}
              onKeyDown={handlePathKeyDown}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-strong)'
                e.currentTarget.style.boxShadow = 'none'
              }}
              placeholder={homeDir}
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
            />
          </div>
          <div>
            <div
              className="overflow-y-auto overlay-scroll-content"
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
                  e.currentTarget.style.background = 'var(--accent-10)'
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
                  <IconFolderPlus width={20} height={20} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 6px var(--accent-14))' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{t('sidebar.pathWillBeCreated') ?? '该路径不存在，创建项目时将自动创建'}</div>
                </div>
              )}

              {/* Empty state */}
              {!browseLoading && !browseNotFound && !browseError && browseEntries.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-1 py-6 text-xs">
                  <IconFolder width={24} height={24} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 6px var(--accent-14))' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{t('sidebar.emptyDir') ?? '空目录'}</div>
                </div>
              )}

              {/* Directory entries */}
              {!browseLoading && !browseNotFound && !browseError && browseEntries.map((entry, idx) => {
                const highlighted = idx === autocompleteActiveIndex
                return (
                <div
                  key={entry.name}
                  onClick={() => handleEnterDir(entry)}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs transition-all"
                  style={{
                    borderRadius: 4,
                    color: highlighted ? 'var(--text-primary)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    background: highlighted ? 'var(--accent-10)' : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    setAutocompleteActiveIndex(idx)
                    e.currentTarget.style.background = 'var(--accent-10)'
                  }}
                  onMouseLeave={(e) => {
                    if (!highlighted) {
                      e.currentTarget.style.background = 'transparent'
                    }
                  }}
                >
                  <FolderSprite size={14} />
                  <span className="truncate">{entry.name}</span>
                  <span className="ml-auto" style={{ color: 'var(--text-faint)', fontSize: 11 }}>{entry.size ?? 0}</span>
                </div>
                )
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <PixelButton variant="secondary" onClick={closeCreateProj}>
              {t('sidebar.cancel')}
            </PixelButton>
            <PixelButton variant="accent" onClick={handleCreateProject} disabled={!projName.trim() || submitting}>
              {submitting ? t('sidebar.creating') : t('sidebar.create')}
            </PixelButton>
          </div>
        </div>
      </Modal>

      {/* ── Create Session Modal ── */}
      <Modal open={createSessOpen} onClose={() => { setCreateSessOpen(false); setSessName(''); setSessAgentId(null); setSessWorkspaceId(null) }} title={t('sidebar.createSession')} maxWidth="max-w-sm">
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
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('agentPicker.label')}
            </label>
            <AgentPicker
              value={sessAgentId}
              onChange={setSessAgentId}
              className={inputClass}
              style={inputStyle}
            />
            <p className="mt-1.5 text-xs" style={{ color: 'var(--text-secondary)', fontFamily: READER_FONT }}>
              {t('agentPicker.hint', { mux: multiplexer })}
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <PixelButton variant="secondary" onClick={() => { setCreateSessOpen(false); setSessName(''); setSessAgentId(null); setSessWorkspaceId(null) }}>
              {t('sidebar.cancel')}
            </PixelButton>
            <PixelButton variant="accent" onClick={handleCreateSession} disabled={submitting}>
              {submitting ? t('sidebar.creating') : t('sidebar.create')}
            </PixelButton>
          </div>
        </div>
      </Modal>

      {/* ── Create Worktree Modal ── */}
      <Modal
        open={createWtOpen}
        onClose={() => {
          setCreateWtOpen(false)
          setCreateWtProjectId(null)
          setCreateWtBranch('')
          setCreateWtPath('')
          setCreateWtBaseBranch('')
          setCreateWtBranches([])
          setCreateWtCurrentBranch('')
        }}
        title={t('sidebar.createWorktree') ?? 'Create Worktree'}
        maxWidth="max-w-sm"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.worktreeBranch') ?? 'Branch Name'}
            </label>
            <input
              type="text"
              value={createWtBranch}
              onChange={(e) => setCreateWtBranch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCreateWorktree() } }}
              placeholder="feature-xyz"
              autoFocus
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.worktreePath') ?? 'Target Path'} <span style={{ color: 'var(--text-dim)' }}>{t('sidebar.optional')}</span>
            </label>
            <input
              type="text"
              value={createWtPath}
              onChange={(e) => setCreateWtPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCreateWorktree() } }}
              placeholder={createWtProjectId
                ? (() => {
                    const proj = projects.find(p => p.id === createWtProjectId)
                    if (!proj) return ''
                    const p = proj.path.split('/')
                    const dirname = p[p.length - 1]
                    const parent = p.slice(0, -1).join('/') || '/'
                    return `${parent}/${dirname}-${createWtBranch || '<branch>'}`
                  })()
                : ''}
              className={inputClass}
              style={{ ...inputStyle, direction: 'rtl', textAlign: 'left' as const }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
            <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)', fontFamily: READER_FONT }}>
              {t('sidebar.worktreePathHint') ?? '留空则在项目同级目录创建 <项目名>-<分支名>'}
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.worktreeBaseBranch') ?? 'Base Branch'} <span style={{ color: 'var(--text-dim)' }}>{t('sidebar.optional')}</span>
            </label>
            <select
              value={createWtBaseBranch}
              onChange={(e) => setCreateWtBaseBranch(e.target.value)}
              className={inputClass}
              style={{
                ...inputStyle,
                cursor: 'pointer',
                fontFamily: READER_FONT,
              }}
            >
              <option value="">{
  createWtBranchesLoading
    ? (t('sidebar.loading') ?? 'Loading...')
    : createWtCurrentBranch
      ? (t('sidebar.worktreeDefaultBase', { branch: createWtCurrentBranch }) ?? `默认（${createWtCurrentBranch} 的最新提交）`)
      : (t('sidebar.worktreeDefaultBaseFallback') ?? '默认（当前分支的最新提交）')
}</option>
              {createWtBranches.map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <PixelButton variant="secondary" onClick={() => {
              setCreateWtOpen(false)
              setCreateWtProjectId(null)
              setCreateWtBranch('')
              setCreateWtPath('')
              setCreateWtBaseBranch('')
              setCreateWtBranches([])
              setCreateWtCurrentBranch('')
            }}>
              {t('sidebar.cancel')}
            </PixelButton>
            <PixelButton variant="accent" onClick={handleCreateWorktree} disabled={submitting || !createWtBranch.trim()}>
              {submitting ? t('sidebar.creating') : t('sidebar.create')}
            </PixelButton>
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
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <PixelButton variant="secondary" onClick={() => { setRenameOpen(false); setRenameTarget(null); setRenameName('') }}>
              {t('sidebar.cancel')}
            </PixelButton>
            <PixelButton
              variant="accent"
              onClick={handleRename}
              disabled={!renameName.trim() || renameName.trim() === renameTarget?.name || submitting}
            >
              {submitting ? t('sidebar.renaming') : t('sidebar.rename')}
            </PixelButton>
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

      {/* ── Delete Worktree Confirmation Dialog ── */}
      <Modal
        open={!!confirmDeleteWt}
        onClose={() => { setConfirmDeleteWt(null); setConfirmDeleteWtChecked(false) }}
        title={t('sidebar.deleteWorktree') ?? 'Delete Worktree'}
        maxWidth="max-w-sm"
      >
        <div className="space-y-4">
          <div
            className="px-3 py-2.5 rounded-md"
            style={{ background: 'var(--danger-12)', border: '1px solid var(--danger)', color: 'var(--text-primary)', fontSize: 12, fontFamily: READER_FONT }}
          >
            <p className="font-semibold mb-1" style={{ color: 'var(--danger)' }}>
              {t('sidebar.deleteWorktreeWarning') ?? '⚠ 不可逆操作'}
            </p>
            <p>
              {t('sidebar.deleteWorktreeConfirm', { name: confirmDeleteWt?.label ?? '', path: confirmDeleteWt?.path ?? '' }) ??
                `将永久删除 worktree「${confirmDeleteWt?.label ?? ''}」（${confirmDeleteWt?.path ?? ''}），包括其中所有未提交的更改。此操作无法撤销。`}
            </p>
          </div>
          <label
            className="flex items-center gap-2 cursor-pointer select-none"
            style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: READER_FONT }}
          >
            <input
              type="checkbox"
              checked={confirmDeleteWtChecked}
              onChange={(e) => setConfirmDeleteWtChecked(e.target.checked)}
              style={{ accentColor: 'var(--danger)' }}
            />
            {t('sidebar.deleteWorktreeAck') ?? '我已知悉，确认删除'}
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <PixelButton variant="secondary" onClick={() => { setConfirmDeleteWt(null); setConfirmDeleteWtChecked(false) }}>
              {t('sidebar.cancel')}
            </PixelButton>
            <PixelButton
              variant="danger"
              onClick={handleDeleteWorktree}
              disabled={!confirmDeleteWtChecked || submitting}
            >
              {submitting ? t('sidebar.deleting') ?? 'Deleting...' : t('sidebar.delete')}
            </PixelButton>
          </div>
        </div>
      </Modal>

      {/* ── Release Confirmation Dialog ── */}
      <ConfirmDialog
        open={!!confirmRelease}
        onClose={() => setConfirmRelease(null)}
        onConfirm={handleConfirmRelease}
        title={t('sidebar.releaseAgentTitle')}
        message={t('sidebar.confirmReleaseAgent', { name: confirmRelease?.name ?? '' })}
        confirmText={t('sidebar.release')}
      />

      {/* ── Git Init Confirmation: project directory is not a git repo yet ── */}
      <ConfirmDialog
        open={!!gitInitConfirm}
        onClose={() => setGitInitConfirm(null)}
        onConfirm={handleConfirmGitInit}
        title={t('sidebar.gitInitTitle') ?? 'Initialize Git Repository?'}
        message={
          (t('sidebar.gitInitMessage', { name: gitInitConfirm?.projectName ?? '' }) ?? '该项目目录还不是 Git 仓库。是否先执行 git init 并创建初始提交，再继续创建 Worktree？') +
          (gitInitConfirm && !gitInitConfirm.hasGitignore
            ? (t('sidebar.gitInitNoGitignore') ?? '\n\n注意：未检测到 .gitignore，初始化将把当前目录下所有现有文件（含大文件/敏感文件）纳入首次提交。')
            : '')
        }
        confirmText={t('sidebar.gitInitConfirm') ?? '初始化并继续'}
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
                  fontFamily: READER_FONT,
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
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
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
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: 'var(--border-strong)',
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
                className="overflow-y-auto overlay-scroll-content"
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
                    e.currentTarget.style.background = 'var(--accent-10)'
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
                    <IconFolder width={24} height={24} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 6px var(--accent-14))' }} />
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
                      e.currentTarget.style.background = 'var(--accent-10)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    <FolderSprite size={14} />
                    <span className="truncate">{entry.name}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <PixelButton variant="secondary" onClick={closeRepairDialog}>
                {t('sidebar.cancel') ?? 'Cancel'}
              </PixelButton>
              <PixelButton variant="accent" onClick={handleRepairUpdate} disabled={!repairPath.trim() || repairSubmitting}>
                {repairSubmitting ? t('sidebar.repairUpdating') ?? 'Updating…' : t('sidebar.repairUpdate') ?? 'Update Path'}
              </PixelButton>
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
                fontFamily: READER_FONT,
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
              <PixelButton variant="secondary" onClick={() => setCoverConflict(null)}>
                {t('sidebar.cancel') ?? 'Cancel'}
              </PixelButton>
              <PixelButton
                variant="accent"
                onClick={() => {
                  const coverId = coverConflict.coveringProject.id
                  setActiveProject(coverId)
                  setActiveWorkspace(null)
                  setCoverConflict(null)
                  setCreateProjOpen(false)
                  setProjName('')
                  setProjPath(homeDir + '/')
                  addToast(
                    'success',
                    t('sidebar.coverConflictSwitched', { name: coverConflict.coveringProject.name }) ??
                      `Switched to project "${coverConflict.coveringProject.name}"`,
                  )
                }}
              >
                {t('sidebar.coverConflictSwitch') ?? 'Switch to existing'}
              </PixelButton>
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
      className="row-action flex-shrink-0 flex items-center justify-center transition-all"
      style={{ width: 20, height: 20, borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--border-strong)', color: 'var(--text-faint)', fontSize: 11 }}
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
      <IconPencil width={14} height={14} />
    </button>
  )
}

function DeleteButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onClick}
      className="row-action flex-shrink-0 flex items-center justify-center transition-all sidebar-glow-red-hover"
      style={{ width: 20, height: 20, borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--border-strong)', color: 'var(--text-faint)', fontSize: 11 }}
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
      <IconTrash width={14} height={14} />
    </button>
  )
}

function ReleaseButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const { t } = useTranslation()
  return (
    <button
      onClick={onClick}
      className="row-action flex-shrink-0 flex items-center justify-center transition-all"
      style={{ width: 20, height: 20, borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--border-strong)', color: 'var(--text-faint)', fontSize: 11 }}
      title={t('sidebar.releaseAcp')}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--warning)'
        e.currentTarget.style.color = 'var(--warning)'
        e.currentTarget.style.background = 'var(--warning-12)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-strong)'
        e.currentTarget.style.color = 'var(--text-faint)'
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <IconPower width={14} height={14} />
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
