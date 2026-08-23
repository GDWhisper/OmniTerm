import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Session } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useAgentStore } from '../../stores/agentStore'
import { READER_FONT } from '../../utils/fonts'
import { IconTrash, IconRefresh } from '../FileManager/icons'

/**
 * 已归档 ACP 会话区块——跨项目全局折叠列表（Sidebar 底部，External Sessions
 * 同层级）。数据由 Sidebar 经 GET /sessions/archived 拉取并存 appStore.archivedSessions
 * （归档/取消归档/删除后由 Sidebar 触发重拉），本组件只做渲染：
 * 点击行 = 只读查看聊天历史，hover 动作 = 取消归档 / 删除。
 * 无归档会话时整块不渲染（与 ExternalSessionsSection 惯例一致）。
 */
export function ArchivedSessionsSection(props: {
  sessions: Session[]
  onOpen: (session: Session) => void
  onUnarchive: (session: Session) => void
  onDelete: (session: Session) => void
}) {
  const { t } = useTranslation()
  const projects = useAppStore((s) => s.projects)
  const agents = useAgentStore((s) => s.agents)
  const [expanded, setExpanded] = useState(false)

  if (props.sessions.length === 0) return null

  return (
    <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <div
        className="flex items-center justify-between px-1 mb-1.5 cursor-pointer rounded transition-all"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-1.5">
          <span
            style={{
              fontSize: 12,
              color: expanded ? 'var(--accent)' : 'var(--text-dim)',
              transition: 'transform 0.15s',
              display: 'inline-block',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >▸</span>
          <span style={{ fontSize: 11, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 2, fontWeight: 600 }}>
            {t('sidebar.archivedSessions') ?? 'Archived'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{props.sessions.length}</span>
        </div>
      </div>

      {expanded && (
        <div className="pl-4 pr-1">
          {props.sessions.map((s) => {
            const agentName = agents.find((a) => a.id === s.agent_id)?.display_name
            const projectName = projects.find((p) => p.id === s.project_id)?.name
            return (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-md transition-all mb-1 cursor-pointer"
                style={{ padding: '5px 8px' }}
                onClick={() => props.onOpen(s)}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-10)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                {/* 归档标记点：灰色方块区别于活跃列表的圆点 */}
                <div className="flex-shrink-0" style={{ width: 6, height: 6, background: 'var(--text-faint)' }} />
                <div className="flex-1 min-w-0">
                  <span className="block truncate" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    {s.name || s.tmux_session_name}
                  </span>
                  <span className="block truncate" style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 1 }}>
                    {[agentName, projectName].filter(Boolean).join(' · ')}
                  </span>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onUnarchive(s)
                  }}
                  className="row-action flex-shrink-0 flex items-center justify-center transition-all"
                  style={{ width: 20, height: 20, borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--border-strong)', color: 'var(--text-faint)', background: 'transparent' }}
                  title={t('sidebar.unarchiveSession') ?? 'Restore to list'}
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
                  <IconRefresh width={13} height={13} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onDelete(s)
                  }}
                  className="row-action flex-shrink-0 flex items-center justify-center transition-all sidebar-glow-red-hover"
                  style={{ width: 20, height: 20, borderWidth: '1px', borderStyle: 'solid', borderColor: 'var(--border-strong)', color: 'var(--text-faint)', background: 'transparent', fontFamily: READER_FONT }}
                  title={t('sidebar.delete') ?? 'Delete'}
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
                  <IconTrash width={13} height={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
