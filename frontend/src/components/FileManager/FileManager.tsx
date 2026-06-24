import { useState, useEffect, useRef, useCallback, type KeyboardEvent, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'
import { useAppStore } from '../../stores/appStore'
import { useFileWatcher } from '../../hooks/useFileWatcher'
import { IconFolder, IconFile, IconLink, IconArrowUp, IconRefresh, IconUpload, IconPencil, IconTrash, IconFolderOpen, IconWarning, IconSearch, IconWorkbench } from './icons'
import { FileDrawer } from './FileDrawer'

type PathType = 'Dir' | 'File' | 'SymlinkDir' | 'SymlinkFile'

interface FileEntry {
  path_type: PathType
  name: string
  mtime: number
  size: number | null
}

type SortKey = 'name' | 'mtime' | 'size'

function formatSize(bytes: number | null): string {
  if (bytes === null) return '-'
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i]
}

function formatTime(ms: number): string {
  if (!ms) return '-'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function getParentPath(path: string): string {
  if (!path || path === '/') return ''
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '' : trimmed.slice(0, idx)
}

function filesEqual(a: FileEntry[], b: FileEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].mtime !== b[i].mtime || a[i].size !== b[i].size || a[i].path_type !== b[i].path_type) return false
  }
  return true
}

function FileIcon({ entry }: { entry: FileEntry }) {
  switch (entry.path_type) {
    case 'Dir':
    case 'SymlinkDir':
      return <IconFolder style={{ color: '#94a3b8', flexShrink: 0 }} />
    case 'SymlinkFile':
      return <IconLink style={{ color: '#94a3b8', flexShrink: 0 }} />
    case 'File':
      return <IconFile style={{ color: '#64748b', flexShrink: 0 }} />
  }
}

export function FileManager() {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const fileManagerCollapsed = useAppStore((s) => s.fileManagerCollapsed)
  const toggleFileManagerCollapsed = useAppStore((s) => s.toggleFileManagerCollapsed)
  const fmSessionStates = useAppStore((s) => s.fmSessionStates)
  const setFmSessionMode = useAppStore((s) => s.setFmSessionMode)
  const setFmManualPath = useAppStore((s) => s.setFmManualPath)
  const resetFmToFollowing = useAppStore((s) => s.resetFmToFollowing)
  const setFmDrawerPath = useAppStore((s) => s.setFmDrawerPath)
  const closeFmDrawer = useAppStore((s) => s.closeFmDrawer)

  // Current session's FM state (defaults to following)
  const fmState = activeSessionId
    ? (fmSessionStates[activeSessionId] ?? { mode: 'following' as const, manualPath: null, drawerPath: null, drawerMode: 'view' as const })
    : { mode: 'following' as const, manualPath: null, drawerPath: null, drawerMode: 'view' as const }

  // Drawer state from store (persists across session switches)
  const drawerFilePath = fmState.drawerPath

  // Drawer height (sessionStorage, shared across sessions)
  const [drawerHeight, setDrawerHeight] = useState(() => {
    const stored = sessionStorage.getItem('omniterm_drawer_height')
    return stored ? parseInt(stored) : 256
  })

  // SSE file watcher (replaces 3s polling)
  const { lastEvent: fileChangeEvent } = useFileWatcher({
    sessionId: activeSessionId,
    enabled: !!activeSessionId,
  })

  const [files, setFiles] = useState<FileEntry[]>([])
  const [cwd, setCwd] = useState('')  // absolute path from server
  const [isOutsideWorkspace, setIsOutsideWorkspace] = useState(false)

  // Per-session file list cache for instant display on session switch
  const fileCache = useRef<Map<string, { files: FileEntry[]; cwd: string; isOutsideWorkspace: boolean }>>(new Map())
  const [loading, setLoading] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDesc, setSortDesc] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editingName, setEditingName] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const searchWrapRef = useRef<HTMLDivElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [colWidths, setColWidths] = useState({ name: 300, mtime: 140, size: 100 })

  const fetchFiles = useCallback(async (path?: string, sort?: string, desc?: boolean, silent = false): Promise<string | undefined> => {
    if (!activeSessionId) { setFiles([]); return undefined }
    if (!silent) setLoading(true)
    try {
      const effectivePath = path ?? (fmState.mode === 'manual' && fmState.manualPath ? fmState.manualPath : '.')
      const data = await api.listFilesBySession(activeSessionId, effectivePath, sort ?? sortKey, desc ?? sortDesc)
      const newFiles = data.files ?? []
      setFiles((prev) => filesEqual(prev, newFiles) ? prev : newFiles)
      if (data.cwd) setCwd(data.cwd)
      setIsOutsideWorkspace(data.is_outside_workspace ?? false)
      // Update per-session cache on successful fetch
      if (data.cwd && activeSessionId) {
        fileCache.current.set(activeSessionId, { files: newFiles, cwd: data.cwd, isOutsideWorkspace: data.is_outside_workspace ?? false })
      }
      if (!silent) setSelected(new Set())
      return data.cwd
    } catch (err: any) {
      if (!silent) addToast('error', err.message || t('fm.loadFailed'))
      if (!silent) setFiles([])
      return undefined
    } finally {
      if (!silent) setLoading(false)
    }
  }, [activeSessionId, fmState.mode, fmState.manualPath, sortKey, sortDesc])

  // SSE-driven refresh: when a file change event arrives, silently refresh the file list
  useEffect(() => {
    if (!fileChangeEvent || !activeSessionId) return
    fetchFiles(undefined, undefined, undefined, true)
  }, [fileChangeEvent, activeSessionId])

  // Save drawer height to sessionStorage
  useEffect(() => {
    sessionStorage.setItem('omniterm_drawer_height', String(drawerHeight))
  }, [drawerHeight])

  // Manual mode: fetch once when manualPath changes
  useEffect(() => {
    if (!activeSessionId || fmState.mode !== 'manual' || !fmState.manualPath) return
    fetchFiles(fmState.manualPath)
  }, [activeSessionId, fmState.mode, fmState.manualPath, fetchFiles])

  // Following mode: fetch terminal CWD when switching back to following
  useEffect(() => {
    if (!activeSessionId || fmState.mode !== 'following') return
    fetchFiles('.')
  }, [activeSessionId, fmState.mode, fetchFiles])

  // Session switch: show cached files immediately, then fetch fresh data
  useEffect(() => {
    if (!activeSessionId) return
    // Show cached files instantly while fresh data loads
    const cached = fileCache.current.get(activeSessionId)
    if (cached) {
      setFiles(cached.files)
      setCwd(cached.cwd)
      setIsOutsideWorkspace(cached.isOutsideWorkspace)
    }
    // Always fetch fresh data (manual mode uses its own path, following uses '.')
    if (fmState.mode === 'manual' && fmState.manualPath) {
      fetchFiles(fmState.manualPath)
    } else {
      fetchFiles('.')
    }
  }, [activeSessionId])

  const resizingRef = useRef<{ col: string; startX: number; startW: number } | null>(null)

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const r = resizingRef.current
      if (!r) return
      const delta = e.clientX - r.startX
      const newW = Math.max(80, r.startW + delta)
      setColWidths((prev) => ({ ...prev, [r.col]: newW }))
    }
    const onMouseUp = () => { resizingRef.current = null }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const handleResizeStart = (col: string, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizingRef.current = { col, startX: e.clientX, startW: colWidths[col as keyof typeof colWidths] }
  }

  const navigateTo = (absolutePath: string) => {
    if (!activeSessionId) return
    // Switch to manual mode with absolute path
    setFmSessionMode(activeSessionId, 'manual')
    setFmManualPath(activeSessionId, absolutePath)
  }

  const handleRowClick = (entry: FileEntry, _e: React.MouseEvent) => {
    if (editingName) return
    if (entry.path_type === 'Dir' || entry.path_type === 'SymlinkDir') {
      const newPath = cwd ? `${cwd}/${entry.name}` : entry.name
      navigateTo(newPath)
      return
    }
    const fullPath = cwd ? `${cwd}/${entry.name}` : entry.name
    // Open file in drawer (single click)
    if (activeSessionId) {
      setFmDrawerPath(activeSessionId, fullPath, 'view')
    }
    setSelected(new Set([fullPath]))
  }

  const handleSort = (key: SortKey) => {
    let newDesc: boolean
    if (key === sortKey) {
      newDesc = !sortDesc
    } else {
      newDesc = key === 'name' ? false : true
    }
    setSortKey(key)
    setSortDesc(newDesc)
    fetchFiles(undefined, key, newDesc)
  }

  // Close search on click outside
  useEffect(() => {
    if (!searchOpen) return
    const onClick = (e: MouseEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setSearchOpen(false)
        setSearchQuery('')
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [searchOpen])

  const toggleSearch = () => {
    if (searchOpen) {
      setSearchOpen(false)
      setSearchQuery('')
    } else {
      setSearchOpen(true)
      setTimeout(() => searchRef.current?.focus(), 0)
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (editingName) return
    // Don't intercept keys when an input/textarea has focus (search box, rename box, etc.)
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'Delete') {
      e.preventDefault()
      handleDelete()
    } else if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      if (selected.size === 1) {
        const path = Array.from(selected)[0]
        const name = path.split('/').pop() || ''
        setEditingName(path)
        setEditValue(name)
      }
    } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      setSelected(new Set(files.map((f) => cwd ? `${cwd}/${f.name}` : f.name)))
    }
  }

  const handleDragOver = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }
  const handleDragLeave = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false) }

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const droppedFiles = e.dataTransfer?.files
    if (!droppedFiles?.length || !activeSessionId) return
    for (let i = 0; i < droppedFiles.length; i++) {
      const file = droppedFiles[i]
      try {
        await api.uploadFileBySession(activeSessionId, cwd, file)
      } catch (err: any) {
        addToast('error', t('fm.uploadFileFailed', { name: file.name, msg: err.message }))
      }
    }
    addToast('success', t('fm.uploadComplete'))
    fetchFiles()
  }

  const startRename = () => {
    if (selected.size !== 1) return
    const path = Array.from(selected)[0]
    const name = path.split('/').pop() || ''
    setEditingName(path)
    setEditValue(name)
  }

  const commitRename = async () => {
    if (!editingName || !editValue.trim() || !activeSessionId) { setEditingName(null); return }
    try {
      await api.renameBySession(activeSessionId, editingName, editValue.trim())
      addToast('success', t('fm.renameSuccess'))
      fetchFiles()
    } catch (err: any) {
      addToast('error', err.message || t('fm.renameFailed'))
    }
    setEditingName(null)
  }

  const handleDelete = async () => {
    if (selected.size === 0 || !activeSessionId) return
    if (!confirm(t('fm.confirmDelete', { count: selected.size }))) return
    try {
      for (const path of selected) {
        await api.deleteFileBySession(activeSessionId, path)
      }
      addToast('success', t('fm.deleted', { count: selected.size }))
      fetchFiles()
    } catch (err: any) {
      addToast('error', err.message || t('fm.deleteFailed'))
    }
  }

  const handleUpload = () => {
    if (!activeSessionId) return
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = async () => {
      if (!input.files?.length) return
      for (let i = 0; i < input.files.length; i++) {
        try {
          await api.uploadFileBySession(activeSessionId, cwd, input.files[i])
        } catch (err: any) {
          addToast('error', t('fm.uploadFileFailed', { name: input.files[i].name, msg: err.message }))
        }
      }
      addToast('success', t('fm.uploadComplete'))
      fetchFiles()
    }
    input.click()
  }

  const handleSearch = async () => {
    if (!searchQuery.trim() || !activeSessionId) { fetchFiles(); return }
    setLoading(true)
    try {
      const results = await api.searchFilesBySession(activeSessionId, searchQuery, cwd)
      setFiles(results)
    } catch (err: any) {
      addToast('error', err.message || t('fm.searchFailed'))
    } finally {
      setLoading(false)
    }
  }

  const SI = ({ col }: { col: SortKey }) =>
    sortKey === col ? (
      <span style={{ marginLeft: 4, fontSize: 10, color: '#a78bfa', userSelect: 'none' }}>
        {sortDesc ? '▼' : '▲'}
      </span>
    ) : null

  if (fileManagerCollapsed) {
    return (
      <div
        className="h-full flex flex-col items-center relative"
        style={{ background: '#0a0a0f', fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace", width: 40 }}
      >
        <button
          onClick={toggleFileManagerCollapsed}
          className="flex items-center justify-center rounded-md transition-all mt-3"
          style={{ width: 24, height: 24, color: '#64748b', fontSize: 14 }}
          title={t('fm.expand')}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#a78bfa'; e.currentTarget.style.background = 'rgba(167,139,250,0.1)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#64748b'; e.currentTarget.style.background = 'transparent' }}
        >
          ◀
        </button>

        <div className="flex-1 flex items-center justify-center">
          <IconFolderOpen width={18} height={18} style={{ color: '#475569' }} />
        </div>

        <button
          onClick={toggleFileManagerCollapsed}
          className="flex items-center justify-center rounded-md transition-all mb-3"
          style={{ width: 24, height: 24, color: '#64748b', fontSize: 14 }}
          title={t('fm.expand')}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#a78bfa'; e.currentTarget.style.background = 'rgba(167,139,250,0.1)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#64748b'; e.currentTarget.style.background = 'transparent' }}
        >
          ◀
        </button>
      </div>
    )
  }

  return (
    <div
      className="omnifm-root"
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="fm-toolbar">
        <div className="fm-toolbar-left">
          <button
            onClick={toggleFileManagerCollapsed}
            className="flex items-center justify-center rounded-md transition-all"
            style={{ width: 24, height: 24, color: '#64748b', fontSize: 14 }}
            title={t('fm.collapse')}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#a78bfa'; e.currentTarget.style.background = 'rgba(167,139,250,0.1)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#64748b'; e.currentTarget.style.background = 'transparent' }}
          >
            ▶
          </button>
          {activeSessionId && (
            <button
              className="fm-bc-root"
              onClick={() => resetFmToFollowing(activeSessionId)}
              title={t('fm.backToTerminalDir')}
            >
              <IconWorkbench width={13} height={13} />
            </button>
          )}
        </div>
        <div className="fm-toolbar-right">
          <div className="fm-search-wrap" ref={searchWrapRef}>
            <button className="fm-btn" onClick={toggleSearch} title={t('fm.search')}>
              <IconSearch />
            </button>
            {searchOpen && (
              <input
                className="fm-search"
                placeholder={t('fm.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSearch()
                  if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery('') }
                }}
                ref={searchRef}
                autoFocus
              />
            )}
          </div>

          <button
            className="fm-btn"
            onClick={() => {
              const parentPath = getParentPath(cwd)
              if (parentPath) navigateTo(parentPath)
            }}
            disabled={!cwd}
            title={t('fm.backToParent')}
          >
            <IconArrowUp />
          </button>
          <button className="fm-btn" onClick={() => fetchFiles()} title={t('fm.refresh')}>
            <IconRefresh />
          </button>
          <button className="fm-btn" onClick={handleUpload} title={t('fm.upload')}>
            <IconUpload />
          </button>
        </div>
      </div>

      {cwd && (
        <div className="fm-breadcrumb">
<
          {cwd.split('/').filter(Boolean).map((seg, i, arr) => {
            const segPath = '/' + arr.slice(0, i + 1).join('/')
            return (
              <span key={segPath}>
                <span className="fm-bc-sep">/</span>
                <span className="fm-bc-seg" onClick={() => navigateTo(segPath)}>{seg}</span>
              </span>
            )
          })}
          {isOutsideWorkspace && (
            <span
              className="fm-warning-icon"
              title={t('fm.outOfWorkspace')}
              style={{ marginLeft: 6, color: '#f59e0b', cursor: 'help' }}
            >
              <IconWarning width={14} height={14} />
            </span>
          )}
        </div>
      )}

      <div
        className={`fm-table-wrap ${dragOver ? 'fm-drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {!activeSessionId ? (
          <div className="fm-empty">
            <span className="fm-empty-icon"><IconFolderOpen width={32} height={32} style={{ color: '#a78bfa', filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.4))' }} /></span>
            <span>{t('fm.selectSessionFirst')}</span>
          </div>
        ) : loading ? (
          <div className="fm-empty">{t('fm.loading')}</div>
        ) : files.length === 0 ? (
          <div className="fm-empty">
            <span className="fm-empty-icon"><IconFolderOpen width={32} height={32} style={{ color: '#a78bfa', filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.4))' }} /></span>
            <span>{t('fm.emptyDir')}</span>
            <span className="fm-empty-hint">{t('fm.dragHint')}</span>
          </div>
        ) : (
          <div style={{ flex: '1 1 0', minHeight: 0, overflow: 'auto' }}>
            <table className="fm-table">
              <colgroup>
                <col style={{ width: colWidths.name }} />
                <col style={{ width: colWidths.mtime }} />
                <col style={{ width: colWidths.size }} />
                <col style={{ width: 80 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <span className="fm-th-sort" onClick={() => handleSort('name')}>
                      {t('fm.name')} <SI col="name" />
                    </span>
                    <span className="fm-th-resize" onMouseDown={(e) => handleResizeStart('name', e)} />
                  </th>
                  <th>
                    <span className="fm-th-sort" onClick={() => handleSort('mtime')}>
                      {t('fm.lastModified')} <SI col="mtime" />
                    </span>
                    <span className="fm-th-resize" onMouseDown={(e) => handleResizeStart('mtime', e)} />
                  </th>
                  <th>
                    <span className="fm-th-sort" onClick={() => handleSort('size')}>
                      {t('fm.size')} <SI col="size" />
                    </span>
                    <span className="fm-th-resize" onMouseDown={(e) => handleResizeStart('size', e)} />
                  </th>
                  <th>{t('fm.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const fullPath = cwd ? `${cwd}/${f.name}` : f.name
                  const isDir = f.path_type === 'Dir' || f.path_type === 'SymlinkDir'
                  const isEditing = editingName === fullPath
                  const isSel = selected.has(fullPath)
                  return (
                    <tr
                      key={fullPath}
                      className={isSel ? 'fm-tr-selected' : ''}
                      onClick={(e) => handleRowClick(f, e)}
                      onDoubleClick={() => {
                        if (isDir) navigateTo(fullPath)
                      }}
                    >
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <FileIcon entry={f} />
                          {isEditing ? (
                            <input
                              className="fm-edit-input"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') commitRename()
                                if (e.key === 'Escape') setEditingName(null)
                              }}
                              onBlur={commitRename}
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
                            />
                          ) : (
                            <span>{f.name}</span>
                          )}
                        </div>
                      </td>
                      <td className="fm-td-time">{formatTime(f.mtime)}</td>
                      <td className="fm-td-size">{isDir ? `${f.size} ${t('fm.items')}` : formatSize(f.size)}</td>
                      <td className="fm-td-actions-cell">
                        <span
                          className="fm-act-icon"
                          title={t('fm.rename')}
                          onClick={(e) => { e.stopPropagation(); setSelected(new Set([fullPath])); startRename() }}
                        >
                          <IconPencil />
                        </span>
                        <span
                          className="fm-act-icon fm-act-icon-danger"
                          title={t('fm.delete')}
                          onClick={(e) => { e.stopPropagation(); setSelected(new Set([fullPath])); handleDelete() }}
                        >
                          <IconTrash />
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* File Drawer — slides up from bottom when a file is opened */}
      {drawerFilePath && activeSessionId && (
        <FileDrawer
          filePath={drawerFilePath}
          sessionId={activeSessionId}
          onClose={() => closeFmDrawer(activeSessionId)}
          height={drawerHeight}
          onHeightChange={setDrawerHeight}
          fileChangeEvent={fileChangeEvent}
        />
      )}
    </div>
  )
}
