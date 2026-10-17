import { Fragment, useEffect, useState, useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../stores/appStore'
import { useAgentStore } from '../../stores/agentStore'
import { useChatStore } from '../../stores/chatStore'
import { useToastStore } from '../../stores/toastStore'
import { api } from '../../api/client'
import { BookIcon } from '../Icons/BookIcon'
import { IconEye, IconPlus, IconSettings } from '../FileManager/icons'
import { KeyboardIcon } from '../Icons/KeyboardIcon'
import { GitHubIcon } from '../Icons/GitHubIcon'
import type { DuplicateGroup, Project, Workspace } from '../../api/client'
import { type AcpActivity } from '../../utils/agentAggregate'
import { sessionDisplayName } from '../../utils/sessionDisplayName'
import { APP_VERSION, GITHUB_REPO_URL } from '../../version'
import { DuplicateProjectsDialog } from './DuplicateProjectsDialog'
import { UpdateBadge } from './UpdateBadge'
import { ProjectCard } from './ProjectCard'
import { sessionsForWorktree } from '../../utils/worktreeSessions'
import { computeProjectReorder } from '../../utils/projectReorder'
import { hapticTap } from '../../utils/haptics'
import { RenameDialog, type RenameTarget } from './RenameDialog'
import { DeleteConfirmDialog, type DeleteTarget } from './DeleteConfirmDialog'
import { DeleteWorktreeDialog, type DeleteWorktreeTarget } from './DeleteWorktreeDialog'
import { ReleaseConfirmDialog, type ReleaseTarget } from './ReleaseConfirmDialog'
import { RepairPathDialog, type RepairTarget } from './RepairPathDialog'
import { CreateSessionModal } from './CreateSessionModal'
import { CreateProjectModal } from './CreateProjectModal'
import { CreateWorktreeModal } from './CreateWorktreeModal'
import { ExternalSessionsSection } from './ExternalSessionsSection'
import { ArchivedSessionsSection } from './ArchivedSessionsSection'
import { SessionContextMenu, type ContextMenuPoint, type SessionContextMenuState } from './SessionContextMenu'
import { BatchActionBar } from './BatchActionBar'
import { BatchSessionDialog, type BatchAction, type BatchTarget } from './BatchSessionDialog'
import { ConfirmDialog } from '../Modal/ConfirmDialog'
import type { Session } from '../../api/client'
import { SidebarBottomButton } from './RowActionButtons'
import { useAgentAttentionPolling } from './useAgentAttentionPolling'
import { OmniTermLogo } from '../PixelUI/OmniTermLogo'
import { CountBadge } from '../Common/CountBadge'
import { SignalBarsSprite } from '../PixelUI'
import { READER_FONT } from '../../utils/fonts'

/** Cover-conflict「切换到现有项目」的项目卡片聚焦闪烁时长（与 index.css 的
 *  .sidebar-project-focus-flash ring 动画时长一致，到期摘 class）。 */
const PROJECT_CARD_FLASH_MS = 1200

/** 鼠标/笔起拖阈值：按下后移动超过该距离立即起拖（无需长按）。 */
const PROJ_DRAG_THRESHOLD_PX = 4

/** 触摸长按起拖时长（触摸要与列表滚动区分，长按是移动端排序的通行范式；
 *  鼠标/笔不需要——立即起拖更直觉）。 */
const PROJ_LONG_PRESS_MS = 500

/** 触摸长按达成前指针漂移超过该值即取消起拖（滚动 / 点击拖动不算长按）。 */
const PROJ_LONG_PRESS_CANCEL_PX = 10

/** 拖拽达成后抑制 header 补发 click 的窗口（同 SessionRow 长按抑制）。 */
const PROJ_DRAG_CLICK_SUPPRESS_MS = 700

/** 项目卡片拖拽的事件态（window 处理器直读，避开陈旧闭包）。 */
interface ProjDragState {
  id: string
  startX: number
  startY: number
  /** 'touch' 走长按起拖；'mouse' / 'pen' 移动超阈值即起拖 */
  pointerType: string
  /** 起拖达成（卡片已拽起）；false = 仍在等待窗内 */
  active: boolean
  /** 本次拖拽是否真的拽到过别的卡片（有过插入点）——区分「拖拽」与普通点击 */
  engaged: boolean
  /** 当前插入点所在卡片；'' = 无（悬停在自己头上或列表外） */
  overId: string
  before: boolean
  timer: number | null
}

export function Sidebar() {
  const {
    projects,
    worktrees,
    sessions,
    archivedSessions,
    activeProjectId,
    activeWorkspaceId,
    activeSessionId,
    sidebarCollapsed,
    connected,
    setProjects,
    setWorktrees,
    setSessions,
    setArchivedSessions,
    setActiveProject,
    setActiveWorkspace,
    setActiveSession,
    setActiveExternalSession,
    setConnected,
    workspaceSessionMemory,
    clearWorkspaceSession,
  } = useAppStore()

  const toggleSidebarCollapsed = useAppStore((s) => s.toggleSidebarCollapsed)
  const activateSession = useAppStore((s) => s.activateSession)
  const setMultiplexer = useAppStore((s) => s.setMultiplexer)
  const setMultiplexerAvailable = useAppStore((s) => s.setMultiplexerAvailable)
  const toggleSettings = useAppStore((s) => s.toggleSettings)
  const toggleTmuxCheatsheet = useAppStore((s) => s.toggleTmuxCheatsheet)
  const toggleAgentHistory = useAppStore((s) => s.toggleAgentHistory)
  const expandAllSessions = useAppStore((s) => s.expandAllSessions)
  const setExpandAllSessions = useAppStore((s) => s.setExpandAllSessions)

  const addToast = useToastStore((s) => s.addToast)
  const { t } = useTranslation()
  // agent 注册表：会话显示名的兜底来源（未命名 ACP 会话的 `${agent}_${MMdd-HHmm}`
  // 默认名由它 + created_at 现算，见 utils/sessionDisplayName.ts）。
  const agents = useAgentStore((s) => s.agents)

  // ACP 会话活动状态（chatStore 派生）：与 tmux 屏幕检测的 agent_state 归一，
  // 使两类会话的 Sidebar 状态点/聚合徽标表现一致。useShallow 保证仅在
  // waiting/running 归属变化时重渲染（流式 chunk 不触发）。
  const acpActivityMap = useChatStore(
    useShallow((s) => {
      const m: Record<string, AcpActivity> = {}
      for (const [id, st] of Object.entries(s.states)) {
        if (st.pendingPermissions.length > 0) m[id] = 'waiting'
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
  // 用户手动折叠过的项目集合——「折叠优先」：即使 expandAllSessions 模式下
  // 项目本应自动展开，被手动折叠后也不再自动弹回。
  const [manuallyCollapsed, setManuallyCollapsed] = useState<Set<string>>(new Set())
  // Cover-conflict「切换到现有项目」聚焦闪烁：目标项目 id + 定时器/rAF 句柄
  // （同目标重放需先摘 class、下一帧重挂，CSS 动画才能重新播放，ChatView
  // 「上次输入」聚焦同款）。侧栏无「活跃项目」视觉态，闪烁是切换的唯一反馈。
  const [focusFlashProjectId, setFocusFlashProjectId] = useState<string | null>(null)
  const flashTimerRef = useRef<number | null>(null)
  const flashRafRef = useRef<number | null>(null)
  // 项目列表滚动容器——聚焦时把目标卡片滚进视口。
  const projectsScrollRef = useRef<HTMLDivElement | null>(null)
  // 项目卡片拖拽排序（长按起拖，指针事件统一路径：鼠标/触摸通用，无 HTML5
  // DnD 的触摸盲区）：
  // - projDrag：渲染态（拽起源 + 插入点），驱动上浮特效与插入指示线
  // - projDragRef：事件态（window 级 pointermove/up 直读，避开陈旧闭包）
  // 起拖区即卡片头部（收起态=整卡、展开态=标题条）；不占独立手柄位。
  const [projDrag, setProjDrag] = useState<{
    draggingId: string
    overId: string
    before: boolean
  } | null>(null)
  const projDragRef = useRef<ProjDragState | null>(null)
  // 拽起卡的 DOM 引用：跟随指针的 transform 在此直写。pointermove 是高频事件，
  // 每拍走 React 重渲染会让整棵侧栏（含全部会话行）跟着抖——与聊天元信息读数
  // 直写 DOM、抽屉拖拽直改宽度同一手法。React 只管理 lifted class
  // 与插入线（目标变化才动），不管理 transform，故松手时须手动清空。
  const draggedElRef = useRef<HTMLElement | null>(null)
  // 拖拽达成时间戳：抑制其后续补发的 header click。浏览器把 down/up 的最近
  // 公共祖先作为 click 目标——起点在某张卡头部、终点漂到别的卡时 click 落在
  // 原头部，不抑制会演变成展开切换（SessionRow 长按补发 click 同款手法）。
  // 仅在「真拽到过别的卡片」时记：长按原样松手是慢速点击，click 必须放行。
  const projPressAtRef = useRef(0)
  const [createProjOpen, setCreateProjOpen] = useState(false)
  const [createSessWorkspaceId, setCreateSessWorkspaceId] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  // 会话右键/长按菜单 + 批量选择模式（Sidebar 局部 UI 态，见计划文档 D5）：
  // - contextMenu：单一菜单实例的锚点与目标会话
  // - selectionMode / selectedSessionIds：批量选择开关与勾选集
  // - batchTarget：批量确认弹窗的动作与目标会话
  const [contextMenu, setContextMenu] = useState<SessionContextMenuState | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(new Set())
  const [batchTarget, setBatchTarget] = useState<BatchTarget | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget | null>(null)
  const [confirmRelease, setConfirmRelease] = useState<ReleaseTarget | null>(null)
  // 归档确认（仅在 agent 进程驻留时弹出；null = 关闭）
  const [confirmArchive, setConfirmArchive] = useState<{ id: string; name: string } | null>(null)

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

  // Load archived sessions (global, cross-project). Refreshed on mount and
  // after every archive/unarchive/delete so the sidebar section stays in sync.
  const loadArchived = useCallback(async () => {
    try {
      setArchivedSessions(await api.listArchivedSessions())
    } catch {
      // silent — the section simply renders nothing while the fetch fails
    }
  }, [setArchivedSessions])
  useEffect(() => { loadArchived() }, [loadArchived])

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

  // 模式 1（expandAllSessions=true）：全量加载所有项目的数据，使含会话的
  // 项目无需点击即可按会话存在性自动展开。`=== undefined` 判断避免对已加载
  // 项目重复请求；加载中由渲染侧的 loading 占位承接。
  useEffect(() => {
    if (!expandAllSessions) return
    for (const p of projects) {
      if (worktrees[p.id] === undefined) void loadWorktrees(p.id)
      if (sessions[p.id] === undefined) void loadSessions(p.id)
    }
  }, [expandAllSessions, projects, worktrees, sessions, loadWorktrees, loadSessions])

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

  // ── Smart diff: session polling + attention detection（外移至 hook，见 E4）──
  useAgentAttentionPolling(activeProjectId)

  useEffect(() => {
    api.systemInfo().then((info) => {
      setHomeDir(info.home_dir)
      if (info.multiplexer) setMultiplexer(info.multiplexer)
    }).catch(() => {
      // fallback: leave homeDir empty, user fills the path in manually
    })
    // tmux 可用性探测（503 → request 抛错）：tmux 引擎选项与 external 区块的显隐依据
    api.multiplexerStatus()
      .then((st) => setMultiplexerAvailable(st.available))
      .catch(() => setMultiplexerAvailable(false))
  }, [setMultiplexer, setMultiplexerAvailable])

  // Health polling
  useEffect(() => {
    const check = () => api.health().then(() => setConnected(true)).catch(() => setConnected(false))
    check()
    const id = setInterval(check, 5000)
    return () => clearInterval(id)
  }, [setConnected])

  // 聚焦闪烁的定时器/rAF 卸载即收：闪烁中卸载侧栏也要清句柄，
  // 否则回调落到已卸载组件树上（setState on unmounted）。
  useEffect(() => () => {
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    if (flashRafRef.current !== null) window.cancelAnimationFrame(flashRafRef.current)
  }, [])

  // Refresh projects when the page becomes visible again — catches
  // directories moved/deleted while the tab was hidden (path_valid changes).
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') loadProjects() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [loadProjects])

  // Cleanup tooltip timeout on unmount — commented out pending notification scheme decision.
  // useEffect(() => {
  //   return () => {
  //     if (tooltipTimeoutRef.current) {
  //       clearTimeout(tooltipTimeoutRef.current)
  //     }
  //   }
  // }, [])

  // 某项目是否含会话：worktrees 尚未加载时返回 false（加载中不据此展开）。
  // 依赖 sessionsForWorktree 判定孤儿会话归属，与 ProjectCard 内统计口径一致。
  const projectHasSessions = (projId: string): boolean => {
    const wtList = worktrees[projId]
    const sessList = sessions[projId] || []
    if (wtList === undefined) return false
    return wtList.some((wt) => sessionsForWorktree(sessList, wtList, wt.path).length > 0)
  }

  // 项目当前是否显示为展开。折叠优先：手动折叠过的项目即使满足
  // expandAllSessions 自动展开条件也不再弹回。
  const isProjectDisplayExpanded = (projId: string): boolean =>
    (expandedProjects.has(projId) || (expandAllSessions && projectHasSessions(projId))) &&
    !manuallyCollapsed.has(projId)

  // Toggle project expansion — 双向操作，基于显示状态：
  // - 当前显示展开 → 折叠：清掉手动展开标记 + 记录手动折叠（防模式 1 自动弹回）
  // - 当前显示折叠 → 展开：清除手动折叠标记 + 记录手动展开 + 火并忘加载数据
  const toggleProject = (projectId: string) => {
    if (isProjectDisplayExpanded(projectId)) {
      setExpandedProjects((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
      setManuallyCollapsed((prev) => {
        const next = new Set(prev)
        next.add(projectId)
        return next
      })
    } else {
      setManuallyCollapsed((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
      setExpandedProjects((prev) => {
        const next = new Set(prev)
        next.add(projectId)
        return next
      })
      // Fire-and-forget：展开立即生效，不等网络往返（Windows 上 git spawn 慢，
      // await 会让展开卡 100ms+）。未加载时渲染侧显示 loading 占位。
      void Promise.all([loadWorktrees(projectId), loadSessions(projectId)])
    }
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

  // Cover-conflict「切换到现有项目」聚焦：展开（折叠态先展开）→ 滚动进视口 →
  // 卡片 Y 轴弹跳 + accent ring 闪烁。
  // 为什么需要：侧栏没有任何「活跃项目」视觉态（ProjectCard 不读
  // activeProjectId），setActiveProject 后侧栏零反馈——用户看到的就是
  // 「窗口关了，什么都没发生」。闪烁与展开即切换动作的可见回执。
  const focusProjectCard = (projectId: string) => {
    // 折叠态先展开：与 toggleProject 展开分支同口径（清手动折叠标记 +
    // 火并忘加载数据）。不展开则卡片高度不变，「切换到了」的感知落空，
    // 滚动定位也可能因 nearest 判定「已在视口」而不动。
    if (!isProjectDisplayExpanded(projectId)) {
      setManuallyCollapsed((prev) => {
        const next = new Set(prev)
        next.delete(projectId)
        return next
      })
      setExpandedProjects((prev) => {
        const next = new Set(prev)
        next.add(projectId)
        return next
      })
      // Fire-and-forget：展开立即生效，不等网络往返（toggleProject 同款）。
      void Promise.all([loadWorktrees(projectId), loadSessions(projectId)])
    }
    // 滚动进视口：等展开渲染落定（下一帧）再量，否则卡片还没长高。
    // scrollIntoView 为可选调用——jsdom 等无布局环境未实现时不炸。
    requestAnimationFrame(() => {
      projectsScrollRef.current
        ?.querySelector<HTMLElement>(`[data-proj-id="${projectId}"]`)
        ?.scrollIntoView?.({ block: 'nearest' })
    })
    // 闪烁：同一目标已在闪烁中时先摘 class、下一帧重挂，CSS 动画得以重放
    // （ChatView「上次输入」聚焦同款手法）。项目 id 为后端 uuid，不含
    // 选择器元字符，属性选择器无需转义。
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current)
    if (flashRafRef.current !== null) window.cancelAnimationFrame(flashRafRef.current)
    const armFlash = () => {
      setFocusFlashProjectId(projectId)
      flashTimerRef.current = window.setTimeout(() => {
        setFocusFlashProjectId(null)
        flashTimerRef.current = null
      }, PROJECT_CARD_FLASH_MS)
    }
    if (focusFlashProjectId === projectId) {
      setFocusFlashProjectId(null)
      flashRafRef.current = window.requestAnimationFrame(() => {
        flashRafRef.current = null
        armFlash()
      })
    } else {
      armFlash()
    }
  }

  // ── 项目卡片拖拽排序 ────────────────────────────────────────────
  // 提交：本地乐观重排 → PUT /projects/order；失败回滚 + toast。
  // 顺序真源是 store 的 projects（getState 直读，避开 window 处理器里的
  // 陈旧闭包）；渲染顺序与落盘载荷由 computeProjectReorder 一次算出，两者
  // 不可能漂移。
  const commitProjectReorder = useCallback(
    (draggedId: string, overId: string, before: boolean) => {
      const current = useAppStore.getState().projects
      const nextIds = computeProjectReorder(
        current.map((p) => p.id),
        draggedId,
        overId,
        before,
      )
      const unchanged =
        nextIds.length === current.length && nextIds.every((id, i) => id === current[i].id)
      if (unchanged) return // 拖回原位 / 目标已不在列表（DOM 与 store 竞态）
      const byId: Record<string, Project> = {}
      for (const p of current) byId[p.id] = p
      const reordered = nextIds.flatMap((id) => {
        const p = byId[id]
        return p ? [p] : []
      })
      const previous = current
      setProjects(reordered)
      void api.reorderProjects(nextIds).catch(() => {
        setProjects(previous)
        addToast('error', t('sidebar.reorderFailed') ?? 'Failed to save project order')
      })
    },
    [setProjects, addToast, t],
  )

  /** 起拖达成：记 DOM 引用（跟随指针用）+ 上浮 class + 触觉反馈。 */
  const activateProjDrag = useCallback((st: ProjDragState) => {
    st.active = true
    // 项目 id 为后端 uuid，不含选择器元字符，属性选择器无需转义
    // （focusProjectCard 的滚动定位同款假设）。
    draggedElRef.current = document.querySelector<HTMLElement>(`[data-proj-id="${st.id}"]`)
    hapticTap()
    setProjDrag({ draggingId: st.id, overId: '', before: true })
  }, [])

  // window 级指针监听：projDragRef 为空时纯读引用即返回，零成本；订阅随
  // 组件卸载摘除。目标卡片定位优先 elementFromPoint——触摸指针有隐式
  // capture，e.target 会停在按下处的卡片上命中不了别的卡；jsdom 无布局
  // （elementFromPoint 未实现）时回退 e.target，测试可直接朝卡片派发。
  useEffect(() => {
    const cardAtPoint = (x: number, y: number, target: EventTarget | null): HTMLElement | null => {
      if (typeof document.elementFromPoint === 'function') {
        const hit = document.elementFromPoint(x, y)?.closest?.('[data-proj-id]')
        if (hit) return hit as HTMLElement
      }
      const el = target as Element | null
      return (el?.closest?.('[data-proj-id]') as HTMLElement | null) ?? null
    }
    const clearPending = (st: ProjDragState | null) => {
      if (st?.timer != null) {
        window.clearTimeout(st.timer)
        st.timer = null
      }
    }
    const onMove = (e: PointerEvent) => {
      const st = projDragRef.current
      if (!st) return
      const dx = e.clientX - st.startX
      const dy = e.clientY - st.startY
      if (!st.active) {
        if (st.pointerType === 'touch') {
          // 触摸：长按达成前的移动 = 滚动 / 点击拖动，取消本次起拖
          if (dx * dx + dy * dy > PROJ_LONG_PRESS_CANCEL_PX * PROJ_LONG_PRESS_CANCEL_PX) {
            clearPending(st)
            projDragRef.current = null
          }
          return
        }
        // 鼠标/笔：超过阈值立即起拖（不做长按等待）
        if (dx * dx + dy * dy < PROJ_DRAG_THRESHOLD_PX * PROJ_DRAG_THRESHOLD_PX) return
        activateProjDrag(st)
      }
      // 跟随指针：transform 直写（见 draggedElRef 注释——不走 React）。
      // scale(1.02) 是「捏在手里」的放大暗示，与投影/描边同向加强。
      if (draggedElRef.current) {
        draggedElRef.current.style.transform = `translate(${dx}px, ${dy}px) scale(1.02)`
      }
      // 插入点判定：命中卡是「被拽起卡下方」的那张（拽起卡 pointer-events:none）
      const card = cardAtPoint(e.clientX, e.clientY, e.target)
      const overId = card?.dataset.projId
      if (!overId || overId === st.id) {
        // 悬停在自己头上 / 移出列表：摘插入点，卡片保持被拽起
        if (st.overId !== '') {
          st.overId = ''
          setProjDrag({ draggingId: st.id, overId: '', before: true })
        }
        return
      }
      const rect = card.getBoundingClientRect()
      const before = e.clientY < rect.top + rect.height / 2
      if (st.overId === overId && st.before === before) return
      st.engaged = true
      st.overId = overId
      st.before = before
      setProjDrag({ draggingId: st.id, overId, before })
    }
    const finish = () => {
      const st = projDragRef.current
      projDragRef.current = null
      clearPending(st)
      // 跟随 transform 必须手动清：React 不管这个元素的 transform，不清会残留偏移
      if (draggedElRef.current) {
        draggedElRef.current.style.transform = ''
        draggedElRef.current = null
      }
      setProjDrag(null)
      // 只有真的拽到过别的卡片才算一次拖拽：记时间戳抑制补发的 click（浏览器
      // 把 down/up 的公共祖先作为 click 目标，落回原卡片头部时会误触展开切换）。
      // 原地按下松手 / 触摸长按原样松手不算拖——click 照常展开卡片。
      if (st?.active && st.engaged) {
        projPressAtRef.current = Date.now()
        if (st.overId !== '') commitProjectReorder(st.id, st.overId, st.before)
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [commitProjectReorder, activateProjDrag])

  const handleProjHeaderPointerDown = useCallback((e: ReactPointerEvent, projectId: string) => {
    if (e.button !== 0) return // 仅左键 / 触摸（触摸 pointerdown 的 button 为 0）
    // 头部动作按钮（worktree / rename / delete / repair）的 pointerdown 会冒泡
    // 到 header——就近过滤，按住它们不起拖（否则卡片被拽起，按钮点击反而被
    // 拖拽语义吃掉）。
    if ((e.target as HTMLElement).closest('button')) return
    // 阻止文本选中与焦点抢占（拖动期间尤其明显）
    e.preventDefault()
    const st: ProjDragState = {
      id: projectId,
      startX: e.clientX,
      startY: e.clientY,
      pointerType: e.pointerType,
      active: false,
      engaged: false,
      overId: '',
      before: true,
      timer: null,
    }
    projDragRef.current = st
    // 触摸才需要长按：手指一滑浏览器就滚列表，立即起拖会和滚动抢手势。
    // 鼠标/笔没有这个歧义，移动超阈值即起拖（长按反而反直觉）。
    if (st.pointerType === 'touch') {
      st.timer = window.setTimeout(() => {
        st.timer = null
        if (projDragRef.current !== st) return // 已取消 / 已松手
        activateProjDrag(st)
      }, PROJ_LONG_PRESS_MS)
    }
  }, [activateProjDrag])

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

  // 归档 ACP 会话：后端释放 agent 进程 + 打归档标记；前端刷新两个列表，
  // 若归档的是当前聚焦会话则切回空视图（默认列表已无此行）。
  const archiveSessionNow = async (id: string) => {
    try {
      await api.archiveSession(id)
      await Promise.all([loadSessions(), loadArchived()])
      if (id === activeSessionId) setActiveSession(null)
      addToast('success', t('sidebar.sessionArchived') ?? `Session archived`)
    } catch {
      // api client already shows error toast
    }
  }

  // 取消归档：清除标记回到原项目/worktree 列表。进程不随之恢复——
  // 与已释放会话一致，走「恢复会话」按需 spawn。
  const unarchiveSessionNow = async (id: string) => {
    try {
      await api.unarchiveSession(id)
      await Promise.all([loadSessions(), loadArchived()])
      addToast('success', t('sidebar.sessionUnarchived') ?? `Session restored to list`)
    } catch {
      // api client already shows error toast
    }
  }

  // 归档入口：进程驻留时先确认（会终止运行中的 agent），空闲直接归档。
  const requestArchive = (s: Session) => {
    if (s.acp_process_alive) {
      setConfirmArchive({ id: s.id, name: sessionDisplayName(s, agents, t('sidebar.unnamed')) })
    } else {
      void archiveSessionNow(s.id)
    }
  }

  // ── 会话右键/长按菜单 + 批量选择模式回调 ──
  // handleSessionContextMenu / handleToggleSessionSelection 直传 SessionRow，
  // 必须稳定引用（SessionRow 是 memo 组件，见 SessionRow.tsx 顶部注释）。
  const handleSessionContextMenu = useCallback((session: Session, point: ContextMenuPoint) => {
    setContextMenu({ session, x: point.x, y: point.y })
  }, [])

  const handleToggleSessionSelection = useCallback((sessionId: string) => {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev)
      if (next.has(sessionId)) next.delete(sessionId)
      else next.add(sessionId)
      return next
    })
  }, [])

  // 菜单「批量操作」：进入选择模式并预选该会话（右键/长按的那一行）
  const handleEnterBatchMode = useCallback((session: Session) => {
    setSelectionMode(true)
    setSelectedSessionIds(new Set([session.id]))
  }, [])

  // 菜单「重命名」：复用 RenameDialog（入口从行内铅笔按钮迁移至此）
  // 依赖含 `agents` / `t`：展示名的兜底段（`${agent}_${MMdd-HHmm}`）要查注册表，
  // 而 `t` 提供「未命名」文案。两者都只在加载/切语言时变，回调重建成本可忽略。
  const handleRenameSession = useCallback(
    (session: Session) => {
      // 预填**展示名**而非仅 `name`：agent 标题 / 宿主默认名也要能作为编辑起点
      // （RenameDialog 对「未改动」会自行 bail，不会把派生名固化成用户命名）。
      setRenameTarget({
        type: 'session',
        id: session.id,
        name: sessionDisplayName(session, agents, t('sidebar.unnamed')),
      })
    },
    [agents, t],
  )

  const closeContextMenu = useCallback(() => setContextMenu(null), [])
  const closeBatchDialog = useCallback(() => setBatchTarget(null), [])

  const handleExitBatchMode = useCallback(() => {
    setSelectionMode(false)
    setSelectedSessionIds(new Set())
  }, [])

  // 批量执行完成：退出选择模式并刷新两个列表（归档区块同步）
  const handleBatchDone = useCallback(async () => {
    setSelectionMode(false)
    setSelectedSessionIds(new Set())
    await Promise.all([loadSessions(), loadArchived()])
  }, [loadSessions, loadArchived])

  // 选择集对应的会话对象（计数与批量目标都以此为准，避免选中集与列表脱节）
  const selectedSessionList = Object.values(sessions).flat().filter((s) => selectedSessionIds.has(s.id))
  // 归档/释放仅对 ACP 会话有效；release 对已释放会话幂等（见计划 D6），无需按 alive 过滤
  const selectedAcpCount = selectedSessionList.filter((s) => s.runtime_kind === 'acp').length

  const handleBatchAction = (action: BatchAction) => {
    setBatchTarget({ action, sessions: selectedSessionList })
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
          toggle="agent-history"
          icon={<KeyboardIcon size={16} />}
          title={t('agentHistory.title')}
          onClick={toggleAgentHistory}
          size={28}
          className="mb-2"
        />
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
      <div
        ref={projectsScrollRef}
        className="flex-1 overflow-y-auto px-2.5 pt-4 pb-16 overlay-scroll-content"
      >
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
            onClick={() => setExpandAllSessions(!expandAllSessions)}
            className="sidebar-proj-add-btn"
            title={
              expandAllSessions
                ? (t('sidebar.expandAllSessions.on') ?? 'Session expansion: all worktrees with sessions (click for focused only)')
                : (t('sidebar.expandAllSessions.off') ?? 'Session expansion: focused worktree only (click to expand all)')
            }
            style={expandAllSessions ? { color: 'var(--accent)' } : undefined}
          >
            {expandAllSessions ? '⤢' : <IconEye />}
          </button>
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
            <Fragment key={proj.id}>
              {/* 插入指示线：拖拽悬停时落在两卡之间的 2px accent 线（纯展示，
                  pointer-events:none 不抢命中）。 */}
              {projDrag?.overId === proj.id && projDrag.before && (
                <div className="sidebar-project-drop-line" />
              )}
              <ProjectCard
                project={proj}
                isExpanded={isProjectDisplayExpanded(proj.id)}
                flashing={focusFlashProjectId === proj.id}
                lifted={projDrag?.draggingId === proj.id}
                expandAllSessions={expandAllSessions}
                worktrees={worktrees[proj.id]}
                sessions={sessions[proj.id] || []}
                activeWorkspaceId={activeWorkspaceId}
                activeSessionId={activeSessionId}
                acpActivityFor={acpActivityFor}
                onToggle={() => {
                  // 拖拽达成后补发的 click 抑制（见 projPressAtRef 注释）；
                  // 长按原样松手不记时间戳——慢速点击仍要能展开卡片
                  if (Date.now() - projPressAtRef.current < PROJ_DRAG_CLICK_SUPPRESS_MS) return
                  toggleProject(proj.id)
                }}
                onHeaderPointerDown={(e) => handleProjHeaderPointerDown(e, proj.id)}
              onOpenCreateWorktree={async () => {
                if (!isProjectDisplayExpanded(proj.id)) {
                  setExpandedProjects(prev => { const next = new Set(prev); next.add(proj.id); return next })
                  setManuallyCollapsed(prev => { const next = new Set(prev); next.delete(proj.id); return next })
                  await Promise.all([loadWorktrees(proj.id), loadSessions(proj.id)])
                }
                setCreateWtProjectId(proj.id)
              }}
              onRename={setRenameTarget}
              onDeleteProject={() => setConfirmDelete({ type: 'project', id: proj.id, name: proj.name })}
              onWorkspaceClick={(wt) => handleWorkspaceClick(proj, wt)}
              onRepairProject={(project) => setRepairTarget({ project, workspace: null, oldPath: project.path })}
              onOpenCreateSession={(wt) => {
                setActiveProject(proj.id)
                setActiveWorkspace(wt.id)
                setCreateSessWorkspaceId(wt.id)
              }}
              onDeleteWorktree={setConfirmDeleteWt}
              onDeleteSession={setConfirmDelete}
              onReleaseRequest={(s) => {
                const chatState = useChatStore.getState().states[s.id]
                if (chatState?.sending)
                  setConfirmRelease({ id: s.id, name: sessionDisplayName(s, agents, t('sidebar.unnamed')) })
                else releaseSessionNow(s.id)
              }}
              onArchiveRequest={requestArchive}
              selectionMode={selectionMode}
              selectedIds={selectedSessionIds}
              onToggleSessionSelection={handleToggleSessionSelection}
              onSessionContextMenu={handleSessionContextMenu}
            />
              {projDrag?.overId === proj.id && !projDrag.before && (
                <div className="sidebar-project-drop-line" />
              )}
            </Fragment>
          ))
        )}

        {/* External Sessions — tmux sessions not yet adopted into any project */}
        <ExternalSessionsSection reloadSessions={loadSessions} />

        {/* Archived ACP sessions — global collapsible list, read-only history */}
        <ArchivedSessionsSection
          sessions={archivedSessions}
          onOpen={(s) => activateSession(s.id)}
          onUnarchive={(s) => void unarchiveSessionNow(s.id)}
          onDelete={(s) =>
            setConfirmDelete({
              type: 'session',
              id: s.id,
              name: sessionDisplayName(s, agents, t('sidebar.unnamed')),
              runtimeKind: s.runtime_kind,
              acpSessionId: s.acp_session_id,
              agentId: s.agent_id,
              workspacePath: s.workspace_path,
            })
          }
        />
      </div>

      {/* Bottom bar — 批量选择模式下替换为操作栏（保持同一 absolute 定位节点） */}
      {selectionMode ? (
        <BatchActionBar
          selectedCount={selectedSessionList.length}
          archivableCount={selectedAcpCount}
          releasableCount={selectedAcpCount}
          onAction={handleBatchAction}
          onCancel={handleExitBatchMode}
        />
      ) : (
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
      )}

      {/* ── Create Project Modal ── */}
      <CreateProjectModal
        open={createProjOpen}
        homeDir={homeDir}
        onClose={() => setCreateProjOpen(false)}
        reloadProjects={loadProjects}
        onFocusProject={focusProjectCard}
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
        onSessionDeleted={loadArchived}
      />

      {/* ── Archive Confirmation Dialog（仅进程驻留时弹出）── */}
      <ConfirmDialog
        open={!!confirmArchive}
        onClose={() => setConfirmArchive(null)}
        onConfirm={() => {
          if (!confirmArchive) return
          void archiveSessionNow(confirmArchive.id)
          setConfirmArchive(null)
        }}
        title={t('sidebar.archiveConfirmTitle') ?? 'Archive Session'}
        message={
          t('sidebar.archiveConfirmRunning', { name: confirmArchive?.name }) ??
          `The running agent for "${confirmArchive?.name}" will be terminated. Chat history is kept and stays viewable under Archived.`
        }
        confirmText={t('sidebar.archive') ?? 'Archive'}
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

      {/* ── 会话右键（桌面）/ 长按（移动端）上下文菜单 ── */}
      <SessionContextMenu
        menu={contextMenu}
        onClose={closeContextMenu}
        onBatchMode={handleEnterBatchMode}
        onRename={handleRenameSession}
      />

      {/* ── 批量操作确认弹窗（归档 / 释放进程 / 删除）── */}
      <BatchSessionDialog
        target={batchTarget}
        onClose={closeBatchDialog}
        onDone={handleBatchDone}
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
