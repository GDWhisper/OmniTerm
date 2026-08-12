import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, ApiError, type FileEntry } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useToastStore } from '../../stores/toastStore'
import { useDirBrowser } from '../../hooks/useDirBrowser'
import { getParentPath } from '../../utils/path'
import { READER_FONT } from '../../utils/fonts'
import { Modal } from '../Modal/Modal'
import { PixelButton } from '../PixelUI/PixelButton'
import { FolderSprite } from '../PixelUI'
import { IconFolder, IconFolderPlus, IconArrowUp, IconWarning } from '../FileManager/icons'
import { inputClass, inputStyle } from './sidebarModalStyles'

/**
 * Create-project modal with embedded directory browser, real-time path
 * autocomplete and the 409 cover-conflict sub-dialog. Holds all form and
 * browse state internally; the Sidebar only supplies the open flag, the
 * home directory (from its systemInfo effect) and a reload callback.
 *
 * Browse list state (entries/loading/error/notFound) comes from the shared
 * useDirBrowser hook — identical fetch/filter/404 semantics to the old
 * inline fetchDirs. The hook's reset() blanks the list and flags, keeping
 * the original open/close/empty-input clearing behavior.
 */
export function CreateProjectModal(props: {
  open: boolean
  homeDir: string
  onClose: () => void
  reloadProjects: () => Promise<void>
}) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  // Cover-conflict "Switch to existing" activates the covering project
  const setActiveProject = useAppStore((s) => s.setActiveProject)
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace)

  const open = props.open
  const homeDir = props.homeDir

  const [projName, setProjName] = useState('')
  const [projPath, setProjPath] = useState('')
  // Browse path is local: the hook owns the fetched list, not the path
  const [browsePath, setBrowsePath] = useState('')
  const { entries, loading, error, notFound, loadDirs, reset } = useDirBrowser()
  const [autocompleteActiveIndex, setAutocompleteActiveIndex] = useState(-1)
  const autocompleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 409 Conflict response data when creating a project whose path is
  // already covered by an existing project.
  const [coverConflict, setCoverConflict] = useState<{
    coveringProject: { id: string; name: string; path: string }
    reason: 'exact_path' | 'worktree_child'
  } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Real-time path autocomplete — debounced fetch on every keystroke.
  // Parses the input: "/home/pax/Om" → list "/home/pax/" and filter by "Om".
  useEffect(() => {
    const input = projPath.trim()
    if (!input || input === '/') {
      setBrowsePath('')
      reset()
      return
    }

    const lastSlash = input.lastIndexOf('/')
    const dirPart = lastSlash >= 0 ? input.slice(0, lastSlash + 1) : input
    const prefix = lastSlash >= 0 ? input.slice(lastSlash + 1) : ''

    if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current)
    autocompleteTimerRef.current = setTimeout(() => {
      setBrowsePath(dirPart)
      loadDirs(dirPart, prefix || undefined)
    }, 200)

    return () => {
      if (autocompleteTimerRef.current) clearTimeout(autocompleteTimerRef.current)
    }
  }, [projPath, loadDirs, reset])

  // Reset browse state when the create-project modal opens
  useEffect(() => {
    if (open && homeDir) {
      setBrowsePath(homeDir)
      setProjPath(homeDir + '/')
      reset()
    }
  }, [open, homeDir, reset])

  // Unified close: clear form + browse state
  const closeCreateProj = () => {
    props.onClose()
    setProjName('')
    // 置空而非 homeDir + '/'：让下次打开时 projPath 从 '' 变化到
    // homeDir + '/'，从而触发自动补全 effect 重新 loadDirs（否则第二次
    // 打开因 projPath 值未变化而不加载，浏览区残留「空目录」态）
    setProjPath('')
    setBrowsePath('')
    reset()
    setAutocompleteActiveIndex(-1)
  }

  const handleCreateProject = async () => {
    if (!projName.trim()) return
    setSubmitting(true)
    try {
      await api.createProject({ name: projName.trim(), path: projPath.trim() })
      await props.reloadProjects()
      addToast('success', t('sidebar.projectCreated', { name: projName.trim() }) ?? `Project "${projName.trim()}" created`)
      props.onClose()
      setProjName('')
      setProjPath('')
    } catch (e) {
      // 409 Conflict: the new path is already covered by an existing
      // project. Surface a switch-to-existing dialog instead of letting
      // the generic toast dismiss.
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as Record<string, unknown> | undefined
        if (body?.error === 'already_covered') {
          const coveringProject = body.covering_project as { id: string; name: string; path: string }
          const reason = body.reason as 'exact_path' | 'worktree_child'
          setCoverConflict({
            coveringProject,
            reason,
          })
          return
        }
      }
      // api client already shows error toast for other failures
    } finally {
      setSubmitting(false)
    }
  }

  // Enter in name field = create project
  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleCreateProject()
    }
  }

  // Path field keyboard navigation for autocomplete
  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setAutocompleteActiveIndex((prev) => {
        const next = prev + 1
        return next < entries.length ? next : prev
      })
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setAutocompleteActiveIndex((prev) => {
        const next = prev - 1
        return next >= 0 ? next : prev
      })
      return
    }
    if (e.key === 'Tab' && entries.length > 0) {
      e.preventDefault()
      completAutocomplete(
        autocompleteActiveIndex >= 0 ? autocompleteActiveIndex : 0,
      )
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (autocompleteActiveIndex >= 0) {
        completAutocomplete(autocompleteActiveIndex)
      }
    }
    if (e.key === 'Escape') {
      setAutocompleteActiveIndex(-1)
    }
  }

  // Complete the autocomplete suggestion at the given index
  const completAutocomplete = (index: number) => {
    const entry = entries[index]
    if (!entry) return
    const dirPart = browsePath.endsWith('/') ? browsePath : `${browsePath}/`
    setProjPath(`${dirPart}${entry.name}/`)
    setAutocompleteActiveIndex(-1)
  }

  // Browse handlers for the new-project modal
  const handleEnterDir = (entry: FileEntry) => {
    const dirPart = browsePath.endsWith('/') ? browsePath : `${browsePath}/`
    setProjPath(`${dirPart}${entry.name}/`)
  }

  const handleGoUp = () => {
    const parent = getParentPath(browsePath)
    if (!parent) return
    setProjPath(parent)
  }

  const handleRefresh = () => {
    if (browsePath) loadDirs(browsePath)
  }

  return (
    <>
      {/* ── Create Project Modal ── */}
      <Modal
        open={open}
        onClose={closeCreateProj}
        title={t('sidebar.createProject') ?? 'Create Project'}
        maxWidth="max-w-lg"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.projectName') ?? 'Project Name'}
            </label>
            <input
              type="text"
              value={projName}
              onChange={(e) => setProjName(e.target.value)}
              onKeyDown={handleNameKeyDown}
              placeholder="my-project"
              autoFocus
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.boxShadow = 'none' }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-muted)' }}>
              {t('sidebar.repoPath') ?? 'Git Repository Path'}
            </label>
            <input
              type="text"
              value={projPath}
              onChange={(e) => {
                setProjPath(e.target.value)
                setAutocompleteActiveIndex(-1)
              }}
              onKeyDown={handlePathKeyDown}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-strong)'
                e.currentTarget.style.boxShadow = 'none'
              }}
              placeholder={homeDir}
              className={inputClass}
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--accent-14)' }}
            />
          </div>
          <div>
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
                onClick={handleGoUp}
                className="flex items-center gap-2 px-2.5 py-1.5 text-xs transition-all"
                style={{
                  borderRadius: 4,
                  color: 'var(--text-faint)',
                  cursor: getParentPath(browsePath) ? 'pointer' : 'not-allowed',
                  opacity: getParentPath(browsePath) ? 1 : 0.5,
                }}
                onMouseEnter={(e) => {
                  if (!getParentPath(browsePath)) return
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
              {loading && (
                <div className="flex items-center justify-center py-6 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {t('sidebar.loading') ?? '加载中…'}
                </div>
              )}

              {/* Error state */}
              {!loading && !notFound && error && (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-xs">
                  <IconWarning width={20} height={20} style={{ color: 'var(--warning)' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{error}</div>
                  <button
                    onClick={handleRefresh}
                    className="px-2 py-0.5 rounded transition-all"
                    style={{ border: '1px solid var(--border-strong)', color: 'var(--text-secondary)', fontSize: 11 }}
                  >
                    {t('sidebar.retry') ?? '重试'}
                  </button>
                </div>
              )}

              {/* Path doesn't exist — will be auto-created on submit */}
              {!loading && notFound && (
                <div className="flex flex-col items-center justify-center gap-2 py-6 text-xs">
                  <IconFolderPlus width={20} height={20} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 6px var(--accent-14))' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{t('sidebar.pathWillBeCreated') ?? '该路径不存在，创建项目时将自动创建'}</div>
                </div>
              )}

              {/* Empty state */}
              {!loading && !notFound && !error && entries.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-1 py-6 text-xs">
                  <IconFolder width={24} height={24} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 6px var(--accent-14))' }} />
                  <div style={{ color: 'var(--text-muted)' }}>{t('sidebar.emptyDir') ?? '空目录'}</div>
                </div>
              )}

              {/* Directory entries */}
              {!loading && !notFound && !error && entries.map((entry, idx) => {
                const highlighted = idx === autocompleteActiveIndex
                return (
                <div
                  key={entry.name}
                  onClick={() => handleEnterDir(entry)}
                  className="flex items-center gap-2 px-2.5 py-1.5 text-xs transition-all"
                  style={{
                    borderRadius: 4,
                    color: highlighted ? 'var(--text-primary)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                    background: highlighted ? 'var(--accent-10)' : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    setAutocompleteActiveIndex(idx)
                    e.currentTarget.style.background = 'var(--accent-10)'
                  }}
                  onMouseLeave={(e) => {
                    if (!highlighted) {
                      e.currentTarget.style.background = 'transparent'
                    }
                  }}
                >
                  <FolderSprite size={14} />
                  <span className="truncate">{entry.name}</span>
                  <span className="ml-auto" style={{ color: 'var(--text-faint)', fontSize: 11 }}>{entry.size ?? 0}</span>
                </div>
                )
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <PixelButton variant="secondary" onClick={closeCreateProj}>
              {t('sidebar.cancel')}
            </PixelButton>
            <PixelButton variant="accent" onClick={handleCreateProject} disabled={!projName.trim() || submitting}>
              {submitting ? t('sidebar.creating') : t('sidebar.create')}
            </PixelButton>
          </div>
        </div>
      </Modal>

      {/* ── Cover-Conflict Modal: shown when POST /projects returns 409.
          Offers to switch to the existing project that already covers the
          requested path (instead of creating a duplicate). */}
      <Modal
        open={!!coverConflict}
        onClose={() => setCoverConflict(null)}
        title={t('sidebar.coverConflictTitle') ?? 'Project Already Exists'}
        maxWidth="max-w-md"
      >
        {coverConflict && (
          <div className="space-y-4">
            <p style={{ fontSize: 13, color: 'var(--text-primary)' }}>
              {coverConflict.reason === 'exact_path'
                ? (t('sidebar.coverConflictExact', { name: coverConflict.coveringProject.name }) ??
                  `A project named "${coverConflict.coveringProject.name}" already uses this exact path.`)
                : (t('sidebar.coverConflictWorktree', { name: coverConflict.coveringProject.name }) ??
                  `A project named "${coverConflict.coveringProject.name}" already covers this path — they belong to the same git repository.`)}
            </p>
            <div
              className="rounded-md px-3 py-2 truncate"
              style={{
                background: 'var(--bg-surface)',
                border: '1px solid var(--border-strong)',
                fontSize: 11,
                color: 'var(--text-muted)',
                fontFamily: READER_FONT,
              }}
              title={coverConflict.coveringProject.path}
            >
              {coverConflict.coveringProject.path}
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>
              {t('sidebar.coverConflictHint') ??
                'Switch to the existing project instead, or choose a different path.'}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <PixelButton variant="secondary" onClick={() => setCoverConflict(null)}>
                {t('sidebar.cancel') ?? 'Cancel'}
              </PixelButton>
              <PixelButton
                variant="accent"
                onClick={() => {
                  const coverId = coverConflict.coveringProject.id
                  setActiveProject(coverId)
                  setActiveWorkspace(null)
                  setCoverConflict(null)
                  props.onClose()
                  setProjName('')
                  setProjPath('')
                  addToast(
                    'success',
                    t('sidebar.coverConflictSwitched', { name: coverConflict.coveringProject.name }) ??
                      `Switched to project "${coverConflict.coveringProject.name}"`,
                  )
                }}
              >
                {t('sidebar.coverConflictSwitch') ?? 'Switch to existing'}
              </PixelButton>
            </div>
          </div>
        )}
      </Modal>
    </>
  )
}
