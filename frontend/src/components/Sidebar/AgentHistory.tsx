import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type AgentAcpSession } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useAgentStore } from '../../stores/agentStore'
import { AgentPicker } from '../AgentPicker/AgentPicker'
import { defaultAcpAgentId } from '../../utils/defaultAcpAgentId'
import { IconRefresh } from '../FileManager/icons'

/**
 * 「Agent 历史」面板内容——枚举 agent 侧的 ACP 会话（`session/list`）。
 *
 * **为什么值得单独一个面板**：omniterm 只能看到自己亲手创建/纳管的会话，用户在
 * 裸 CLI 里跑的、从别的机器拷来的 `acp_session_id` 全都不可见。这是唯一的发现
 * 入口（计划 E1）。
 *
 * **不轮询**：后端每次调用都临时拉起一个短命 agent 进程（spawn + RPC 各 15s
 * 预算），问完即收尸——轮询等于定时起进程。只在展开面板与手动刷新时拉。
 *
 * 顺带收益：后端把命中行的 agent 侧标题回填进 omniterm 自己的会话行，所以打开
 * 一次面板会让侧栏里那些「懒得命名」的会话从 `${agent}_${时间}` 变成 agent 起的
 * 标题（用户手写过的名字不受影响，见 utils/sessionDisplayName.ts）。
 *
 * §8 多实现兼容（实测 2026-10-16，勿把单一实现当约定）：
 * - opencode / qodercli：标题质量高（短句）；
 * - pi-acp：标题 = 用户首条消息原文（可能很长、带 shell 提示符）；
 * - omp：部分会话**没有** title 字段；
 * - codebuddy：`session/list` 整个方法 `-32601 Method not found` → 面板显示
 *   明确错误而不是空白列表（空白会被读成「你没有历史」）。
 */
export function AgentHistory() {
  const { t } = useTranslation()
  const agents = useAgentStore((s) => s.agents)
  const agentsLoaded = useAgentStore((s) => s.loaded)
  const loadAgents = useAgentStore((s) => s.loadAgents)
  const lastAcpAgentId = useAppStore((s) => s.lastAcpAgentId)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const worktrees = useAppStore((s) => s.worktrees)
  const sessions = useAppStore((s) => s.sessions)
  const activateSession = useAppStore((s) => s.activateSession)

  // 查询用的 cwd = 当前活动 worktree 路径（agent 侧按 cwd 组织会话历史；
  // D4：不传全部——一 project 多 worktree 全传会让列表翻倍且跨项目串扰）。
  const activeWorkspace = activeProjectId
    ? (worktrees[activeProjectId] ?? []).find((w) => w.id === activeWorkspaceId)
    : undefined
  const cwd = activeWorkspace?.path

  const [agentId, setAgentId] = useState<string | null>(null)
  const [rows, setRows] = useState<AgentAcpSession[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!agentsLoaded) void loadAgents()
  }, [agentsLoaded, loadAgents])

  // agent 列表到达后定默认值（处理异步加载竞态；记忆 id 优先于第一个，
  // 与 CreateSessionModal 同一口径——单一真源在 utils/defaultAcpAgentId.ts）。
  useEffect(() => {
    if (agentId === null && agents.length > 0) setAgentId(defaultAcpAgentId(agents, lastAcpAgentId))
  }, [agentId, agents, lastAcpAgentId])

  const load = useCallback(
    async (id: string) => {
      if (!cwd) return
      setLoading(true)
      setError(null)
      try {
        const res = await api.listAgentAcpSessions(id, cwd)
        setRows(res.sessions)
        setTruncated(res.truncated)
      } catch (e) {
        // 错误原文透出：codebuddy 的 "Method not found: session/list" 正是用户
        // 需要看到的那句。不兜成空列表——那会被读成「你没有历史」。
        setRows(null)
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [cwd],
  )

  // 展开即有数据：面板打开时按「agent × cwd」自动拉一次。用 ref 记已拉过的组合
  // 而不是 `rows === null` 判断——后者在「手动刷新失败后」会把自动重试又放行一次，
  // 而失败态已有明确错误展示，不该被自动重试覆盖。**不轮询**（每次调用都起进程）。
  const autoLoadedKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!agentId || !cwd) return
    const key = `${agentId}\u0000${cwd}`
    if (autoLoadedKeyRef.current === key) return
    autoLoadedKeyRef.current = key
    void load(agentId)
  }, [agentId, cwd, load])

  const refresh = () => {
    if (agentId) void load(agentId)
  }

  if (!cwd) {
    return (
      <div className="p-4 text-xs" style={{ color: 'var(--text-dim)' }}>
        {t('agentHistory.noWorkspace')}
      </div>
    )
  }

  return (
    <div className="flex flex-col" style={{ minHeight: 0 }}>
      {/* agent 选择 + 刷新 */}
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <AgentPicker
          value={agentId}
          onChange={(id) => {
            setAgentId(id)
            setRows(null)
            setError(null)
            if (id) void load(id)
          }}
          lastUsedId={lastAcpAgentId}
          className="flex-1 min-w-0 text-xs"
          style={{
            background: 'var(--bg-base)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-strong)',
            borderRadius: 2,
            padding: '4px 6px',
          }}
        />
        <button
          onClick={refresh}
          disabled={loading || !agentId}
          title={t('agentHistory.refresh')}
          className="row-action flex items-center justify-center transition-all flex-shrink-0"
          style={{
            width: 26,
            height: 26,
            borderWidth: 1,
            borderStyle: 'solid',
            borderColor: 'var(--border-strong)',
            color: 'var(--text-muted)',
            opacity: loading ? 0.5 : 1,
          }}
        >
          <IconRefresh width={14} height={14} />
        </button>
      </div>

      {/* 截断提示：后端有 200 条 / 10 页双上限，超限必须明示（§P1 超限策略） */}
      {truncated && (
        <div className="px-3 py-1.5 text-[10px]" style={{ background: 'var(--accent-10)', color: 'var(--text-secondary)' }}>
          {t('agentHistory.truncated')}
        </div>
      )}

      <div className="flex-1 overflow-y-auto" style={{ minHeight: 0 }}>
        {loading && (
          <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--text-dim)' }}>
            {t('agentHistory.loading')}
          </div>
        )}

        {!loading && error && (
          <div className="px-3 py-4 text-xs" style={{ color: 'var(--danger)' }}>
            <div className="font-medium mb-1">{t('agentHistory.errorTitle')}</div>
            <div className="break-words" style={{ color: 'var(--text-muted)' }}>{error}</div>
            <div className="mt-2" style={{ color: 'var(--text-dim)' }}>{t('agentHistory.errorHint')}</div>
          </div>
        )}

        {!loading && !error && rows !== null && rows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--text-dim)' }}>
            {t('agentHistory.empty')}
          </div>
        )}

        {!loading && !error && rows?.map((r) => {
          // 已纳管 = omniterm 侧有会话行绑定了这个 acp_session_id。点击切过去
          // （与侧栏行行为一致）；未纳管的行不给动作——「载入」是另一个用户动作
          // （计划 E2，未实施），不在这里偷偷建会话。
          const local = Object.values(sessions)
            .flat()
            .find((s) => s.acp_session_id === r.session_id)
          return (
            <div
              key={r.session_id}
              onClick={() => local && activateSession(local.id)}
              title={local ? t('agentHistory.managedHint') : r.cwd}
              className="px-3 py-2 transition-all"
              style={{
                borderBottom: '1px solid var(--border-subtle)',
                cursor: local ? 'pointer' : 'default',
                opacity: local ? 1 : 0.75,
              }}
              onMouseEnter={(e) => {
                if (local) e.currentTarget.style.background = 'var(--accent-10)'
              }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <div className="flex items-center gap-1.5">
                <span className="flex-1 min-w-0 truncate text-xs" style={{ color: 'var(--text-primary)' }}>
                  {/* title 缺省（omp 部分会话）→ 回落 session_id 截断，不显示空行 */}
                  {r.title || truncateMiddle(r.session_id)}
                </span>
                {local && (
                  <span
                    className="flex-shrink-0 text-[10px] px-1"
                    style={{ background: 'var(--accent-14)', color: 'var(--accent)', borderRadius: 2 }}
                  >
                    {t('agentHistory.managed')}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 text-[10px]" style={{ color: 'var(--text-faint)' }}>
                <span className="truncate" style={{ flex: '1 1 0', minWidth: 0 }}>
                  {r.cwd === cwd ? t('agentHistory.thisWorkspace') : r.cwd}
                </span>
                {r.updated_at && <span className="flex-shrink-0">{formatWhen(r.updated_at)}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** session_id 截断（标题缺省时的回落显示）：保留首尾各 6 字符。
 *  agent 侧 id 常见形态 `ses_xxxxx` / UUID，中间是熵最大的部分。 */
function truncateMiddle(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 6)}…${id.slice(-6)}`
}

/** RFC3339 → 本地简短时间（`MM-DD HH:mm`）。解析失败返回空串（不显示 "Invalid Date"）。 */
function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}
