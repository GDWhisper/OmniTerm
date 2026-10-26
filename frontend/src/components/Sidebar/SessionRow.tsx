import { memo, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Session } from '../../api/client'
import { sessionStatus, type AcpActivity } from '../../utils/agentAggregate'
import { relativeAgeParts } from '../../utils/formatTime'
import { sessionDisplayName } from '../../utils/sessionDisplayName'
import { useAgentStore } from '../../stores/agentStore'
import type { AttentionReason } from '../../hooks/useAttention'
import { useLongPress, LONG_PRESS_CLICK_SUPPRESS_MS } from '../../hooks/useLongPress'
import { useMinuteNow } from '../../hooks/useMinuteNow'
import { hapticTap } from '../../utils/haptics'
import { ArchiveButton, DeleteButton, ReleaseButton } from './RowActionButtons'
import type { DeleteTarget } from './DeleteConfirmDialog'
import type { ContextMenuPoint } from '../Common/ContextMenu'
import { popoverAnchor } from '../../utils/popover'

const MARQUEE_PX_PER_SECOND = 25
const MARQUEE_MIN_SECONDS = 6
const MARQUEE_MAX_SECONDS = 24

const AGE_LABEL_KEYS = {
  minute: 'sidebar.ageMinute',
  hour: 'sidebar.ageHour',
  day: 'sidebar.ageDay',
  month: 'sidebar.ageMonth',
  year: 'sidebar.ageYear',
} as const

export interface SessionRowProps {
  session: Session
  isActive: boolean
  /** 该会话需要用户注意的原因（useAttention.reasonFor 的结果）。 */
  attnReason: AttentionReason | undefined
  /** 归一后的活动状态（tmux agent_state / ACP chatStore 派生）。 */
  activity: AcpActivity | undefined
  selectionMode: boolean
  isSelected: boolean
  isMobile: boolean
  onActivate: (sessionId: string) => void
  onToggleSelect: (sessionId: string) => void
  onContextMenu: (session: Session, point: ContextMenuPoint) => void
  onReleaseRequest: (session: Session) => void
  onArchiveRequest: (session: Session) => void
  onDeleteRequest: (target: DeleteTarget) => void
}

/**
 * 侧栏会话行（从 ProjectCard 提取）。三种触发形态：
 * - 单击：激活会话；批量选择模式下改为切换勾选
 * - 右键（桌面）：弹上下文菜单
 * - 长按（移动端，useLongPress 500ms）：弹同一菜单
 *
 * memo：批量选择模式每次勾选都会更新 Sidebar 选择集，只有 `isSelected`
 * 变化的行重渲染——前提是父级回调引用稳定（Sidebar 侧 useCallback）。
 */
export const SessionRow = memo(function SessionRow({
  session,
  isActive,
  attnReason,
  activity,
  selectionMode,
  isSelected,
  isMobile,
  onActivate,
  onToggleSelect,
  onContextMenu,
  onReleaseRequest,
  onArchiveRequest,
  onDeleteRequest,
}: SessionRowProps) {
  const { t } = useTranslation()
  // 展示名单一真源见 utils/sessionDisplayName.ts。直接订阅 agentStore（而非由
  // 父级逐行传 props）：agents 引用只在加载/增删时变，memo 契约不受影响，
  // 却省掉 Sidebar 给每一行都算一遍的 N 次重复计算。
  const agents = useAgentStore((s) => s.agents)
  const displayName = sessionDisplayName(session, agents, t('sidebar.unnamed'))
  // 长按触发时间戳：抑制 touchend 后浏览器补发的 click（见上方常量注释）。
  const longPressAtRef = useRef(0)

  const { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel } = useLongPress({
    disabled: !isMobile || selectionMode,
    onLongPress: (point) => {
      longPressAtRef.current = Date.now()
      hapticTap()
      onContextMenu(session, { x: point.x, y: point.y })
    },
  })

  // 行尾动作按钮数决定「时间槽」展开后的宽度。选择模式不渲染动作，
  // 时间槽保持纯时间宽度（见 index.css .session-age / .session-actions）。
  const actionCount = selectionMode
    ? 0
    : session.runtime_kind === 'acp'
      ? (session.acp_process_alive ? 3 : 2)
      : 1
  const hasActions = actionCount > 0

  // 共享分钟级时钟：非活动项目的会话不再由 3s 轮询刷新，相对时间仍需走字。
  const now = useMinuteNow()
  // 「上次会话」口径：ACP 取最近一次 turn 定稿时刻；从未有过 turn 或终端会话
  // 回退到创建时刻（后端目前没有更细的终端活动时间）。
  const lastActiveAt = session.last_turn_at || session.created_at
  const lastActiveMs = Date.parse(lastActiveAt)
  const age = relativeAgeParts(lastActiveMs, now)
  const ageLabel =
    age === null
      ? ''
      : age.unit === 'now'
        ? t('sidebar.ageNow')
        : t(AGE_LABEL_KEYS[age.unit], { value: age.value })

  const titleRef = useRef<HTMLSpanElement>(null)
  const [titleOverflow, setTitleOverflow] = useState(0)

  // 标题溢出测量：hover 时行尾时间槽会扩展为动作按钮槽，标题可用宽度随之
  // 变化，ResizeObserver 会在这一拍补测，marquee 距离始终以当前宽度为准。
  useLayoutEffect(() => {
    const el = titleRef.current
    if (!el) return
    const measure = () => {
      const next = Math.max(0, el.scrollWidth - el.clientWidth)
      setTitleOverflow((prev) => (Math.abs(prev - next) <= 1 ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [displayName])

  const marqueeStyles =
    titleOverflow > 0
      ? ({
          '--session-marquee-distance': `${titleOverflow}px`,
          '--session-marquee-duration': `${Math.min(
            MARQUEE_MAX_SECONDS,
            Math.max(MARQUEE_MIN_SECONDS, Math.round(titleOverflow / MARQUEE_PX_PER_SECOND)),
          )}s`,
        } as CSSProperties)
      : undefined
  const rowStyles = hasActions
    ? ({ '--session-action-count': actionCount } as CSSProperties)
    : undefined

  const handleClick = () => {
    if (Date.now() - longPressAtRef.current < LONG_PRESS_CLICK_SUPPRESS_MS) return
    if (selectionMode) {
      onToggleSelect(session.id)
      return
    }
    onActivate(session.id)
  }

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    // 选择模式下不弹菜单：菜单「批量操作」会把选择集重置为仅当前行（预选语义）
    if (selectionMode) return
    onContextMenu(session, { x: e.clientX, y: e.clientY })
  }

  // 折叠豁免让「活跃但很老」的会话露在可见区底部，位置本身不携带信息。
  // 排序保持 created_at DESC 不动（置顶会在状态跳变时整行跳动），
  // 改用文字色阶 + 状态点呼吸把它标出来；live 判定复用 sessionStatus，
  // 与 worktree 聚合状态同一真源。
  const status = sessionStatus(session, attnReason, activity)
  const isLive = status === 'working' || status === 'blocked'
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
      className={`sidebar-session-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}${hasActions ? ' has-actions' : ''}`}
      style={rowStyles}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      {/* 选择模式勾选框（复用全局主题化 checkbox 样式，见 index.css .fm-checkbox） */}
      {selectionMode && (
        <input
          type="checkbox"
          className="fm-checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(session.id)}
          onClick={(e) => e.stopPropagation()}
          style={{ flexShrink: 0 }}
        />
      )}
      {/* ACP kind badge — 绝对定位叠加在左侧 28px 缩进槽，不占行内布局；
          绿字=进程驻留（未释放），灰字=已释放 */}
      {session.runtime_kind === 'acp' && (
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
            color: session.acp_process_alive ? '#7EE787' : 'var(--text-faint)',
          }}
          title={
            session.acp_process_alive
              ? t('sidebar.acpRunning')
              : t('sidebar.acpReleased')
          }
        >
          A
        </span>
      )}
      {/* Running indicator dot */}
      <div
        className={`flex-shrink-0${isLive ? ' activity-pulse' : ''}`}
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
      <span
        ref={titleRef}
        className={`session-name${isLive ? ' session-name-live' : ''}${titleOverflow > 0 ? ' is-overflowing' : ''}`}
        style={marqueeStyles}
      >
        <span className="session-name-text">{displayName}</span>
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
      {/* 行尾时间槽：空闲时显示「上次会话距今多久」；hover/focus/active/触屏
          时槽宽扩展到动作按钮所需宽度，时间淡出，按钮淡入（两者共用一个槽，
          不额外占用标题宽度）。时间本身仍留在布局里作为槽宽基准。 */}
      <time
        className="session-age"
        dateTime={Number.isFinite(lastActiveMs) ? lastActiveAt : undefined}
      >
        {ageLabel}
      </time>
      {/* 行内操作按钮：绝对定位叠在时间槽上，避免空闲时为不可见按钮预留宽度。
          选择模式整体不渲染（.row-action 在 pointer:coarse 下恒显，不能靠
          opacity 隐藏）。重命名入口已移至右键/长按菜单。 */}
      {hasActions && (
        <div className="session-actions">
          {session.runtime_kind === 'acp' && session.acp_process_alive && (
            <ReleaseButton
              onClick={(e) => {
                e.stopPropagation()
                onReleaseRequest(session)
              }}
            />
          )}
          {session.runtime_kind === 'acp' && (
            <ArchiveButton
              onClick={(e) => {
                e.stopPropagation()
                onArchiveRequest(session)
              }}
            />
          )}
          <DeleteButton
            onClick={(e) => {
              e.stopPropagation()
              onDeleteRequest({
                type: 'session',
                id: session.id,
                name: session.name || session.tmux_session_name || t('sidebar.unnamed'),
                // 删除确认弹窗据此决定是否显示「同时删除 agent 侧记录」勾选框
                // （可用性只看 agent 能力）；三个 ACP 字段供两段式补报（行删掉后
                // 后端取不到，由前端带着补发 agent 侧删除端点）
                runtimeKind: session.runtime_kind,
                acpSessionId: session.acp_session_id,
                agentId: session.agent_id,
                workspacePath: session.workspace_path,
                // 删除确认是锚定气泡：把按钮此刻的视口矩形带出去
                // （PopoverConfirm 据此贴边定位，不持有 DOM 引用）
                anchor: popoverAnchor(e.currentTarget),
              })
            }}
          />
        </div>
      )}
    </div>
  )
})
