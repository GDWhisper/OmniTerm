import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useAttention } from '../../hooks/useAttention'
import type { Session, Project, Workspace } from '../../api/client'
import { aggregateStatus, sessionStatus, type AcpActivity } from '../../utils/agentAggregate'
import { sessionsForWorktree } from '../../utils/worktreeSessions'
import { IconGitBranch, IconPlus, IconTrash, IconWarning } from '../FileManager/icons'
import { CountBadge } from '../Common/CountBadge'
import { GitBranchSprite } from '../PixelUI'
import { DeleteButton, EditButton } from './RowActionButtons'
import { SessionRow } from './SessionRow'
import type { ContextMenuPoint } from './SessionContextMenu'
import type { RenameTarget } from './RenameDialog'
import type { DeleteTarget } from './DeleteConfirmDialog'
import type { DeleteWorktreeTarget } from './DeleteWorktreeDialog'

// 单个 worktree 下 ACP 会话的默认可见数，超出折叠为「展开更多」。
// 仅约束 ACP 会话——终端会话数量少且是常驻操作对象，永不折叠。
const MAX_COLLAPSED_ACP_SESSIONS = 5

export function ProjectCard(props: {
  project: Project
  isExpanded: boolean
  expandAllSessions: boolean
  worktrees: Workspace[] | undefined    // undefined = 尚未加载（显示 loading 占位）
  sessions: Session[]                   // 该项目全部会话
  activeWorkspaceId: string | null
  activeSessionId: string | null
  acpActivityFor: (sessionId: string) => AcpActivity | undefined
  onToggle: () => void
  onOpenCreateWorktree: () => void
  onRename: (target: RenameTarget) => void
  onDeleteProject: () => void
  onWorkspaceClick: (wt: Workspace) => void
  onRepairProject: (project: Project) => void
  onOpenCreateSession: (wt: Workspace) => void
  onDeleteWorktree: (target: DeleteWorktreeTarget) => void
  onDeleteSession: (target: DeleteTarget) => void
  onReleaseRequest: (session: Session) => void
  onArchiveRequest: (session: Session) => void
  /** 批量选择模式：会话行显示勾选框、点击改为切换选中（不激活会话）。 */
  selectionMode: boolean
  /** 选择模式下已选中的会话 id 集。 */
  selectedIds: Set<string>
  onToggleSessionSelection: (sessionId: string) => void
  onSessionContextMenu: (session: Session, point: ContextMenuPoint) => void
}) {
  const { t } = useTranslation()
  const attention = useAttention()
  const pixelAnimationsEnabled = useAppStore((s) => s.pixelAnimationsEnabled)
  const activateSession = useAppStore((s) => s.activateSession)
  const isMobile = useAppStore((s) => s.isMobile)

  // 会话激活 = activateSession + 清除该会话 attention 提醒（原内联 click 逻辑）。
  // useCallback + 稳定的 attention.setActive 保证 SessionRow 的 memo 契约。
  const setAttentionActive = attention.setActive
  const handleActivateSession = useCallback(
    (sessionId: string) => {
      activateSession(sessionId)
      setAttentionActive(sessionId)
    },
    [activateSession, setAttentionActive],
  )

  // 哪些 worktree 的 ACP 会话列表被手动展开（默认折叠到阈值）。组件本地状态，
  // 刷新后回到折叠态——折叠是密度优化，不是用户需要持久化的信息。
  const [acpExpanded, setAcpExpanded] = useState<Set<string>>(new Set())

  const toggleAcpExpanded = (wtId: string) =>
    setAcpExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(wtId)) next.delete(wtId)
      else next.add(wtId)
      return next
    })

  // undefined = 尚未加载（显示 loading），[] = 已加载但为空
  const wtLoaded = props.worktrees !== undefined
  const wtList = props.worktrees || []
  const projAgg = aggregateStatus(
    wtList.flatMap((wt) => sessionsForWorktree(props.sessions, props.worktrees || [], wt.path)),
    attention.reasonFor,
    props.acpActivityFor,
  )

  return (
    <div className="sidebar-project-card">
      {/* Project header — stacked name + path */}
      <div
        className="sidebar-project-header"
        onClick={() => props.onToggle()}
      >
        <span
          className={projAgg === 'working' || projAgg === 'blocked' ? 'activity-pulse' : ''}
          style={{
            fontSize: 10,
            color: projAgg === 'blocked'
              ? 'var(--warning)'
              : projAgg === 'done'
                ? 'var(--success)'
                : props.isExpanded || projAgg === 'working'
                  ? 'var(--text-secondary)'
                  : 'var(--text-faint)',
            marginTop: 2,
          }}
        >
          {props.isExpanded ? '▼' : '▶'}
        </span>
        <div className="proj-info">
          <span className="proj-name">{props.project.name}</span>
          {/* 容器 direction:rtl 只为左侧省略号；bdi 隔离避免尾部 / 被 bidi 挪到开头 */}
          <span
            className="proj-path"
            style={!props.project.path_valid ? { color: 'var(--danger)' } : undefined}
            title={
              !props.project.path_valid
                ? (t('sidebar.projectPathMissing') ?? 'Project path missing — click to repair')
                : undefined
            }
          >
            {!props.project.path_valid && <span style={{ marginRight: 4 }}>⚠</span>}
            <bdi dir="ltr">{props.project.path}</bdi>
          </span>
        </div>
        <div className="flex items-center gap-1">
          {!props.project.path_valid && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                props.onRepairProject(props.project)
              }}
              className="row-action flex-shrink-0 flex items-center justify-center transition-all"
              style={{ width: 20, height: 20, borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--danger-30)', color: 'var(--danger)', fontSize: 11 }}
              title={t('sidebar.projectPathMissing') ?? 'Project path missing — click to repair'}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--warning)'
                e.currentTarget.style.color = 'var(--warning)'
                e.currentTarget.style.background = 'rgba(251, 191, 36, 0.1)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--danger-30)'
                e.currentTarget.style.color = 'var(--danger)'
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <IconWarning width={14} height={14} />
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation()
              props.onOpenCreateWorktree()
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
            <IconGitBranch width={14} height={14} />
          </button>
          <EditButton
            onClick={(e) => {
              e.stopPropagation()
              props.onRename({ type: 'project', id: props.project.id, name: props.project.name })
            }}
          />
          <DeleteButton
            onClick={(e) => {
              e.stopPropagation()
              props.onDeleteProject()
            }}
          />
        </div>
      </div>

      {/* Worktrees under expanded project */}
      {props.isExpanded && (
        <div className="sidebar-project-body">
          {wtList.length === 0 ? (
            <div className="px-2 py-1.5" style={{ fontSize: 12, color: 'var(--text-faint)' }}>
              {wtLoaded
                ? (t('sidebar.noWorktrees') ?? 'No worktrees found')
                : (t('sidebar.loading') ?? 'Loading...')}
            </div>
          ) : (
            wtList.map((wt) => {
              const isWtActive = props.activeWorkspaceId === wt.id
              const wtSessions = sessionsForWorktree(props.sessions, props.worktrees || [], wt.path)
              const wtAgg = aggregateStatus(wtSessions, attention.reasonFor, props.acpActivityFor)
              const isWtExpanded = isWtActive || (props.expandAllSessions && wtSessions.length > 0)

              // ACP 会话超阈值折叠（终端会话不受影响）。列表按 created_at DESC
              // 排序，补足阈值时天然保留最新的；豁免位留给「有事在做或要给用户看」的
              // 会话（运行中 / 等待决策 / 需注意力 / 完成未看），折叠后不丢关键信息。
              // 列表被切成「可见行 + 切换行 + 隐藏行」，
              // 展开时隐藏行从切换行下方就地追加——而不是插回原序中间，
              // 新行出现在用户点击处，收起/展开的语义与视觉一致。
              const acpSessions = wtSessions.filter((s) => s.runtime_kind === 'acp')
              const acpOverLimit = acpSessions.length > MAX_COLLAPSED_ACP_SESSIONS
              const acpCollapsed = acpOverLimit && !acpExpanded.has(wt.id)
              const visibleAcpIds = new Set<string>()
              if (acpOverLimit) {
                for (const s of acpSessions) {
                  // 状态判定复用 sessionStatus，与状态点/聚合徽标同一真源，禁止在此重写
                  // running || waiting 式散装条件。activeSessionId 例外——选中态是前端
                  // 概念，ACP 会话的 is_active 恒 false，sessionStatus 覆盖不到。
                  if (
                    s.id === props.activeSessionId ||
                    sessionStatus(s, attention.reasonFor(s.id), props.acpActivityFor(s.id)) !== 'none'
                  ) {
                    visibleAcpIds.add(s.id)
                  }
                }
                for (const s of acpSessions) {
                  if (visibleAcpIds.size >= MAX_COLLAPSED_ACP_SESSIONS) break
                  visibleAcpIds.add(s.id)
                }
              }
              const renderedSessions = acpOverLimit
                ? wtSessions.filter((s) => s.runtime_kind !== 'acp' || visibleAcpIds.has(s.id))
                : wtSessions
              const hiddenAcpSessions = acpOverLimit
                ? acpSessions.filter((s) => !visibleAcpIds.has(s.id))
                : []

              const renderSessionRow = (s: Session) => {
                // tmux 的 agent_state 与 ACP 的 chatStore 派生状态归一，
                // 状态点/tooltip 两类会话表现一致。折叠豁免判定（上方 visibleAcpIds）
                // 与行内 live 强调（SessionRow）复用同一 sessionStatus 真源。
                const activity =
                  s.runtime_kind === 'acp'
                    ? props.acpActivityFor(s.id)
                    : s.agent_state === 'waiting'
                      ? 'waiting'
                      : s.agent_state === 'running' || s.is_active
                        ? 'running'
                        : undefined
                return (
                  <SessionRow
                    key={s.id}
                    session={s}
                    isActive={props.activeSessionId === s.id}
                    attnReason={attention.reasonFor(s.id)}
                    activity={activity}
                    selectionMode={props.selectionMode}
                    isSelected={props.selectedIds.has(s.id)}
                    isMobile={isMobile}
                    onActivate={handleActivateSession}
                    onToggleSelect={props.onToggleSessionSelection}
                    onContextMenu={props.onSessionContextMenu}
                    onReleaseRequest={props.onReleaseRequest}
                    onArchiveRequest={props.onArchiveRequest}
                    onDeleteRequest={props.onDeleteSession}
                  />
                )
              }

              return (
                <div key={wt.id} className={`sidebar-wt-slot ${isWtActive ? 'active' : ''}`}>
                  {/* Worktree row */}
                  <div
                    className="sidebar-wt-row"
                    onClick={() => props.onWorkspaceClick(wt)}
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
                    <span className="branch-name" title={wt.label}><bdi dir="ltr">{wt.label}</bdi></span>
                    <CountBadge count={wtSessions.length} />
                    <button
                      className="sidebar-wt-add-btn"
                      onClick={(e) => {
                        e.stopPropagation()
                        props.onOpenCreateSession(wt)
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
                          props.onDeleteWorktree({ projectId: props.project.id, path: wt.path, label: wt.label, branch: wt.branch ?? null })
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
                      {renderedSessions.map(renderSessionRow)}

                      {/* 折叠切换行——可见行与隐藏行之间的接缝：
                          展开时隐藏行就从此行下方追加，收起时从此行下方消失 */}
                      {hiddenAcpSessions.length > 0 && (
                        <div
                          className="sidebar-session-more-toggle"
                          onClick={() => toggleAcpExpanded(wt.id)}
                        >
                          <span>{acpCollapsed ? '▼' : '▲'}</span>
                          <span>
                            {acpCollapsed
                              ? t('sidebar.showMoreSessions', { count: hiddenAcpSessions.length })
                              : t('sidebar.collapseSessions')}
                          </span>
                        </div>
                      )}
                      {!acpCollapsed && hiddenAcpSessions.map(renderSessionRow)}

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
}
