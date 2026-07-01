import { getParentPath } from '../../utils/path'
import { useState, useEffect, useRef, useCallback, useMemo, type KeyboardEvent, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'
import { useAppStore } from '../../stores/appStore'
import { useFileWatcher } from '../../hooks/useFileWatcher'
import { IconFolder, IconFile, IconLink, IconArrowUp, IconRefresh, IconUpload, IconDownload, IconFolderPlus, IconFilePlus, IconCopy, IconPencil, IconTrash, IconFolderOpen, IconWarning, IconSearch, IconWorkbench } from './icons'
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
      return <IconFolder style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
    case 'SymlinkFile':
      return <IconLink style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
    case 'File':
      return <IconFile style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
  }
}

export function FileManager() {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const fileManagerCollapsed = useAppStore((s) => s.fileManagerCollapsed)
  const toggleFileManagerCollapsed = useAppStore((s) => s.toggleFileManagerCollapsed)
  const fmSessionStates = useAppStore((s) => s.fmSessionStates)
  const setFmSessionMode = useAppStore((s) => s.setFmSessionMode)
  const setFmManualPath = useAppStore((s) => s.setFmManualPath)
  const resetFmToFollowing = useAppStore((s) => s.resetFmToFollowing)
  const setFmDrawerPath = useAppStore((s) => s.setFmDrawerPath)
  const closeFmDrawer = useAppStore((s) => s.closeFmDrawer)

  // Workspace drawer state (local since fmSessionStates is session-keyed)
  const [workspaceDrawerPath, setWorkspaceDrawerPath] = useState<string | null>(null)

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
  // Download mode: button toggles a selection mode; checkboxes are inactive until activated
  const [downloadMode, setDownloadMode] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  // Create (folder/file) inline input
  const [createOpen, setCreateOpen] = useState<null | 'folder' | 'file'>(null)
  const [createName, setCreateName] = useState('')
  const createInputRef = useRef<HTMLInputElement>(null)
  const createAreaRef = useRef<HTMLDivElement>(null)
  const bcRef = useRef<HTMLDivElement>(null)
  const [bcOverflow, setBcOverflow] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [colWidths, setColWidths] = useState({ name: 300, mtime: 140, size: 100 })
  // Per-column <col> DOM refs — updated directly on mousemove for 60fps drag,
  // bypassing React re-render (FileManager is a large component; re-rendering
  // the whole file list on every mousemove is the cause of drag lag).
  const colRefs = useRef<Record<'name' | 'mtime' | 'size', HTMLTableColElement | null>>({
    name: null,
    mtime: null,
    size: null,
  })

  // Data source: session > workspace > null
  type FmSource = { type: 'session'; id: string } | { type: 'workspace'; id: string }
  const fmSource: FmSource | null = useMemo(() => {
    if (activeSessionId) return { type: 'session', id: activeSessionId }
    if (activeWorkspaceId) return { type: 'workspace', id: activeWorkspaceId }
    return null
  }, [activeSessionId, activeWorkspaceId])
  const sourceKey = useMemo(() => fmSource ? `${fmSource.type}:${fmSource.id}` : null, [fmSource])

  const fetchFiles = useCallback(async (path?: string, sort?: string, desc?: boolean, silent = false): Promise<string | undefined> => {
    if (!fmSource) { setFiles([]); return undefined }
    if (!silent) setLoading(true)
    try {
      // In workspace mode, always manual (no terminal to follow)
      const effectiveMode = fmSource.type === 'workspace' ? 'manual' : fmState.mode
      const effectivePath = path ?? (effectiveMode === 'manual' && fmState.manualPath ? fmState.manualPath : '.')
      const data = await api.listFiles2({
        session: fmSource.type === 'session' ? fmSource.id : undefined,
        workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
        projectId: activeProjectId ?? undefined,
        path: effectivePath,
        sort: sort ?? sortKeyRef.current,
        desc: desc ?? sortDescRef.current,
      })
      const newFiles = data.files ?? []
      setFiles((prev) => filesEqual(prev, newFiles) ? prev : newFiles)
      if (data.cwd) setCwd(data.cwd)
      setIsOutsideWorkspace(data.is_outside_workspace ?? false)
      if (data.cwd) {
        fileCache.current.set(sourceKey!, { files: newFiles, cwd: data.cwd, isOutsideWorkspace: data.is_outside_workspace ?? false })
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
  }, [fmSource, fmState.mode, fmState.manualPath, activeProjectId])

  // Stable refs to decouple sort state from fetchFiles identity,
  // preventing effect re-trigger on every sort change.
  const sortKeyRef = useRef(sortKey)
  sortKeyRef.current = sortKey
  const sortDescRef = useRef(sortDesc)
  sortDescRef.current = sortDesc
  const fetchFilesRef = useRef(fetchFiles)
  fetchFilesRef.current = fetchFiles

  // SSE-driven refresh: when a file change event arrives, silently refresh the file list
  useEffect(() => {
    if (!fileChangeEvent || !activeSessionId) return
    fetchFiles(undefined, undefined, undefined, true)
  }, [fileChangeEvent, activeSessionId])

  // Save drawer height to sessionStorage
  useEffect(() => {
    sessionStorage.setItem('omniterm_drawer_height', String(drawerHeight))
  }, [drawerHeight])

  // ── Primary fetch effect: triggers on source/mode/path change ──
  // Replaces 3 previously-separate effects (manual mode, following mode, source switch)
  // that redundantly overlapped on session switch, causing duplicate requests.
  useEffect(() => {
    if (!fmSource) { setFiles([]); setCwd(''); return }
    const cached = fileCache.current.get(sourceKey!)
    if (cached) {
      setFiles(cached.files)
      setCwd(cached.cwd)
      setIsOutsideWorkspace(cached.isOutsideWorkspace)
    }
    if (fmSource.type === 'workspace') {
      fetchFilesRef.current('.')
    } else if (fmState.mode === 'manual' && fmState.manualPath) {
      fetchFilesRef.current(fmState.manualPath)
    } else {
      fetchFilesRef.current('.')
    }
  }, [sourceKey, fmState.mode, fmState.manualPath])

  const resizingRef = useRef<{ col: string; startX: number; startW: number } | null>(null)

  useEffect(() => {
    const onMove = (e: MouseEvent | TouchEvent) => {
      const r = resizingRef.current
      if (!r) return
      e.preventDefault()
      const mvX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const delta = mvX - r.startX
      const newW = Math.max(80, r.startW + delta)
      // Direct DOM write — avoid React re-render on every mousemove
      const colEl = colRefs.current[r.col as 'name' | 'mtime' | 'size']
      if (colEl) colEl.style.width = `${newW}px`
    }
    const onUp = () => {
      const r = resizingRef.current
      if (!r) return
      // Sync final width to React state — one re-render after drag ends,
      // so sort/file-switch/dir-nav etc. reflect the user's final width.
      // Use the column's *actual* rendered width to stay consistent with the
      // handle positioning.
      const colEl = colRefs.current[r.col as 'name' | 'mtime' | 'size']
      const finalW = colEl ? colEl.getBoundingClientRect().width : NaN
      if (!isNaN(finalW)) {
        setColWidths((prev) => ({ ...prev, [r.col]: finalW }))
      }
      resizingRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
    }
  }, [])

  const handleResizeStart = (col: string, e: React.MouseEvent | React.TouchEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    // Read the column's *actual* rendered width, not React state — keeps the
    // handle 1:1 with the cursor when the user starts dragging.
    const colEl = colRefs.current[col as 'name' | 'mtime' | 'size']
    const actualW = colEl ? colEl.getBoundingClientRect().width : 0
    resizingRef.current = { col, startX: clientX, startW: actualW }
  }

  const navigateTo = (absolutePath: string) => {
    if (!fmSource) return
    // Directory change exits download selection mode (stale paths)
    setDownloadMode(false)
    setChecked(new Set())
    if (fmSource.type === 'session') {
      // Switch to manual mode with absolute path
      setFmSessionMode(fmSource.id, 'manual')
      setFmManualPath(fmSource.id, absolutePath)
    } else {
      // Workspace mode: directly set path, no session mode to track
      // Use a pseudo-session approach: we need to store the manual path somewhere
      // The fetchFiles logic already treats workspace as always-manual
      // Just fetch the target path directly
      fetchFiles(absolutePath)
    }
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
    } else if (activeWorkspaceId) {
      setWorkspaceDrawerPath(fullPath)
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
  // Breadcrumb overflow detection — toggle RTL direction for left-side truncation
  useEffect(() => {
    const el = bcRef.current
    if (!el) return
    const check = () => setBcOverflow(el.scrollWidth > el.clientWidth)
    const ro = new ResizeObserver(check)
    ro.observe(el)
    check()
    return () => ro.disconnect()
  }, [cwd])

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

  // Close create input on click outside (both folder & file buttons share a single area)
  useEffect(() => {
    if (!createOpen) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (createAreaRef.current && createAreaRef.current.contains(target)) return
      closeCreate()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [createOpen])

  // Reset transient UI state when source changes
  useEffect(() => {
    setDownloadMode(false)
    setChecked(new Set())
    setCreateOpen(null)
    setCreateName('')
    setSearchOpen(false)
    setSearchQuery('')
  }, [sourceKey])

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
    // Don't intercept keys when focus is in an input/textarea or any contenteditable
    // subtree (CodeMirror editor .cm-content, etc.). Otherwise Ctrl+A / r / Delete
    // would leak from the editor into the file list shortcuts below.
    const target = e.target as HTMLElement
    if (target.isContentEditable) return
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'Escape') {
      if (searchOpen) { setSearchOpen(false); setSearchQuery(''); return }
      if (createOpen) { closeCreate(); return }
      if (downloadMode) { exitDownloadMode(); return }
    } else if (e.key === 'Delete') {
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
    if (!droppedFiles?.length || !fmSource) return
    for (let i = 0; i < droppedFiles.length; i++) {
      const file = droppedFiles[i]
      try {
        await api.uploadFile2({
          session: fmSource.type === 'session' ? fmSource.id : undefined,
          workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
          projectId: activeProjectId ?? undefined,
          path: cwd,
          file,
        })
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
    if (!editingName || !editValue.trim() || !fmSource) { setEditingName(null); return }
    try {
      await api.rename2({
        session: fmSource.type === 'session' ? fmSource.id : undefined,
        workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
        projectId: activeProjectId ?? undefined,
        path: editingName,
        newName: editValue.trim(),
      })
      addToast('success', t('fm.renameSuccess'))
      fetchFiles()
    } catch (err: any) {
      addToast('error', err.message || t('fm.renameFailed'))
    }
    setEditingName(null)
  }

  const handleDelete = async () => {
    if (selected.size === 0 || !fmSource) return
    if (!confirm(t('fm.confirmDelete', { count: selected.size }))) return
    try {
      for (const p of selected) {
        await api.deleteFile2({
          session: fmSource.type === 'session' ? fmSource.id : undefined,
          workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
          projectId: activeProjectId ?? undefined,
          path: p,
        })
      }
      addToast('success', t('fm.deleted', { count: selected.size }))
      fetchFiles()
    } catch (err: any) {
      addToast('error', err.message || t('fm.deleteFailed'))
    }
  }

  const handleCopyPath = async (fullPath: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(fullPath)
      } else {
        // Fallback for non-secure contexts / older browsers
        const ta = document.createElement('textarea')
        ta.value = fullPath
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      addToast('success', t('fm.copyPathSuccess'))
    } catch {
      addToast('error', t('fm.copyPathFailed'))
    }
  }

  const handleUpload = () => {
    if (!fmSource) return
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = async () => {
      if (!input.files?.length) return
      for (let i = 0; i < input.files.length; i++) {
        try {
          await api.uploadFile2({
            session: fmSource.type === 'session' ? fmSource.id : undefined,
            workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
            projectId: activeProjectId ?? undefined,
            path: cwd,
            file: input.files[i],
          })
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
    if (!searchQuery.trim() || !fmSource) { fetchFiles(); return }
    setLoading(true)
    try {
      const results = await api.searchFiles2({
        session: fmSource.type === 'session' ? fmSource.id : undefined,
        workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
        projectId: activeProjectId ?? undefined,
        query: searchQuery,
        path: cwd,
      })
      setFiles(results)
    } catch (err: any) {
      addToast('error', err.message || t('fm.searchFailed'))
    } finally {
      setLoading(false)
    }
  }

  // ── Download mode handlers ──
  const exitDownloadMode = () => {
    setDownloadMode(false)
    setChecked(new Set())
  }

  const handleDownloadClick = () => {
    if (!fmSource) return
    if (downloadMode) {
      if (checked.size > 0) {
        // Trigger downloads (skip directories)
        const filePaths = Array.from(checked).filter((p) => {
          const name = p.split('/').pop() || ''
          const entry = files.find((f) => f.name === name)
          return entry && entry.path_type !== 'Dir' && entry.path_type !== 'SymlinkDir'
        })
        filePaths.forEach((p) => {
          const a = document.createElement('a')
          a.href = api.downloadUrl2({
            session: fmSource.type === 'session' ? fmSource.id : undefined,
            workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
            projectId: activeProjectId ?? undefined,
            path: p,
          })
          a.download = p.split('/').pop() || 'download'
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
        })
        if (filePaths.length === 1) {
          addToast('success', t('fm.downloadStarted', { name: filePaths[0].split('/').pop() || '' }))
        } else {
          addToast('success', t('fm.downloadStartedMulti', { count: filePaths.length }))
        }
        exitDownloadMode()
      } else {
        // 0 selected → cancel mode
        exitDownloadMode()
      }
    } else {
      // Enter download mode; close search/create overlays
      if (searchOpen) { setSearchOpen(false); setSearchQuery('') }
      if (createOpen) { setCreateOpen(null); setCreateName('') }
      setDownloadMode(true)
    }
  }

  const handleCheckboxToggle = (fullPath: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(fullPath)) next.delete(fullPath)
      else next.add(fullPath)
      return next
    })
  }

  const handleSelectAllToggle = () => {
    if (checked.size === files.length) {
      setChecked(new Set())
    } else {
      setChecked(new Set(files.map((f) => (cwd ? `${cwd}/${f.name}` : f.name))))
    }
  }

  // ── Create (folder/file) handlers ──
  const openCreate = (mode: 'folder' | 'file') => {
    if (createOpen === mode) {
      setCreateOpen(null)
      setCreateName('')
      return
    }
    // Mutual exclusion
    if (searchOpen) { setSearchOpen(false); setSearchQuery('') }
    if (downloadMode) exitDownloadMode()
    setCreateOpen(mode)
    setCreateName('')
    setTimeout(() => createInputRef.current?.focus(), 0)
  }

  const closeCreate = () => {
    setCreateOpen(null)
    setCreateName('')
  }

  const submitCreate = async () => {
    if (!fmSource || !createOpen) return
    const name = createName.trim()
    if (!name) { addToast('error', t('fm.nameRequired')); return }
    if (name.includes('/')) { addToast('error', t('fm.nameInvalid')); return }
    const mode = createOpen
    try {
      if (mode === 'folder') {
        await api.mkdir2({
          session: fmSource.type === 'session' ? fmSource.id : undefined,
          workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
          projectId: activeProjectId ?? undefined,
          path: cwd,
          name,
        })
      } else {
        const fullPath = cwd ? `${cwd}/${name}` : name
        await api.writeFile2({
          session: fmSource.type === 'session' ? fmSource.id : undefined,
          workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
          projectId: activeProjectId ?? undefined,
          path: fullPath,
          content: '',
        })
      }
      addToast('success', t('fm.createSuccess', { name }))
      closeCreate()
      fetchFiles()
    } catch (err: any) {
      addToast('error', err.message || t('fm.createFailed', { msg: err.message || '' }))
    }
  }

  const SI = ({ col }: { col: SortKey }) =>
    sortKey === col ? (
      <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--accent)', userSelect: 'none' }}>
        {sortDesc ? '▼' : '▲'}
      </span>
    ) : null

  // Breadcrumb segments — always in original order; RTL direction only changes
  // alignment (right) and clip side (left), never reverses LTR character flow.
  const bcSegments = cwd.split('/').filter(Boolean)
  const bcItems = bcSegments.map((s, i) => ({
    name: s,
    path: '/' + bcSegments.slice(0, i + 1).join('/')
  }))

  if (fileManagerCollapsed) {
    return (
      <div
        className="h-full flex flex-col items-center relative"
        style={{ background: 'var(--bg-base)', fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace", width: 40 }}
      >
        <button
          onClick={toggleFileManagerCollapsed}
          className="flex items-center justify-center rounded-md transition-all mt-3"
          style={{ width: 24, height: 24, color: 'var(--text-faint)', fontSize: 14 }}
          title={t('fm.expand')}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; e.currentTarget.style.background = 'transparent' }}
        >
          ◀
        </button>

        <div className="flex-1 flex items-center justify-center">
          <button
            onClick={toggleFileManagerCollapsed}
            className="flex items-center justify-center rounded-md transition-all"
            style={{ width: 28, height: 28, color: 'var(--text-dim)', fontSize: 14 }}
            title={t('fm.expand')}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-dim)'; e.currentTarget.style.background = 'transparent' }}
          >
            <IconFolderOpen width={18} height={18} />
          </button>
        </div>

        <button
          onClick={toggleFileManagerCollapsed}
          className="flex items-center justify-center rounded-md transition-all mb-3"
          style={{ width: 24, height: 24, color: 'var(--text-faint)', fontSize: 14 }}
          title={t('fm.expand')}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; e.currentTarget.style.background = 'transparent' }}
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
            style={{ width: 24, height: 24, color: 'var(--text-faint)', fontSize: 14 }}
            title={t('fm.collapse')}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-10)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-faint)'; e.currentTarget.style.background = 'transparent' }}
          >
            ▶
          </button>
          {/* "回到终端目录" 按钮 — 脱离终端时脉冲 */}
          {fmSource && (
            <button
              className={`fm-bc-root ${(fmSource?.type === 'session' && fmState.mode === 'manual') ? 'fm-btn-terminal-active' : ''}`}
              onClick={() => {
                if (activeSessionId) resetFmToFollowing(activeSessionId)
              }}
              title={t('fm.backToTerminalDir')}
            >
              <IconWorkbench width={13} height={13} />
            </button>
          )}
        </div>
        <div className="fm-toolbar-right">
          {/* 1. Search */}
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

          {/* 2. Back to parent */}
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

          {/* 3. Download (mode toggle) */}
          <button
            className={`fm-btn ${downloadMode ? 'fm-btn-download-active' : ''}`}
            onClick={handleDownloadClick}
            disabled={!cwd}
            title={t('fm.download')}
          >
            <IconDownload />
          </button>

          {/* 4. Upload */}
          <button className="fm-btn" onClick={handleUpload} title={t('fm.upload')}>
            <IconUpload />
          </button>

          {/* 5+6. New folder / New file (shared click-outside area) */}
          <div ref={createAreaRef} className="flex items-center" style={{ gap: 'inherit' }}>
            <div className="fm-search-wrap">
              <button className="fm-btn" onClick={() => openCreate('folder')} disabled={!cwd} title={t('fm.newFolder')}>
                <IconFolderPlus />
              </button>
              {createOpen === 'folder' && (
                <input
                  ref={createInputRef}
                  className="fm-search"
                  placeholder={t('fm.createNamePlaceholder')}
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitCreate()
                    if (e.key === 'Escape') closeCreate()
                  }}
                  autoFocus
                />
              )}
            </div>
            <div className="fm-search-wrap">
              <button className="fm-btn" onClick={() => openCreate('file')} disabled={!cwd} title={t('fm.newFile')}>
                <IconFilePlus />
              </button>
              {createOpen === 'file' && (
                <input
                  ref={createInputRef}
                  className="fm-search"
                  placeholder={t('fm.createNamePlaceholder')}
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitCreate()
                    if (e.key === 'Escape') closeCreate()
                  }}
                  autoFocus
                />
              )}
            </div>
          </div>

          {/* 7. Refresh (moved to the end) */}
          <button className="fm-btn" onClick={() => fetchFiles()} title={t('fm.refresh')}>
            <IconRefresh />
          </button>
        </div>
      </div>

      {cwd && (
        <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
          <div
            ref={bcRef}
            className="fm-breadcrumb"
            style={{ direction: bcOverflow ? 'rtl' : 'ltr', flex: 1, minWidth: 0 }}
            title={cwd}
          >
            {bcItems.flatMap((item) => [
              <span key={`sep-${item.path}`} className="fm-bc-sep">/</span>,
              <span key={item.path} className="fm-bc-seg" onClick={(e) => { e.stopPropagation(); navigateTo(item.path); }}>{item.name}</span>
            ])}
          </div>
          {isOutsideWorkspace && (
            <span
              className="fm-warning-icon"
              title={t('fm.outOfWorkspace')}
              style={{ marginLeft: 6, color: 'var(--warning)', cursor: 'help', flexShrink: 0 }}
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
        {!fmSource ? (
          <div className="fm-empty">
            <span className="fm-empty-icon"><IconFolderOpen width={32} height={32} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.4))' }} /></span>
            <span>{t('fm.selectSessionFirst')}</span>
          </div>
        ) : loading ? (
          <div className="fm-empty">{t('fm.loading')}</div>
        ) : files.length === 0 ? (
          <div className="fm-empty">
            <span className="fm-empty-icon"><IconFolderOpen width={32} height={32} style={{ color: 'var(--accent)', filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.4))' }} /></span>
            <span>{t('fm.emptyDir')}</span>
            <span className="fm-empty-hint">{t('fm.dragHint')}</span>
          </div>
        ) : (
          <div style={{ flex: '1 1 0', minHeight: 0, overflow: 'auto' }}>
            <table className="fm-table">
              <colgroup>
                {downloadMode && <col style={{ width: 32 }} />}
                <col ref={(el) => { colRefs.current.name = el }} style={{ width: colWidths.name }} />
                <col ref={(el) => { colRefs.current.mtime = el }} style={{ width: colWidths.mtime }} />
                <col ref={(el) => { colRefs.current.size = el }} style={{ width: colWidths.size }} />
                <col style={{ width: 104 }} />
              </colgroup>
              <thead>
                <tr>
                  {downloadMode && (
                  <th className="fm-checkbox-cell">
                    <input
                      type="checkbox"
                      className="fm-checkbox"
                      checked={files.length > 0 && checked.size === files.length}
                      ref={(el) => {
                        if (el) el.indeterminate = checked.size > 0 && checked.size < files.length
                      }}
                      onChange={handleSelectAllToggle}
                    />
                  </th>
                  )}
                  <th>
                    <span className="fm-th-sort" onClick={() => handleSort('name')}>
                      {t('fm.name')} <SI col="name" />
                    </span>
                    <span className="fm-th-resize" onMouseDown={(e) => handleResizeStart('name', e)} onTouchStart={(e) => handleResizeStart('name', e)} />
                  </th>
                  <th>
                    <span className="fm-th-sort" onClick={() => handleSort('mtime')}>
                      {t('fm.lastModified')} <SI col="mtime" />
                    </span>
                    <span className="fm-th-resize" onMouseDown={(e) => handleResizeStart('mtime', e)} onTouchStart={(e) => handleResizeStart('mtime', e)} />
                  </th>
                  <th>
                    <span className="fm-th-sort" onClick={() => handleSort('size')}>
                      {t('fm.size')} <SI col="size" />
                    </span>
                    <span className="fm-th-resize" onMouseDown={(e) => handleResizeStart('size', e)} onTouchStart={(e) => handleResizeStart('size', e)} />
                  </th>
                  <th className="fm-th-actions">{t('fm.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const fullPath = cwd ? `${cwd}/${f.name}` : f.name
                  const isDir = f.path_type === 'Dir' || f.path_type === 'SymlinkDir'
                  const isEditing = editingName === fullPath
                  const isSel = selected.has(fullPath)
                  const isChecked = checked.has(fullPath)
                  return (
                    <tr
                      key={fullPath}
                      className={isSel ? 'fm-tr-selected' : ''}
                      onClick={(e) => handleRowClick(f, e)}
                      onDoubleClick={() => {
                        if (isDir) navigateTo(fullPath)
                      }}
                    >
                      {downloadMode && (
                      <td className="fm-checkbox-cell">
                        <input
                          type="checkbox"
                          className="fm-checkbox"
                          checked={isChecked}
                          onClick={(e) => e.stopPropagation()}
                          onChange={() => handleCheckboxToggle(fullPath)}
                        />
                      </td>
                      )}
                      <td className="fm-td-name">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' }}>
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
                            <span className="fm-name-text">{f.name}</span>
                          )}
                        </div>
                      </td>
                      <td className="fm-td-time">{formatTime(f.mtime)}</td>
                      <td className="fm-td-size">{isDir ? `${f.size} ${t('fm.items')}` : formatSize(f.size)}</td>
                      <td className="fm-td-actions-cell">
                        <span
                          className="fm-act-icon"
                          title={fullPath}
                          onClick={(e) => { e.stopPropagation(); handleCopyPath(fullPath) }}
                        >
                          <IconCopy />
                        </span>
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
      {(drawerFilePath || workspaceDrawerPath) && (
        <FileDrawer
          filePath={drawerFilePath ?? workspaceDrawerPath!}
          sessionId={activeSessionId}
          workspaceId={activeWorkspaceId}
          projectId={activeProjectId}
          onClose={() => {
            if (activeSessionId) closeFmDrawer(activeSessionId)
            else setWorkspaceDrawerPath(null)
          }}
          height={drawerHeight}
          onHeightChange={setDrawerHeight}
          fileChangeEvent={fileChangeEvent}
        />
      )}
    </div>
  )
}
