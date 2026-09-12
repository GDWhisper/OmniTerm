import { useState, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { useAgentStore } from '../../stores/agentStore'
import { Modal } from '../Modal/Modal'
import { PixelButton } from '../PixelUI/PixelButton'
import { AgentPicker } from '../AgentPicker/AgentPicker'
import { BetaBadge } from '../Common/BetaBadge'
import { TerminalIcon } from '../Icons/TerminalIcon'
import { KeyboardIcon } from '../Icons/KeyboardIcon'
import { READER_FONT } from '../../utils/fonts'
import { resolveTerminalEngine, terminalEngineLabel, type TerminalEngine } from '../../utils/terminalEngine'
import { inputClass, inputStyle } from './sidebarModalStyles'

/* ─── Types ─── */

type Category = 'terminal' | 'acp'

/* ─── Unstyled card (selection + expandable, no theme tokens) ─── */

function SelectionCard({
  selected,
  onClick,
  disabled,
  children,
}: {
  selected: boolean
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full text-left"
      style={{
        position: 'relative',
        padding: '12px',
        border: selected ? '2px solid var(--accent)' : '1px solid var(--border-subtle)',
        background: selected ? 'var(--bg-surface)' : 'var(--bg-base)',
        borderRadius: '4px',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        outline: 'none',
        transition: 'border-color 0.1s, background 0.1s',
      }}
    >
      {children}
    </button>
  )
}

/* ACP agent 默认选中：上次成功创建的 agent > 第一个（记忆 id 已被删除时回落） */
function defaultAcpAgentId(
  agents: { id: string }[],
  lastAcpAgentId: string | null,
): string | null {
  if (lastAcpAgentId && agents.some((a) => a.id === lastAcpAgentId)) return lastAcpAgentId
  return agents[0]?.id ?? null
}

/* ─── Main component ─── */

export function CreateSessionModal(props: {
  workspaceId: string | null
  onClose: () => void
  reloadSessions: () => Promise<void>
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const worktrees = useAppStore((s) => s.worktrees)
  const activateSession = useAppStore((s) => s.activateSession)
  const multiplexerAvailable = useAppStore((s) => s.multiplexerAvailable)
  const multiplexer = useAppStore((s) => s.multiplexer)
  const defaultTerminalEngine = useAppStore((s) => s.defaultTerminalEngine)
  const setDefaultTerminalEngine = useAppStore((s) => s.setDefaultTerminalEngine)
  const lastAcpAgentId = useAppStore((s) => s.lastAcpAgentId)
  const setLastAcpAgentId = useAppStore((s) => s.setLastAcpAgentId)
  const agents = useAgentStore((s) => s.agents)

  const [sessName, setSessName] = useState('')
  // 会话大类：terminal (默认) | acp
  const [category, setCategory] = useState<Category>('terminal')
  // Terminal 子引擎在本弹窗内的点选（null = 未点选，沿用默认引擎）
  const [engineChoice, setEngineChoice] = useState<TerminalEngine | null>(null)
  // 优先级：本次点选 > 默认引擎（设置 → 终端）。两者同一个值，不另设「上次使用」记忆
  // 一层；宿主无复用器时期望值不可兑现，走共享回落收敛。
  const terminalEngine = resolveTerminalEngine(
    engineChoice ?? defaultTerminalEngine,
    multiplexerAvailable,
  )
  // ACP agent 选择（仅 category=acp 时生效）
  const [acpAgentId, setAcpAgentId] = useState<string | null>(null)
  // 切到 ACP 后 agents 到达时自动选中（处理异步加载竞态；记忆 id 优先于第一个）
  useEffect(() => {
    if (category === 'acp' && acpAgentId === null && agents.length > 0) {
      setAcpAgentId(defaultAcpAgentId(agents, lastAcpAgentId))
    }
  }, [category, acpAgentId, agents, lastAcpAgentId])
  const [submitting, setSubmitting] = useState(false)

  // ─── Reset ───

  const resetState = () => {
    setSessName('')
    setCategory('terminal')
    setEngineChoice(null)
    setAcpAgentId(null)
    setSubmitting(false)
  }

  const handleClose = () => {
    props.onClose()
    resetState()
  }

  // ─── Create ───

  const handleCreateSession = async () => {
    if (!activeProjectId || !props.workspaceId) return
    if (category === 'acp' && !acpAgentId) return

    const wtList = worktrees[activeProjectId] || []
    const targetWt = wtList.find((w) => w.id === props.workspaceId)
    if (!targetWt) return

    setSubmitting(true)
    try {
      const name = sessName.trim() || (() => {
        if (category !== 'acp' || !acpAgentId) return undefined
        const agent = agents.find((a) => a.id === acpAgentId!)
        if (!agent) return undefined
        const now = new Date()
        const ts = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
        return `${agent.display_name}_${ts}`
      })()
      const runtimeKind = category === 'acp' ? 'acp' : terminalEngine
      const agentId = category === 'acp' ? acpAgentId : undefined
      const sessionAgentId = agentId ?? undefined
      const newSession = await api.createSession(
        activeProjectId,
        targetWt.path,
        name,
        undefined,
        runtimeKind,
        sessionAgentId,
      )
      await props.reloadSessions()
      // 只记本次实际创建的类别——ACP 创建不该刷新引擎默认（反之亦然）。
      // 引擎只在用户本会话显式点选时写入：未点选 = 沿用现有默认，而回落到 pty
      // （宿主缺复用器）不是用户意图，不该把设置里的 tmux 偏好静默改掉。
      if (category === 'acp') setLastAcpAgentId(acpAgentId!)
      else if (engineChoice) setDefaultTerminalEngine(engineChoice)
      activateSession(newSession.id)
      addToast('success', t('sidebar.sessionCreated', { name: sessName.trim() || t('sidebar.unnamed') }) ?? 'Session created')
      handleClose()
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
    }
  }

  // ─── Keyboard ───

  const handleSessKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreateSession()
    }
  }

  // ─── Category click ───

  const selectCategory = (c: Category) => {
    setCategory(c)
    // 切换到 ACP 时，若尚未选择 agent 且列表有可用项，按默认优先级选中
    if (c === 'acp' && acpAgentId === null && agents.length > 0) {
      setAcpAgentId(defaultAcpAgentId(agents, lastAcpAgentId))
    }
  }

  // ─── Create button disabled? ───

  const canCreate = category === 'terminal' || acpAgentId !== null

  // ─── Render ───

  return (
    <Modal open={props.workspaceId !== null} onClose={handleClose} title={t('sidebar.createSession')} maxWidth="max-w-sm">
      <div className="space-y-4">
        {/* 会话名称 */}
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
            {t('sidebar.sessionName')}{' '}
            <span style={{ color: 'var(--text-dim)' }}>{t('sidebar.optional')}</span>
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
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)'
              e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)'
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--border-strong)'
              e.currentTarget.style.boxShadow = 'none'
            }}
          />
        </div>

        {/* 会话类型 —— 大卡 */}
        <div>
          <label className="block text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
            {t('sidebar.sessionTypeLabel')}
          </label>
          <div className="grid grid-cols-2 gap-2">
            {/* 终端大卡 */}
            <SelectionCard
              selected={category === 'terminal'}
              onClick={() => selectCategory('terminal')}
            >
              <div className="flex items-start gap-2">
                <TerminalIcon size={24} />
                <div className="min-w-0">
                  <span
                    className="block text-xs font-medium truncate"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    终端
                  </span>
                  <span
                    className="block text-[10px] truncate"
                    style={{ color: 'var(--text-secondary)', fontFamily: READER_FONT }}
                  >
                    命令行终端 · {terminalEngineLabel(terminalEngine, t)}
                  </span>
                </div>
              </div>
            </SelectionCard>

            {/* ACP 大卡 */}
            <SelectionCard selected={category === 'acp'} onClick={() => selectCategory('acp')}>
              <div className="flex items-start gap-2">
                <KeyboardIcon size={22} />
                <div className="min-w-0">
                  <span
                    className="block text-xs font-medium truncate"
                    style={{ color: 'var(--text-primary)' }}
                  >
                    {t('sidebar.sessionTypeAcpLabel')}
                  </span>
                  <span
                    className="block text-[10px] truncate"
                    style={{ color: 'var(--text-secondary)', fontFamily: READER_FONT }}
                  >
                    ACP 协议 AI 会话
                  </span>
                </div>
              </div>
            </SelectionCard>
          </div>
        </div>

        {/* 终端引擎 */}
        {category === 'terminal' && (
          <div>
                <label className="block text-xs font-medium mb-2" style={{ color: 'var(--text-muted)' }}>
                  引擎
                </label>
                <div className="flex gap-2">
                  {/* Tmux 引擎卡 —— 稳定实现放首位；PTY 仍在 beta，排后 */}
                  <SelectionCard
                    selected={terminalEngine === 'tmux'}
                    onClick={() => {
                      if (multiplexerAvailable) setEngineChoice('tmux')
                    }}
                    disabled={!multiplexerAvailable}
                  >
                    <span className="block text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                      {t('sidebar.sessionTypeTmuxLabel')}
                    </span>
                    <span className="block text-[10px] mt-0.5" style={{ color: 'var(--text-secondary)', fontFamily: READER_FONT }}>
                      {multiplexerAvailable
                        ? t('sidebar.sessionTypeTmuxHint')
                        : t('sidebar.muxUnavailable', { mux: multiplexer })}
                    </span>
                  </SelectionCard>

                  {/* PTY 引擎卡 */}
                  <SelectionCard
                    selected={terminalEngine === 'pty'}
                    onClick={() => setEngineChoice('pty')}
                  >
                    <span className="block text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                      {t('sidebar.sessionTypePtyLabel')} <BetaBadge />
                    </span>
                    <span className="block text-[10px] mt-0.5" style={{ color: 'var(--text-secondary)', fontFamily: READER_FONT }}>
                      {t('sidebar.sessionTypePtyHint')}
                    </span>
                  </SelectionCard>
                </div>
          </div>
        )}

        {/* ACP Agent 选择 */}
        {category === 'acp' && (
          <div>
                <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
                  {t('agentPicker.label')}
                </label>
                <AgentPicker
                  value={acpAgentId}
                  onChange={setAcpAgentId}
                  lastUsedId={lastAcpAgentId}
                  className={inputClass}
                  style={inputStyle}
                />
                <p className="mt-1.5 text-[10px]" style={{ color: 'var(--text-secondary)', fontFamily: READER_FONT }}>
                  {t('agentPicker.hint', { mux: multiplexer })}
                </p>
              </div>
        )}

        {/* 操作按钮 */}
        <div className="flex justify-end gap-2 pt-1">
          <PixelButton variant="secondary" onClick={handleClose}>
            {t('sidebar.cancel')}
          </PixelButton>
          <PixelButton variant="accent" onClick={handleCreateSession} disabled={submitting || !canCreate}>
            {submitting ? t('sidebar.creating') : t('sidebar.create')}
          </PixelButton>
        </div>
      </div>
    </Modal>
  )
}
