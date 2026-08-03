import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type ExternalSession } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { READER_FONT } from '../../utils/fonts'

/**
 * External Sessions section — tmux sessions not yet adopted into any
 * project. Self-contained: owns the 10s polling loop and its list/adopt
 * UI state, and renders nothing while there are no external sessions
 * (the original JSX was conditionally rendered on
 * `externalSessions.length > 0`). The Sidebar only supplies
 * `reloadSessions` (its `loadSessions`) to refresh the adopted
 * project's session list after a successful adopt.
 */
export function ExternalSessionsSection(props: {
  reloadSessions: (projectId?: string) => Promise<void>  // Sidebar 侧 loadSessions
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const projects = useAppStore((s) => s.projects)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const activeExternalSession = useAppStore((s) => s.activeExternalSession)
  const setActiveSession = useAppStore((s) => s.setActiveSession)
  const setActiveExternalSession = useAppStore((s) => s.setActiveExternalSession)

  // External tmux sessions (not yet adopted into any project)
  const [externalSessions, setExternalSessions] = useState<ExternalSession[]>([])
  const [externalExpanded, setExternalExpanded] = useState(false)
  const [adoptTarget, setAdoptTarget] = useState<{ tmux_name: string } | null>(null)
  const [adoptProjectId, setAdoptProjectId] = useState('')

  // ── External sessions polling (every 10s) ──
  useEffect(() => {
    const fetchExternal = () => {
      api.listExternalSessions()
        .then(data => setExternalSessions(data.sessions))
        .catch(() => {})
    }
    fetchExternal()
    const interval = setInterval(fetchExternal, 10_000)
    return () => clearInterval(interval)
  }, [])

  // External Sessions — tmux sessions not yet adopted into any project
  if (externalSessions.length === 0) return null

  return (
    <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
      <div
        className="flex items-center justify-between px-1 mb-1.5 cursor-pointer rounded transition-all"
        onClick={() => setExternalExpanded(!externalExpanded)}
      >
        <div className="flex items-center gap-1.5">
          <span
            style={{
              fontSize: 12,
              color: externalExpanded ? 'var(--accent)' : 'var(--text-dim)',
              transition: 'transform 0.15s',
              display: 'inline-block',
              transform: externalExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >▸</span>
          <span style={{ fontSize: 11, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 2, fontWeight: 600 }}>
            {t('sidebar.externalSessions') ?? 'External Sessions'}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{externalSessions.length}</span>
        </div>
      </div>

      {externalExpanded && (
        <div className="pl-4 pr-1">
          {externalSessions.map((s) => (
            <div
              key={s.name}
              className="flex items-center gap-2 rounded-md transition-all mb-1 cursor-pointer"
              style={{
                padding: '5px 8px',
                background: activeExternalSession === s.name ? 'var(--accent-10)' : 'transparent',
                border: activeExternalSession === s.name ? '1px solid var(--accent-14)' : '1px solid transparent',
              }}
              onClick={() => {
                setActiveSession(null)
                setActiveExternalSession(activeExternalSession === s.name ? null : s.name)
              }}
              onMouseEnter={(e) => {
                if (activeExternalSession === s.name) return
                e.currentTarget.style.background = 'var(--accent-10)'
              }}
              onMouseLeave={(e) => {
                if (activeExternalSession === s.name) return
                e.currentTarget.style.background = 'transparent'
              }}
            >
              {/* Activity dot */}
              <div
                className="rounded-full flex-shrink-0"
                style={{
                  width: 5,
                  height: 5,
                  background: s.attached ? 'var(--success)' : 'var(--text-dim)',
                }}
              />
              <div className="flex-1 min-w-0">
                <span className="block truncate" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  {s.name}
                </span>
                {s.cwd && (
                  <span className="block truncate" style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 1 }}>
                    {s.cwd}
                  </span>
                )}
                <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                  {s.windows} {s.windows === 1 ? 'window' : 'windows'}
                </span>
              </div>

              {adoptTarget?.tmux_name === s.name ? (
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <select
                    value={adoptProjectId}
                    onChange={(e) => setAdoptProjectId(e.target.value)}
                    style={{
                      background: 'var(--bg-surface)',
                      border: '1px solid var(--border-strong)',
                      color: 'var(--text-primary)',
                      fontSize: 11,
                      borderRadius: 4,
                      padding: '2px 4px',
                      maxWidth: 100,
                      fontFamily: READER_FONT,
                    }}
                  >
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => {
                      if (!adoptTarget || !adoptProjectId) return
                      const name = adoptTarget.tmux_name
                      api.adoptSession(name, adoptProjectId).then(() => {
                        setExternalSessions(prev => prev.filter(s => s.name !== name))
                        props.reloadSessions(adoptProjectId)
                        addToast('success', t('sidebar.adoptSuccess', { name }) ?? `Session "${name}" adopted`)
                      }).catch((e: unknown) => {
                        const msg = e instanceof Error ? e.message : String(e)
                        addToast('error', t('sidebar.adoptFailed', { msg }) ?? `Failed to adopt session: ${msg}`)
                      }).finally(() => {
                        setAdoptTarget(null)
                        setAdoptProjectId('')
                      })
                    }}
                    disabled={!adoptProjectId}
                    className="flex items-center justify-center pixel-press transition-all"
                    style={{
                      padding: '2px 6px',
                      border: '1px solid var(--accent)',
                      color: 'var(--accent)',
                      fontSize: 11,
                      fontWeight: 500,
                      opacity: adoptProjectId ? 1 : 0.5,
                    }}
                    onMouseEnter={(e) => {
                      if (!adoptProjectId) return
                      e.currentTarget.style.background = 'var(--accent-14)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                  >
                    ✓
                  </button>
                  <button
                    onClick={() => { setAdoptTarget(null); setAdoptProjectId('') }}
                    className="flex items-center justify-center transition-all"
                    style={{ width: 18, height: 18, border: '1px solid var(--border-strong)', color: 'var(--text-faint)', fontSize: 10 }}
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setAdoptTarget({ tmux_name: s.name })
                    setAdoptProjectId(activeProjectId || projects[0]?.id || '')
                  }}
                  className="flex-shrink-0 flex items-center justify-center pixel-press transition-all"
                  style={{
                    padding: '2px 8px',
                    border: '1px solid var(--accent)',
                    color: 'var(--accent)',
                    fontSize: 11,
                    fontWeight: 500,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--accent-14)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  {t('sidebar.adopt') ?? 'Adopt'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
