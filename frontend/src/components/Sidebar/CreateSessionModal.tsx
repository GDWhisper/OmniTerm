import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { useAgentStore } from '../../stores/agentStore'
import { Modal } from '../Modal/Modal'
import { PixelButton } from '../PixelUI/PixelButton'
import { AgentPicker } from '../AgentPicker/AgentPicker'
import { READER_FONT } from '../../utils/fonts'
import { BetaBadge } from '../Common/BetaBadge'
import { inputClass, inputStyle } from './sidebarModalStyles'

/**
 * Create-session modal for a single worktree. Holds its own form state
 * (`sessName` / `sessAgentId` / `submitting`); the Sidebar only supplies
 * the target workspace (`workspaceId`, null = closed) and a reload callback
 * for the session list.
 */
export function CreateSessionModal(props: {
  workspaceId: string | null           // null = 关闭；即原 createSessOpen + sessWorkspaceId 合一
  onClose: () => void
  reloadSessions: () => Promise<void>  // Sidebar 侧 loadSessions
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const worktrees = useAppStore((s) => s.worktrees)
  const activateSession = useAppStore((s) => s.activateSession)
  const multiplexer = useAppStore((s) => s.multiplexer)
  const multiplexerAvailable = useAppStore((s) => s.multiplexerAvailable)
  const [sessName, setSessName] = useState('')
  const [sessAgentId, setSessAgentId] = useState<string | null>(null)
  // 引擎选择仅对无 agent 的终端会话生效（选了 agent → ACP 会话，选择器隐藏）。
  const [engine, setEngine] = useState<'pty' | 'tmux'>('pty')
  const [submitting, setSubmitting] = useState(false)

  const workspaceId = props.workspaceId

  const handleClose = () => {
    props.onClose()
    setSessName('')
    setSessAgentId(null)
    setEngine('pty')
  }

  const handleCreateSession = async () => {
    if (!activeProjectId || !workspaceId) return
    // Find the target worktree path (captured when "+" was clicked)
    const wtList = worktrees[activeProjectId] || []
    const targetWt = wtList.find(w => w.id === workspaceId)
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
        sessAgentId ? 'acp' : engine,
        sessAgentId ?? undefined,
      )
      await props.reloadSessions()
      // Auto-activate the newly created session so the terminal pane
      // switches to it immediately. Atomic (clears external + sets
      // activeSession + updates workspace memory in one set()).
      activateSession(newSession.id)
      addToast('success', t('sidebar.sessionCreated', { name: sessName.trim() || t('sidebar.unnamed') }) ?? `Session created`)
      handleClose()
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
    }
  }

  const handleSessKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreateSession()
    }
  }

  return (
    <Modal open={workspaceId !== null} onClose={handleClose} title={t('sidebar.createSession')} maxWidth="max-w-sm">
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
        {!sessAgentId && (
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.engineLabel')}
            </label>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="session-engine"
                  value="pty"
                  checked={engine === 'pty'}
                  onChange={() => setEngine('pty')}
                  style={{ accentColor: 'var(--accent)', marginTop: 2 }}
                />
                <span>
                  <span className="block text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                    pty <BetaBadge />
                  </span>
                  <span className="block text-xs" style={{ color: 'var(--text-secondary)', fontFamily: READER_FONT }}>
                    {t('sidebar.enginePtyHint')}
                  </span>
                </span>
              </label>
              <label
                className="flex items-start gap-2"
                style={{ opacity: multiplexerAvailable ? 1 : 0.5, cursor: multiplexerAvailable ? 'pointer' : 'not-allowed' }}
              >
                <input
                  type="radio"
                  name="session-engine"
                  value="tmux"
                  checked={engine === 'tmux'}
                  onChange={() => setEngine('tmux')}
                  disabled={!multiplexerAvailable}
                  style={{ accentColor: 'var(--accent)', marginTop: 2 }}
                />
                <span>
                  <span className="block text-xs font-medium" style={{ color: 'var(--text-primary)' }}>tmux</span>
                  <span className="block text-xs" style={{ color: 'var(--text-secondary)', fontFamily: READER_FONT }}>
                    {multiplexerAvailable ? t('sidebar.engineTmuxHint') : t('sidebar.engineTmuxUnavailable', { mux: multiplexer })}
                  </span>
                </span>
              </label>
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <PixelButton variant="secondary" onClick={handleClose}>
            {t('sidebar.cancel')}
          </PixelButton>
          <PixelButton variant="accent" onClick={handleCreateSession} disabled={submitting}>
            {submitting ? t('sidebar.creating') : t('sidebar.create')}
          </PixelButton>
        </div>
      </div>
    </Modal>
  )
}
