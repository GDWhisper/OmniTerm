import { getParentPath } from '../../utils/path'
import { getInitialDrawerHeight } from '../../utils/drawer'
import { useState, useEffect, useRef, useCallback, useMemo, type KeyboardEvent, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'
import { useAppStore } from '../../stores/appStore'
import { useFileWatcher } from '../../hooks/useFileWatcher'
import { isOutsideSkipped, markOutsideSkipped } from '../../utils/fmOutsideSkip'
import { copyText } from '../../utils/clipboard'
import { ConfirmDialog } from '../Modal/ConfirmDialog'
import { IconLink, IconArrowUp, IconRefresh, IconUpload, IconDownload, IconFolderPlus, IconFilePlus, IconCopy, IconPencil, IconTrash, IconFolderOpen, IconWarning, IconSearch, IconWorkbench } from './icons'
import { FileDrawer } from './FileDrawer'
import { triggerBump } from '../../utils/pixelAnimations'
import { FolderSprite, FileSprite, FileCodeSprite } from '../PixelUI/PixelSprites'
import { useFileDrag } from './useFileDrag'

type PathType = 'Dir' | 'File' | 'SymlinkDir' | 'SymlinkFile'

interface FileEntry {
  path_type: PathType
  name: string
  mtime: number
  size: number | null
}

type SortKey = 'name' | 'mtime' | 'size'

const SortIndicator = ({ col, sortKey, sortDesc }: { col: SortKey; sortKey: SortKey; sortDesc: boolean }) =>
  sortKey === col ? (
    <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--accent)', userSelect: 'none' }}>
      {sortDesc ? '▼' : '▲'}
    </span>
  ) : null

// 文件表格固定列宽（px）——name 列在容器内自适应剩余宽度（D5）
const FM_COL = { mtime: 140, size: 100, actions: 104, minName: 140 } as const

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

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.rs', '.js', '.py', '.go', '.c', '.h'])

function isCodeFile(name: string): boolean {
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  return CODE_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

function FileIcon({ entry }: { entry: FileEntry }) {
  switch (entry.path_type) {
    case 'Dir':
    case 'SymlinkDir':
      return <FolderSprite size={14} />
    case 'SymlinkFile':
      return <IconLink style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
    case 'File':
      return isCodeFile(entry.name)
        ? <FileCodeSprite size={14} />
        : <FileSprite size={14} />
  }
}

export function FileManager() {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const activeProjectId = useAppStore((s) => s.activeProjectId)
  const uiZoom = useAppStore((s) => s.uiZoom)
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

  // Drawer height (sessionStorage, shared across sessions; default = 50% viewport)
  const [drawerHeight, setDrawerHeight] = useState(() => getInitialDrawerHeight('omniterm_drawer_height'))

  // SSE file watcher (replaces 3s polling)
  const { lastEvent: fileChangeEvent } = useFileWatcher({
    sessionId: activeSessionId,
    enabled: !!activeSessionId,
  })

  const [files, setFiles] = useState<FileEntry[]>([])
  const [cwd, setCwd] = useState('')  // absolute path from server
  const [isOutsideWorkspace, setIsOutsideWorkspace] = useState(false)
  // workspace 边界根路径（listFiles2 返回的 workspace_root）；project 模式为 undefined
  const [workspaceRoot, setWorkspaceRoot] = useState<string | undefined>(undefined)

  // ── 越界写拦截弹窗状态 ──
  // pendingOutsideAction: 越界且未「暂时别提醒」时挂起的写操作（确认后执行，请求带 allow_escape=true）
  const [pendingOutsideAction, setPendingOutsideAction] = useState<{ run: () => void } | null>(null)
  // deleteDialog: 非越界删除的普通确认弹窗（取代原 window.confirm）
  const [deleteDialog, setDeleteDialog] = useState<{ count: number; run: () => void } | null>(null)

  // Per-session file list cache for instant display on session switch
  const fileCache = useRef<Map<string, { files: FileEntry[]; cwd: string; isOutsideWorkspace: boolean; workspaceRoot?: string }>>(new Map())
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
  const [colWidths, setColWidths] = useState({ name: 300, mtime: FM_COL.mtime, size: FM_COL.size })
  const [nameColAuto, setNameColAuto] = useState(true)
  const colRefs = useRef<Record<'name' | 'mtime' | 'size', HTMLTableColElement | null>>({
    name: null,
    mtime: null,
    size: null,
  })
  const resizingRef = useRef<{ col: string; startX: number; startW: number } | null>(null)
  const colWidthsRef = useRef(colWidths)
  colWidthsRef.current = colWidths

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
      // Workspace mode has no session-keyed manualPath: fall back to current
      // cwd so parameterless refreshes (create/upload/rename) keep the path.
      const effectivePath = path ?? (
        fmSource.type === 'workspace'
          ? (cwdRef.current || '.')
          : (fmState.mode === 'manual' && fmState.manualPath ? fmState.manualPath : '.')
      )
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
      // project 模式无 workspace_root（undefined）→ 重置为 undefined，此时总是弹确认（安全默认）
      setWorkspaceRoot(data.workspace_root)
      if (data.cwd) {
        fileCache.current.set(sourceKey!, { files: newFiles, cwd: data.cwd, isOutsideWorkspace: data.is_outside_workspace ?? false, workspaceRoot: data.workspace_root })
      }
      if (!silent) setSelected(new Set())
      return data.cwd
    } catch (err: unknown) {
      if (!silent) addToast('error', (err instanceof Error ? err.message : String(err)) || t('fm.loadFailed'))
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
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const fetchFilesRef = useRef(fetchFiles)
  fetchFilesRef.current = fetchFiles

  // ── 越界写拦截 ──
  // 越界（isOutsideWorkspace）且未勾选「暂时别提醒」时，挂起写操作并弹 ConfirmDialog；
  // 否则直接执行（越界已跳过时同样直接执行，请求仍带 allow_escape=true）。
  const gateWrite = (run: () => void) => {
    if (isOutsideWorkspace && !isOutsideSkipped(workspaceRoot)) {
      setPendingOutsideAction({ run })
    } else {
      run()
    }
  }

  const handleOutsideConfirm = (checked: boolean) => {
    if (checked) markOutsideSkipped(workspaceRoot)
    const action = pendingOutsideAction
    setPendingOutsideAction(null)
    action?.run()
  }

  const handleDeleteDialogConfirm = () => {
    const d = deleteDialog
    setDeleteDialog(null)
    d?.run()
  }

  const {
    handlePointerDown: handleFileDragStart,
    preview: dragPreview,
    dropTarget,
    isDragging: isFileDragActive,
    suppressClick,
    tableWrapRef: fileDragTableRef,
  } = useFileDrag({
    cwd, selected, fmSource, activeProjectId,
    onMoveComplete: () => fetchFiles(),
  })

  // name 列随容器自适应；用户一旦手动拖拽任何列，永久退出自适应（D5）
  useEffect(() => {
    if (!nameColAuto) return
    const el = fileDragTableRef.current
    if (!el) return
    const fit = () =>
      setColWidths((cw) => {
        const name = Math.max(FM_COL.minName, el.clientWidth - FM_COL.mtime - FM_COL.size - FM_COL.actions - 2)
        return cw.name === name ? cw : { ...cw, name }
      })
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [nameColAuto, fileDragTableRef])

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
  const prevSourceTypeRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!fmSource) { setFiles([]); setCwd(''); return }
    // 切换 source 类型（workspace ↔ session）时清空旧 source 留下的 drawer 路径，
    // 避免 workspaceRoot 更新为新源后与旧 filePath 失配而误弹越界确认
    // （FileDrawer 的 workspaceDrawerPath 属于 workspace 模式，fmState.drawerPath 属于 session 模式）。
    const newType = fmSource.type
    if (prevSourceTypeRef.current && prevSourceTypeRef.current !== newType) {
      setWorkspaceDrawerPath(null)
    }
    prevSourceTypeRef.current = newType
    const cached = fileCache.current.get(sourceKey!)
    if (cached) {
      setFiles(cached.files)
      setCwd(cached.cwd)
      setIsOutsideWorkspace(cached.isOutsideWorkspace)
      setWorkspaceRoot(cached.workspaceRoot)
    }
    if (fmSource.type === 'workspace') {
      fetchFilesRef.current('.')
    } else if (fmState.mode === 'manual' && fmState.manualPath) {
      fetchFilesRef.current(fmState.manualPath)
    } else {
      fetchFilesRef.current('.')
    }
  }, [sourceKey, fmState.mode, fmState.manualPath])

  useEffect(() => {
    const onMove = (e: MouseEvent | TouchEvent) => {
      const r = resizingRef.current
      if (!r) return
      e.preventDefault()
      const mvX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const newW = Math.max(80, r.startW + (mvX - r.startX))
      const colEl = colRefs.current[r.col as 'name' | 'mtime' | 'size']
      if (colEl) {
        colEl.style.width = `${newW}px`
      }
    }
    const onUp = () => {
      const r = resizingRef.current
      if (!r) return
      const colEl = colRefs.current[r.col as 'name' | 'mtime' | 'size']
      const finalW = colEl ? parseInt(colEl.style.width) || r.startW : r.startW
      colWidthsRef.current = { ...colWidthsRef.current, [r.col]: finalW }
      setColWidths((prev) => ({ ...prev, [r.col]: finalW }))
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
    setNameColAuto(false)
    e.preventDefault()
    e.stopPropagation()
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const startW = colWidthsRef.current[col as 'name' | 'mtime' | 'size']
    resizingRef.current = { col, startX: clientX, startW }
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

  const selectAnchor = useRef<number>(-1)

  const handleRowClick = (entry: FileEntry, e?: React.MouseEvent) => {
    if (suppressClick.current) return
    if (editingName) return
    const fullPath = cwd ? `${cwd}/${entry.name}` : entry.name
    const idx = files.indexOf(entry)

    if (e?.shiftKey && selectAnchor.current >= 0) {
      const start = Math.min(selectAnchor.current, idx)
      const end = Math.max(selectAnchor.current, idx)
      const range = files.slice(start, end + 1).map((f) => cwd ? `${cwd}/${f.name}` : f.name)
      setSelected(new Set(range))
      return
    }
    if (e?.ctrlKey || e?.metaKey) {
      selectAnchor.current = idx
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(fullPath)) next.delete(fullPath)
        else next.add(fullPath)
        return next
      })
      return
    }
    selectAnchor.current = idx
    if (entry.path_type === 'Dir' || entry.path_type === 'SymlinkDir') {
      navigateTo(fullPath)
      return
    }
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

  // Defined before the create-close effect below to avoid a TDZ ReferenceError
  // (the effect references it during the first render before a later const init).
  const closeCreate = useCallback(() => {
    setCreateOpen(null)
    setCreateName('')
  }, [])

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
  }, [createOpen, closeCreate])

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

  const handleDragOver = (e: DragEvent) => { if (isFileDragActive) return; e.preventDefault(); e.stopPropagation(); setDragOver(true) }
  const handleDragLeave = (e: DragEvent) => { if (isFileDragActive) return; e.preventDefault(); e.stopPropagation(); setDragOver(false) }

  const handleDrop = (e: DragEvent) => {
    if (isFileDragActive) return
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const droppedFiles = e.dataTransfer?.files
    if (!droppedFiles?.length || !fmSource) return
    const runUpload = async () => {
      for (let i = 0; i < droppedFiles.length; i++) {
        const file = droppedFiles[i]
        try {
          await api.uploadFile2({
            session: fmSource.type === 'session' ? fmSource.id : undefined,
            workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
            projectId: activeProjectId ?? undefined,
            path: cwd,
            file,
            allowEscape: isOutsideWorkspace ? true : undefined,
          })
        } catch (err: unknown) {
          addToast('error', t('fm.uploadFileFailed', { name: file.name, msg: err instanceof Error ? err.message : String(err) }))
        }
      }
      addToast('success', t('fm.uploadComplete'))
      import('../../utils/audioFeedback').then(m => m.play8BitSound('coin'))
      fetchFiles()
    }
    gateWrite(runUpload)
  }

  const startRename = () => {
    if (selected.size !== 1) return
    const path = Array.from(selected)[0]
    const name = path.split('/').pop() || ''
    setEditingName(path)
    setEditValue(name)
  }

  const runRename = async () => {
    if (!editingName || !editValue.trim() || !fmSource) { setEditingName(null); return }
    const newName = editValue.trim()
    try {
      await api.rename2({
        session: fmSource.type === 'session' ? fmSource.id : undefined,
        workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
        projectId: activeProjectId ?? undefined,
        path: editingName,
        newName,
        allowEscape: isOutsideWorkspace ? true : undefined,
      })
      addToast('success', t('fm.renameSuccess'))
      fetchFiles()
      // Drawer 正打开被改名的文件时，同步 drawerPath 到新路径，
      // 避免预览继续请求已不存在的旧路径而 404（图片预览会显示「加载失败」）
      const slashIdx = editingName.lastIndexOf('/')
      const newPath = slashIdx >= 0 ? `${editingName.slice(0, slashIdx)}/${newName}` : newName
      if (drawerFilePath === editingName) {
        if (activeSessionId) setFmDrawerPath(activeSessionId, newPath, 'view')
      } else if (workspaceDrawerPath === editingName) {
        setWorkspaceDrawerPath(newPath)
      }
    } catch (err: unknown) {
      addToast('error', (err instanceof Error ? err.message : String(err)) || t('fm.renameFailed'))
    }
    setEditingName(null)
  }

  const commitRename = () => {
    if (!editingName || !editValue.trim() || !fmSource) { setEditingName(null); return }
    gateWrite(runRename)
  }

  const handleDelete = (paths?: Set<string>) => {
    const targets = paths ?? selected
    if (targets.size === 0 || !fmSource) return
    const runDelete = async () => {
      try {
        for (const p of targets) {
          await api.deleteFile2({
            session: fmSource.type === 'session' ? fmSource.id : undefined,
            workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
            projectId: activeProjectId ?? undefined,
            path: p,
            allowEscape: isOutsideWorkspace ? true : undefined,
          })
        }
        addToast('success', t('fm.deleted', { count: targets.size }))
        import('../../utils/audioFeedback').then(m => m.play8BitSound('stomp'))
        fetchFiles()
      } catch (err: unknown) {
        addToast('error', (err instanceof Error ? err.message : String(err)) || t('fm.deleteFailed'))
      }
    }
    if (isOutsideWorkspace) {
      // 越界：未跳过则弹越界确认；已勾选「暂时别提醒」则直接放行
      gateWrite(runDelete)
    } else {
      // 非越界：普通删除确认弹窗（取代 window.confirm）
      setDeleteDialog({ count: targets.size, run: runDelete })
    }
  }

  const handleCopyPath = async (fullPath: string) => {
    // D1：统一走 utils/clipboard.ts（async API + textarea 兜底），
    // 原内联实现收敛到公共 util，避免裸 http 下复制失效与逻辑重复。
    const ok = await copyText(fullPath)
    addToast(ok ? 'success' : 'error', ok ? t('fm.copyPathSuccess') : t('fm.copyPathFailed'))
  }

  const handleUpload = () => {
    if (!fmSource) return
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = () => {
      if (!input.files?.length) return
      // 快照 File 列表：runUpload 可能被挂起到确认弹窗之后才执行
      const files = Array.from(input.files)
      const runUpload = async () => {
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          try {
            await api.uploadFile2({
              session: fmSource.type === 'session' ? fmSource.id : undefined,
              workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
              projectId: activeProjectId ?? undefined,
              path: cwd,
              file,
              allowEscape: isOutsideWorkspace ? true : undefined,
            })
          } catch (err: unknown) {
            addToast('error', t('fm.uploadFileFailed', { name: file.name, msg: err instanceof Error ? err.message : String(err) }))
          }
        }
        addToast('success', t('fm.uploadComplete'))
        import('../../utils/audioFeedback').then(m => m.play8BitSound('coin'))
        fetchFiles()
      }
      gateWrite(runUpload)
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
    } catch (err: unknown) {
      addToast('error', (err instanceof Error ? err.message : String(err)) || t('fm.searchFailed'))
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
        // Trigger downloads. Directories are zipped server-side, so they are
        // included explicitly (no longer skipped).
        const filePaths = Array.from(checked)
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
          const name = filePaths[0].split('/').pop() || ''
          const entry = files.find((f) => f.name === name)
          const isDir = entry && (entry.path_type === 'Dir' || entry.path_type === 'SymlinkDir')
          addToast('success', isDir
            ? t('fm.downloadStartedDir', { name })
            : t('fm.downloadStarted', { name }))
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

  const submitCreate = () => {
    if (!fmSource || !createOpen) return
    const name = createName.trim()
    if (!name) { addToast('error', t('fm.nameRequired')); return }
    if (name.includes('/')) { addToast('error', t('fm.nameInvalid')); return }
    const mode = createOpen
    const runCreate = async () => {
      try {
        if (mode === 'folder') {
          await api.mkdir2({
            session: fmSource.type === 'session' ? fmSource.id : undefined,
            workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
            projectId: activeProjectId ?? undefined,
            path: cwd,
            name,
            allowEscape: isOutsideWorkspace ? true : undefined,
          })
        } else {
          const fullPath = cwd ? `${cwd}/${name}` : name
          await api.writeFile2({
            session: fmSource.type === 'session' ? fmSource.id : undefined,
            workspaceId: fmSource.type === 'workspace' ? fmSource.id : undefined,
            projectId: activeProjectId ?? undefined,
            path: fullPath,
            content: '',
            allowEscape: isOutsideWorkspace ? true : undefined,
          })
        }
        addToast('success', t('fm.createSuccess', { name }))
        closeCreate()
        fetchFiles()
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        addToast('error', msg || t('fm.createFailed', { msg: msg || '' }))
      }
    }
    gateWrite(runCreate)
  }

  // Breadcrumb segments — always in original order; RTL direction only changes
  // alignment (right) and clip side (left), never reverses LTR character flow.
  // Windows drive-letter paths ("G:/Codes") have no leading '/'; prepending one
  // would both display "/G:/Codes" and break navigation (not absolute on Windows).
  const isWinPath = /^[A-Za-z]:/.test(cwd)
  const bcSegments = cwd.split('/').filter(Boolean)
  const bcItems = bcSegments.map((s, i) => {
    const joined = bcSegments.slice(0, i + 1).join('/')
    return {
      name: s,
      // Drive segment alone ("G:") is drive-relative on Windows; keep it rooted ("G:/")
      path: isWinPath ? (i === 0 ? joined + '/' : joined) : '/' + joined
    }
  })

  return (
    <div
      className="omnifm-root"
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div className="fm-toolbar">
        <div className="fm-toolbar-left">
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
            data-drop-path={getParentPath(cwd) || undefined}
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
            {bcItems.flatMap((item, i) => [
              // No separator before the drive segment on Windows ("G:/Codes", not "/G:/Codes")
              ...(isWinPath && i === 0 ? [] : [<span key={`sep-${item.path}`} className="fm-bc-sep">/</span>]),
              <span key={item.path} className={`fm-bc-seg ${dropTarget === item.path ? 'fm-bc-seg-drop' : ''}`} data-drop-path={item.path} onClick={(e) => { e.stopPropagation(); navigateTo(item.path); }}>{item.name}</span>
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
        ref={fileDragTableRef}
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
                      {t('fm.name')} <SortIndicator col="name" sortKey={sortKey} sortDesc={sortDesc} />
                    </span>
                    <span className="fm-th-resize" onMouseDown={(e) => handleResizeStart('name', e)} onTouchStart={(e) => handleResizeStart('name', e)} />
                  </th>
                  <th>
                    <span className="fm-th-sort" onClick={() => handleSort('mtime')}>
                      {t('fm.lastModified')} <SortIndicator col="mtime" sortKey={sortKey} sortDesc={sortDesc} />
                    </span>
                    <span className="fm-th-resize" onMouseDown={(e) => handleResizeStart('mtime', e)} onTouchStart={(e) => handleResizeStart('mtime', e)} />
                  </th>
                  <th>
                    <span className="fm-th-sort" onClick={() => handleSort('size')}>
                      {t('fm.size')} <SortIndicator col="size" sortKey={sortKey} sortDesc={sortDesc} />
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
                      className={`${isSel ? 'fm-tr-selected' : ''} ${dropTarget === fullPath ? 'fm-drop-target' : ''}`}
                      data-drop-path={isDir ? fullPath : undefined}
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
                          <span className="fm-drag-handle" onPointerDown={(e) => handleFileDragStart(e, f)}><FileIcon entry={f} /></span>
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
                            <span className="fm-name-text" title={f.name}>{f.name}</span>
                          )}
                        </div>
                      </td>
                      {/* 容器 direction:rtl 只为左侧省略号；bdi 隔离避免日期中的 - : 被 bidi 重排 */}
                      <td className="fm-td-time" title={formatTime(f.mtime)}><bdi dir="ltr">{formatTime(f.mtime)}</bdi></td>
                      <td className="fm-td-size" title={isDir ? `${f.size} ${t('fm.items')}` : formatSize(f.size)}>{isDir ? `${f.size} ${t('fm.items')}` : formatSize(f.size)}</td>
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
                          onClick={(e) => { e.stopPropagation(); triggerBump(e.currentTarget); setSelected(new Set([fullPath])); handleDelete(new Set([fullPath])) }}
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

      {dragPreview.visible && (
        <div
          className="fm-drag-preview"
          style={{ transform: `translate(${dragPreview.x / (uiZoom / 100)}px, ${dragPreview.y / (uiZoom / 100)}px)` }}
        >
          <span className="fm-drag-preview-icon">
            {dragPreview.icon === 'folder' && <FolderSprite size={14} />}
            {dragPreview.icon === 'file' && <FileSprite size={14} />}
            {dragPreview.icon === 'code' && <FileCodeSprite size={14} />}
            {dragPreview.icon === 'multi' && <FolderSprite size={14} />}
          </span>
          <span className="fm-drag-preview-label">
            {dragPreview.names.length === 1 ? dragPreview.names[0] : `${dragPreview.names.length} items`}
          </span>
        </div>
      )}

      {/* 越界写入确认：当前目录超出 workspace 边界，写操作需显式放行（请求带 allow_escape=true） */}
      <ConfirmDialog
        open={pendingOutsideAction !== null}
        onClose={() => setPendingOutsideAction(null)}
        onConfirmWithChecked={handleOutsideConfirm}
        title={t('fm.outsideConfirmTitle')}
        message={t('fm.outsideConfirmMessage')}
        checkboxLabel={t('fm.outsideSkipCheckbox')}
        confirmText={t('fm.outsideConfirm')}
      />
      {/* 删除确认（非越界，取代原 window.confirm） */}
      <ConfirmDialog
        open={deleteDialog !== null}
        onClose={() => setDeleteDialog(null)}
        onConfirm={handleDeleteDialogConfirm}
        title={t('fm.deleteConfirmTitle')}
        message={deleteDialog ? t('fm.confirmDelete', { count: deleteDialog.count }) : ''}
        confirmText={t('fm.delete')}
        destructive
      />

      {/* File Drawer — slides up from bottom when a file is opened */}
      {(drawerFilePath || workspaceDrawerPath) && (
        <FileDrawer
          filePath={drawerFilePath ?? workspaceDrawerPath!}
          sessionId={activeSessionId ?? undefined}
          workspaceId={activeWorkspaceId ?? undefined}
          projectId={activeProjectId}
          workspaceRoot={workspaceRoot}
          onPathChange={(newPath) => {
            if (activeSessionId) setFmDrawerPath(activeSessionId, newPath, 'view')
            else setWorkspaceDrawerPath(newPath)
          }}
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
