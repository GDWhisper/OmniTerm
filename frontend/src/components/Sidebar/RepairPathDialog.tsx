import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type FileEntry, type Project, type Workspace } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { useDirBrowser } from '../../hooks/useDirBrowser'
import { getParentPath } from '../../utils/path'
import { READER_FONT } from '../../utils/fonts'
import { Modal } from '../Modal/Modal'
import { PixelButton } from '../PixelUI/PixelButton'
import { FolderSprite } from '../PixelUI'
import { IconFolder, IconArrowUp, IconRefresh, IconWarning } from '../FileManager/icons'
import { inputClass, inputStyle } from './sidebarModalStyles'

export interface RepairTarget { project: Project; workspace?: Workspace | null; oldPath: string }

/**
 * Repair-project-path dialog: shown when the user clicks a workspace whose
 * path no longer exists on disk, letting them browse to the new location.
 * Holds all form/browse state internally; the Sidebar only supplies the
 * repair target (`target`, null = closed — merges the old repairDialogOpen
 * + repairProject pair) and a reload callback.
 *
 * Browse list state (entries/loading/error) comes from the shared
 * useDirBrowser hook — identical fetch/filter/404 semantics to the old
 * inline fetchRepairDirs; the hook's notFound flag is not read here, so a
 * 404 renders the plain empty-directory state exactly as before.
 */
export function RepairPathDialog(props: {
  target: RepairTarget | null          // null = 关闭；合并原 repairDialogOpen + repairProject
  onClose: () => void
  onRepaired: (projectId: string) => Promise<void>  // Sidebar: Promise.all([loadProjects, loadWorktrees, loadSessions])
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  // Activate the workspace after successful update
  const setActiveProject = useAppStore((s) => s.setActiveProject)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)
  const setActiveSession = useAppStore((s) => s.setActiveSession)

  const [repairPath, setRepairPath] = useState('')
  const [repairBrowsePath, setRepairBrowsePath] = useState('')
  const [repairSubmitting, setRepairSubmitting] = useState(false)
  const {
    entries: repairBrowseEntries,
    loading: repairBrowseLoading,
    error: repairBrowseError,
    loadDirs,
    reset,
  } = useDirBrowser()

  const repairProject = props.target

  // 打开初始化（原 openRepairDialog）；关闭（target → null）时清空路径状态
  // （原 closeRepairDialog），使再次打开同一项目时 browsePath 由 '' 变化，
  // 照常触发下方自动拉取 effect。entries/error 无需在关闭时清理：Modal
  // 关闭即卸载内容，且下次打开时 reset() 会先行清空。
  useEffect(() => {
    if (repairProject) {
      setRepairPath('')
      setRepairBrowsePath(repairProject.oldPath ? getParentPath(repairProject.oldPath) : '')
      reset()
    } else {
      setRepairPath('')
      setRepairBrowsePath('')
    }
  }, [repairProject, reset])

  // Auto-fetch when repairBrowsePath changes
  useEffect(() => {
    if (!repairBrowsePath) return
    loadDirs(repairBrowsePath)
  }, [repairBrowsePath, loadDirs])

  // Repair dialog browse handlers
  const handleRepairEnterDir = (entry: FileEntry) => {
    const newPath = repairBrowsePath.endsWith('/')
      ? `${repairBrowsePath}${entry.name}`
      : `${repairBrowsePath}/${entry.name}`
    setRepairPath(newPath)
    setRepairBrowsePath(newPath)
  }

  const handleRepairGoUp = () => {
    const parent = getParentPath(repairBrowsePath)
    if (!parent) return
    setRepairPath(parent)
    setRepairBrowsePath(parent)
  }

  const handleRepairPathApply = () => {
    const trimmed = repairPath.trim()
    if (!trimmed || trimmed === repairBrowsePath) return
    setRepairBrowsePath(trimmed)
  }

  const handleRepairRefresh = () => {
    if (repairBrowsePath) loadDirs(repairBrowsePath)
  }

  const handleRepairUpdate = async () => {
    if (!repairProject || !repairPath.trim()) return
    setRepairSubmitting(true)
    try {
      await api.updateProject(repairProject.project.id, { path: repairPath.trim() })
      addToast('success', t('sidebar.repairUpdated') ?? `Project path updated to "${repairPath.trim()}"`)
      // Refresh projects + worktrees + sessions so the UI reflects the new path
      await props.onRepaired(repairProject.project.id)
      // Activate the workspace after successful update (project-level repairs
      // have no workspace target — just activate the project).
      setActiveProject(repairProject.project.id)
      setActiveSession(null)
      if (repairProject.workspace) {
        setActiveWorkspace(repairProject.workspace.id)
      }
      props.onClose()
    } catch {
      // api client already shows error toast
    } finally {
      setRepairSubmitting(false)
    }
  }

  return (
    <Modal
      open={repairProject !== null}
      onClose={props.onClose}
      title={t('sidebar.repairTitle') ?? 'Project Path Not Found'}
      maxWidth="max-w-lg"
    >
      {repairProject && (
        <div className="space-y-4">
          <div
            className="rounded-md px-3 py-2"
            style={{
              background: 'var(--bg-surface)',
              border: '1px solid var(--danger-30)',
              fontSize: 12,
              color: 'var(--text-secondary)',
            }}
          >
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>
              {t('sidebar.repairOldPathLabel') ?? 'Original path (no longer exists)'}
            </div>
            <div
              className="truncate"
              style={{
                fontFamily: READER_FONT,
                fontSize: 11,
                color: 'var(--danger)',
              }}
            >
              {repairProject.project.path}
            </div>
          </div>

          <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>
            {t('sidebar.repairHint') ??
              'The project directory may have been moved or renamed. Browse to its new location below.'}
          </p>

          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.repairNewPathLabel') ?? 'New Path'}
            </label>
            <input
              type="text"
              value={repairPath}
              onChange={(e) => setRepairPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleRepairPathApply()
                }
              }}
              onBlur={(e) => {
                handleRepairPathApply()
                e.currentTarget.style.borderColor = 'var(--border-strong)'
                e.currentTarget.style.boxShadow = 'none'
              }}
              placeholder="/home/user/project"
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                {t('sidebar.repairBrowse') ?? 'Browse'}
              </label>
              <button
                onClick={handleRepairRefresh}
                title={t('sidebar.refresh') ?? 'Refresh'}
                className="flex items-center gap-1 px-2 py-0.5 rounded transition-all"
                style={{
                  borderWidth: '1px',
                  borderStyle: 'solid',
                  borderColor: 'var(--border-strong)',
                  color: 'var(--text-secondary)',
                  fontSize: 11,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent)'
                  e.currentTarget.style.color = 'var(--accent)'
                  e.currentTarget.style.background = 'var(--accent-10)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border-strong)'
                  e.currentTarget.style.color = 'var(--text-secondary)'
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <IconRefresh width={10} height={10} />
                {t('sidebar.refresh') ?? 'Refresh'}
              </button>
            </div>
            <div
              className="overflow-y-auto overlay-scroll-content"
              style={{
                height: 200,
                background: 'var(--bg-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 5,
                padding: 4,
              }}
            >
              {/* ".." parent entry */}
              <div
                onClick={handleRepairGoUp}
                className="flex items-center gap-2 px-2.5 py-1.5 text-xs transition-all"
                style={{
                  borderRadius: 4,
                  color: 'var(--text-faint)',
                  cursor: getParentPath(repairBrowsePath) ? 'pointer' : 'not-allowed',
                  opacity: getParentPath(repairBrowsePath) ? 1 : 0.5,
                }}
                onMouseEnter={(e) => {
                  if (!getParentPath(repairBrowsePath)) return
                  e.currentTarget.style.background = 'var(--accent-10)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                <IconArrowUp width={14} height={14} />
                <span>..</span>
              </div>

              {/* Loading state */}
              {repairBrowseLoading && (
                <div className="flex items-center justify-center py-6 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {t('sidebar.loading') ?? 'Loading…'}
                </div>
              )}

              {/* Error state */}
              {!repairBrowseLoading && repairBrowseError && (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-xs">
                  <IconWarning width={20} height={20} style={{ color: 'var(--warning)' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{repairBrowseError}</div>
                  <button
                    onClick={handleRepairRefresh}
                    className="px-2 py-0.5 rounded transition-all"
                    style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', fontSize: 11 }}
                  >
                    {t('sidebar.retry') ?? 'Retry'}
                  </button>
                </div>
              )}

              {/* Empty state */}
              {!repairBrowseLoading && !repairBrowseError && repairBrowseEntries.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-1 py-6 text-xs">
                  <IconFolder width={24} height={24} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 6px var(--accent-14))' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{t('sidebar.emptyDir') ?? 'Empty directory'}</div>
                </div>
              )}

              {/* Directory entries */}
              {!repairBrowseLoading && !repairBrowseError && repairBrowseEntries.map((entry) => (
                <div
                  key={entry.name}
                  onClick={() => handleRepairEnterDir(entry)}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs transition-all"
                  style={{
                    borderRadius: 4,
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--accent-10)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent'
                  }}
                >
                  <FolderSprite size={14} />
                  <span className="truncate">{entry.name}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <PixelButton variant="secondary" onClick={props.onClose}>
              {t('sidebar.cancel') ?? 'Cancel'}
            </PixelButton>
            <PixelButton variant="accent" onClick={handleRepairUpdate} disabled={!repairPath.trim() || repairSubmitting}>
              {repairSubmitting ? t('sidebar.repairUpdating') ?? 'Updating…' : t('sidebar.repairUpdate') ?? 'Update Path'}
            </PixelButton>
          </div>
        </div>
      )}
    </Modal>
  )
}
