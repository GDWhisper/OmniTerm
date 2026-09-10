import { memo, useRef, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Session } from '../../api/client'
import { sessionStatus, type AcpActivity } from '../../utils/agentAggregate'
import type { AttentionReason } from '../../hooks/useAttention'
import { useLongPress } from '../../hooks/useLongPress'
import { hapticTap } from '../../utils/haptics'
import { ArchiveButton, DeleteButton, ReleaseButton } from './RowActionButtons'
import type { DeleteTarget } from './DeleteConfirmDialog'
import type { ContextMenuPoint } from './SessionContextMenu'

/** 长按触发后抑制紧随补发 click 的时间窗（ms）。浏览器在 touchend 后向
 *  touchstart 目标补发一次 click——不抑制的话，长按弹菜单会同时激活会话
 *  （ChatMessage 的长按先例没有 onClick，未覆盖此坑）。 */
const LONG_PRESS_CLICK_SUPPRESS_MS = 700

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
      className={`sidebar-session-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
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
      <span className={`session-name${isLive ? ' session-name-live' : ''}`}>
        {session.name || session.tmux_session_name}
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
      {/* 行内操作按钮：选择模式下整体不渲染（.row-action 在 pointer:coarse 下
          恒显，不能靠 opacity 隐藏）。重命名入口已移至右键/长按菜单。 */}
      {!selectionMode && session.runtime_kind === 'acp' && session.acp_process_alive && (
        <ReleaseButton
          onClick={(e) => {
            e.stopPropagation()
            onReleaseRequest(session)
          }}
        />
      )}
      {!selectionMode && session.runtime_kind === 'acp' && (
        <ArchiveButton
          onClick={(e) => {
            e.stopPropagation()
            onArchiveRequest(session)
          }}
        />
      )}
      {!selectionMode && (
        <DeleteButton
          onClick={(e) => {
            e.stopPropagation()
            onDeleteRequest({
              type: 'session',
              id: session.id,
              name: session.name || session.tmux_session_name || t('sidebar.unnamed'),
            })
          }}
        />
      )}
    </div>
  )
})
