import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { api } from '../../api/client'
import { APP_VERSION } from '../../version'
import { Modal } from '../Modal/Modal'
import { ConfirmDialog } from '../Modal/ConfirmDialog'

const FONT = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace"

export function Sidebar() {
  const {
    workspaces,
    sessions,
    activeWorkspaceId,
    activeSessionId,
    sidebarCollapsed,
    setWorkspaces,
    setSessions,
    setActiveWorkspace,
    setActiveSession,
  } = useAppStore()

  const toggleSidebarCollapsed = useAppStore((s) => s.toggleSidebarCollapsed)

  const addToast = useToastStore((s) => s.addToast)

  const [createWsOpen, setCreateWsOpen] = useState(false)
  const [createSessOpen, setCreateSessOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<{
    type: 'workspace' | 'session'
    id: string
    name: string
  } | null>(null)

  const [wsName, setWsName] = useState('')
  const [wsPath, setWsPath] = useState('')
  const [sessName, setSessName] = useState('')
  const [homeDir, setHomeDir] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadWorkspaces = useCallback(async () => {
    try {
      const ws = await api.listWorkspaces()
      setWorkspaces(ws)
    } catch {
      // api client already shows error toast
    }
  }, [setWorkspaces])

  const loadSessions = useCallback(async () => {
    if (!activeWorkspaceId) return
    try {
      const s = await api.listSessions(activeWorkspaceId)
      setSessions(s)
    } catch {
      // api client already shows error toast
    }
  }, [activeWorkspaceId, setSessions])

  useEffect(() => { loadWorkspaces() }, [loadWorkspaces])
  useEffect(() => { loadSessions() }, [loadSessions])

  useEffect(() => {
    api.systemInfo().then((info) => {
      setHomeDir(info.home_dir)
      setWsPath(info.home_dir)
    }).catch(() => {
      // fallback: leave wsPath empty, user fills it in
    })
  }, [])

  const handleCreateWorkspace = async () => {
    if (!wsName.trim()) return
    setSubmitting(true)
    try {
      await api.createWorkspace({ name: wsName.trim(), root_path: wsPath.trim() })
      await loadWorkspaces()
      addToast('success', `工作区「${wsName.trim()}」创建成功`)
      setCreateWsOpen(false)
      setWsName('')
      setWsPath(homeDir)
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
    }
  }

  const handleCreateSession = async () => {
    if (!activeWorkspaceId) return
    setSubmitting(true)
    try {
      await api.createSession(activeWorkspaceId, sessName.trim() || undefined)
      await loadSessions()
      addToast('success', '会话创建成功')
      setCreateSessOpen(false)
      setSessName('')
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
    }
  }

  const handleDeleteWorkspace = async () => {
    if (!confirmDelete || confirmDelete.type !== 'workspace') return
    setSubmitting(true)
    try {
      await api.deleteWorkspace(confirmDelete.id)
      await loadWorkspaces()
      if (activeWorkspaceId === confirmDelete.id) {
        setActiveWorkspace(null)
        setSessions([])
      }
      addToast('success', `工作区「${confirmDelete.name}」已删除`)
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
    try {
      await api.deleteSession(confirmDelete.id)
      await loadSessions()
      if (activeSessionId === confirmDelete.id) {
        setActiveSession(null)
      }
      addToast('success', `会话「${confirmDelete.name}」已删除`)
    } catch {
      // api client already shows error toast
    } finally {
      setSubmitting(false)
      setConfirmDelete(null)
    }
  }

  const handleWsKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreateWorkspace()
    }
  }

  const handleSessKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreateSession()
    }
  }

  const inputClass = "w-full px-3 py-2 rounded-lg text-sm focus:outline-none transition-all"
  const inputStyle: React.CSSProperties = {
    background: '#1e293b',
    border: '1px solid #334155',
    color: '#e2e8f0',
  }

  if (sidebarCollapsed) {
    return (
      <div
        className="h-full flex flex-col items-center relative"
        style={{ background: '#0a0a0f', fontFamily: FONT, color: '#e2e8f0', width: 40 }}
      >
        <button
          onClick={toggleSidebarCollapsed}
          className="flex items-center justify-center rounded-md transition-all mt-3"
          style={{ width: 24, height: 24, color: '#64748b', fontSize: 14 }}
          title="展开侧边栏"
          onMouseEnter={(e) => { e.currentTarget.style.color = '#a78bfa'; e.currentTarget.style.background = 'rgba(167,139,250,0.1)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#64748b'; e.currentTarget.style.background = 'transparent' }}
        >
          ▶
        </button>

        <div className="flex-1 flex items-center justify-center">
          <div
            className="rounded-full"
            style={{ width: 6, height: 6, background: '#a78bfa', boxShadow: '0 0 8px #a78bfa, 0 0 16px rgba(167,139,250,0.3)' }}
          />
        </div>

        <button
          className="flex items-center justify-center rounded transition-all mb-3"
          style={{ width: 28, height: 28, border: '1px solid #334155', color: '#64748b', fontSize: 14 }}
          title="Settings"
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = '#a78bfa'
            e.currentTarget.style.color = '#a78bfa'
            e.currentTarget.style.background = 'rgba(167,139,250,0.1)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = '#334155'
            e.currentTarget.style.color = '#64748b'
            e.currentTarget.style.background = 'transparent'
          }}
        >
          ⚙
        </button>
      </div>
    )
  }

  return (
    <div
      className="h-full flex flex-col text-base relative"
      style={{ background: '#0a0a0f', fontFamily: FONT, color: '#e2e8f0' }}
    >
      {/* Header */}
      <div
        className="px-3.5 py-3 flex items-center justify-between"
        style={{ borderBottom: '1px solid #1e293b' }}
      >
        <div className="flex items-center gap-2.5">
          <div
            className="rounded-full"
            style={{ width: 8, height: 8, background: '#a78bfa', boxShadow: '0 0 10px #a78bfa, 0 0 20px rgba(167,139,250,0.3)' }}
          />
          <span
            className="font-bold text-base"
            style={{ background: 'linear-gradient(90deg, #a78bfa, #818cf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}
          >
            OmniTerm
          </span>
        </div>
        <button
          onClick={toggleSidebarCollapsed}
          className="flex items-center justify-center rounded-md transition-all"
          style={{ width: 24, height: 24, color: '#64748b', fontSize: 14 }}
          title="收起侧边栏"
          onMouseEnter={(e) => { e.currentTarget.style.color = '#a78bfa'; e.currentTarget.style.background = 'rgba(167,139,250,0.1)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#64748b'; e.currentTarget.style.background = 'transparent' }}
        >
          ◀
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-2.5 pt-4 pb-16">
        {/* Section label */}
        <div className="flex items-center justify-between px-1 mb-2.5">
          <div className="flex items-center gap-1.5">
            <span style={{ fontSize: 11, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 2, fontWeight: 600 }}>
              Workspaces
            </span>
            <span style={{ fontSize: 11, color: '#475569' }}>{workspaces.length}</span>
          </div>
          <button
            onClick={() => setCreateWsOpen(true)}
            className="flex items-center justify-center rounded transition-all"
            style={{ width: 22, height: 22, border: '1px solid #a78bfa', color: '#a78bfa', fontSize: 15, fontWeight: 500 }}
            title="New Workspace"
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(167,139,250,0.15)'
              e.currentTarget.style.boxShadow = '0 0 8px rgba(167,139,250,0.2)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
              e.currentTarget.style.boxShadow = 'none'
            }}
          >
            +
          </button>
        </div>

        {workspaces.length === 0 ? (
          <div className="px-2 py-3" style={{ fontSize: 12, color: '#64748b' }}>
            No workspaces. Click + to create one.
          </div>
        ) : (
          workspaces.map((ws) => {
            const isActive = activeWorkspaceId === ws.id
            return (
              <div key={ws.id} className="relative mb-2">
                {/* Left glow bar for active workspace */}
                {isActive && (
                  <div
                    className="absolute left-0 top-0 bottom-0 rounded-full"
                    style={{
                      width: 2,
                      background: '#a78bfa',
                      boxShadow: '0 0 8px rgba(167,139,250,0.5)',
                    }}
                  />
                )}

                {/* Workspace item */}
                <div
                  className="flex items-center justify-between cursor-pointer rounded-lg transition-all"
                  style={{
                    marginLeft: 8,
                    padding: '10px 14px',
                    background: isActive
                      ? 'linear-gradient(90deg, rgba(167,139,250,0.12), transparent)'
                      : 'transparent',
                    border: `1px solid ${isActive ? 'rgba(167,139,250,0.15)' : '#1e293b'}`,
                  }}
                  onClick={() => setActiveWorkspace(ws.id === activeWorkspaceId ? null : ws.id)}
                >
                  <div className="flex items-center gap-2">
                    <span style={{ color: isActive ? '#a78bfa' : '#475569', fontSize: 12 }}>▸</span>
                    <span style={{ color: isActive ? '#e2e8f0' : '#94a3b8', fontWeight: isActive ? 500 : 400, fontSize: 13 }}>
                      {ws.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span style={{ fontSize: 11, color: '#64748b' }}>{ws.root_path}</span>
                    <DeleteButton
                      onClick={(e) => {
                        e.stopPropagation()
                        setConfirmDelete({ type: 'workspace', id: ws.id, name: ws.name })
                      }}
                    />
                  </div>
                </div>

                {/* Sessions under active workspace */}
                {isActive && (
                  <div className="pl-6 pr-1 pt-2 pb-1" style={{ marginLeft: 8 }}>
                    <div className="flex items-center justify-between px-0.5 mb-2">
                      <span style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1.5 }}>
                        Sessions
                      </span>
                      <button
                        onClick={() => setCreateSessOpen(true)}
                        className="flex items-center justify-center rounded transition-all"
                        style={{ width: 22, height: 22, border: '1px solid #a78bfa', color: '#a78bfa', fontSize: 15, fontWeight: 500 }}
                        title="New Session"
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = 'rgba(167,139,250,0.15)'
                          e.currentTarget.style.boxShadow = '0 0 8px rgba(167,139,250,0.2)'
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = 'transparent'
                          e.currentTarget.style.boxShadow = 'none'
                        }}
                      >
                        +
                      </button>
                    </div>

                    {sessions.map((s) => {
                      const isSessionActive = activeSessionId === s.id
                      const statusLabel = s.hook_status || 'Running'
                      const isRunning = statusLabel === 'Running' || statusLabel === 'Decision'
                      return (
                        <div
                          key={s.id}
                          className="flex items-center gap-2.5 rounded-md cursor-pointer transition-all"
                          style={{
                            padding: '7px 10px',
                            marginBottom: 3,
                            background: isSessionActive ? 'rgba(167,139,250,0.08)' : 'transparent',
                            border: isSessionActive ? '1px solid rgba(167,139,250,0.1)' : '1px solid transparent',
                          }}
                          onClick={() => setActiveSession(s.id)}
                        >
                          <div
                            className="rounded-full flex-shrink-0"
                            style={{
                              width: 6,
                              height: 6,
                              background: isRunning ? '#4ade80' : '#475569',
                              boxShadow: isRunning ? '0 0 6px #4ade80' : 'none',
                            }}
                          />
                          <span
                            className="truncate flex-1"
                            style={{ fontSize: 13, color: isSessionActive ? '#e2e8f0' : '#94a3b8' }}
                          >
                            {s.name || s.tmux_session_name}
                          </span>
                          <DeleteButton
                            onClick={(e) => {
                              e.stopPropagation()
                              setConfirmDelete({
                                type: 'session',
                                id: s.id,
                                name: s.name || s.tmux_session_name || '未命名',
                              })
                            }}
                          />
                        </div>
                      )
                    })}

                    {sessions.length === 0 && (
                      <div className="px-2 py-1.5" style={{ fontSize: 12, color: '#64748b' }}>
                        No sessions
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Bottom status bar */}
      <div
        className="absolute bottom-0 left-0 right-0 px-3.5 py-3 flex items-center justify-between"
        style={{ borderTop: '1px solid #1e293b', background: '#0a0a0f' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="rounded-full sidebar-glow-green"
            style={{ width: 6, height: 6, background: '#4ade80' }}
          />
          <span style={{ fontSize: 12, color: '#64748b' }}>Connected</span>
          <span style={{ fontSize: 10, color: '#475569', marginLeft: 4 }}>v{APP_VERSION}</span>
        </div>
        <button
          className="flex items-center justify-center rounded transition-all"
          style={{ width: 26, height: 26, border: '1px solid #334155', color: '#64748b', fontSize: 14 }}
          title="Settings"
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = '#a78bfa'
            e.currentTarget.style.color = '#a78bfa'
            e.currentTarget.style.background = 'rgba(167,139,250,0.1)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = '#334155'
            e.currentTarget.style.color = '#64748b'
            e.currentTarget.style.background = 'transparent'
          }}
        >
          ⚙
        </button>
      </div>

      {/* ── Create Workspace Modal ── */}
      <Modal open={createWsOpen} onClose={() => { setCreateWsOpen(false); setWsName(''); setWsPath(homeDir) }} title="创建工作区">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              名称
            </label>
            <input
              type="text"
              value={wsName}
              onChange={(e) => setWsName(e.target.value)}
              onKeyDown={handleWsKeyDown}
              placeholder="my-project"
              autoFocus
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#a78bfa'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.2)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#334155'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              根路径
            </label>
            <input
              type="text"
              value={wsPath}
              onChange={(e) => setWsPath(e.target.value)}
              onKeyDown={handleWsKeyDown}
              placeholder={homeDir}
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = '#a78bfa'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.2)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#334155'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <ModalCancel onClick={() => { setCreateWsOpen(false); setWsName(''); setWsPath(homeDir) }}>
              取消
            </ModalCancel>
            <ModalPrimary onClick={handleCreateWorkspace} disabled={!wsName.trim() || submitting}>
              {submitting ? '创建中...' : '创建'}
            </ModalPrimary>
          </div>
        </div>
      </Modal>

      {/* ── Create Session Modal ── */}
      <Modal open={createSessOpen} onClose={() => { setCreateSessOpen(false); setSessName('') }} title="创建会话" maxWidth="max-w-sm">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: '#94a3b8' }}>
              会话名称 <span style={{ color: '#475569' }}>(可选)</span>
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
              onFocus={(e) => { e.currentTarget.style.borderColor = '#a78bfa'; e.currentTarget.style.boxShadow = '0 0 0 2px rgba(167,139,250,0.2)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = '#334155'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <ModalCancel onClick={() => { setCreateSessOpen(false); setSessName('') }}>
              取消
            </ModalCancel>
            <ModalPrimary onClick={handleCreateSession} disabled={submitting}>
              {submitting ? '创建中...' : '创建'}
            </ModalPrimary>
          </div>
        </div>
      </Modal>

      {/* ── Delete Confirmation Dialog ── */}
      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={confirmDelete?.type === 'workspace' ? handleDeleteWorkspace : handleDeleteSession}
        title={confirmDelete?.type === 'workspace' ? '删除工作区' : '删除会话'}
        message={
          confirmDelete?.type === 'workspace'
            ? `确定要删除工作区「${confirmDelete?.name}」吗？该操作不可恢复。`
            : `确定要删除会话「${confirmDelete?.name}」吗？对应的 tmux 会话也将被终止。`
        }
        confirmText="删除"
        destructive
        loading={submitting}
      />
    </div>
  )
}

function DeleteButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className="flex-shrink-0 flex items-center justify-center rounded transition-all sidebar-glow-red-hover"
      style={{ width: 20, height: 20, border: '1px solid #334155', color: '#64748b', fontSize: 11 }}
      title="删除"
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = '#ef4444'
        e.currentTarget.style.color = '#ef4444'
        e.currentTarget.style.background = 'rgba(239,68,68,0.1)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = '#334155'
        e.currentTarget.style.color = '#64748b'
        e.currentTarget.style.background = 'transparent'
      }}
    >
      ✕
    </button>
  )
}

function ModalCancel({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 text-sm rounded-lg transition-all"
      style={{ border: '1px solid #334155', color: '#94a3b8' }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(167,139,250,0.1)'
        e.currentTarget.style.borderColor = '#a78bfa'
        e.currentTarget.style.color = '#e2e8f0'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.borderColor = '#334155'
        e.currentTarget.style.color = '#94a3b8'
      }}
    >
      {children}
    </button>
  )
}

function ModalPrimary({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="px-4 py-2 text-sm rounded-lg text-white transition-all disabled:opacity-50"
      style={{ background: '#a78bfa' }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#8b5cf6' }}
      onMouseLeave={(e) => { e.currentTarget.style.background = '#a78bfa' }}
    >
      {children}
    </button>
  )
}
