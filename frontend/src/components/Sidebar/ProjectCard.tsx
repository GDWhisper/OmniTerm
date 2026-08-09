import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { useAttention } from '../../hooks/useAttention'
import type { Session, Project, Workspace } from '../../api/client'
import { aggregateStatus, type AcpActivity } from '../../utils/agentAggregate'
import { sessionsForWorktree } from '../../utils/worktreeSessions'
import { IconPlus, IconTrash, IconWarning } from '../FileManager/icons'
import { CountBadge } from '../Common/CountBadge'
import { GitBranchSprite } from '../PixelUI'
import { EditButton, DeleteButton, ReleaseButton } from './RowActionButtons'
import type { RenameTarget } from './RenameDialog'
import type { DeleteTarget } from './DeleteConfirmDialog'
import type { DeleteWorktreeTarget } from './DeleteWorktreeDialog'

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
}) {
  const { t } = useTranslation()
  const attention = useAttention()
  const pixelAnimationsEnabled = useAppStore((s) => s.pixelAnimationsEnabled)
  const activateSession = useAppStore((s) => s.activateSession)

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
            <IconPlus width={14} height={14} />
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
                          props.onDeleteWorktree({ projectId: props.project.id, path: wt.path, label: wt.label })
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
                        const isSessionActive = props.activeSessionId === s.id
                        const sessionKey = s.id
                        const attnReason = attention.reasonFor(sessionKey)
                        // tmux 的 agent_state 与 ACP 的 chatStore 派生状态归一，
                        // 状态点/tooltip 两类会话表现一致
                        const activity =
                          s.runtime_kind === 'acp'
                            ? props.acpActivityFor(s.id)
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
                                  props.onReleaseRequest(s)
                                }}
                              />
                            )}
                            <EditButton
                              onClick={(e) => {
                                e.stopPropagation()
                                props.onRename({ type: 'session', id: s.id, name: s.name || '' })
                              }}
                            />
                            <DeleteButton
                              onClick={(e) => {
                                e.stopPropagation()
                                props.onDeleteSession({
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
}
