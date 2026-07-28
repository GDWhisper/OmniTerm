import { useState, useRef, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'

type PathType = 'Dir' | 'File' | 'SymlinkDir' | 'SymlinkFile'

interface FileEntry {
  path_type: PathType
  name: string
  mtime: number
  size: number | null
}

type FmSource = { type: 'session'; id: string } | { type: 'workspace'; id: string }

export interface DragPreviewState {
  visible: boolean
  x: number
  y: number
  names: string[]
  icon: 'folder' | 'file' | 'code' | 'multi'
}

interface DragState {
  phase: 'idle' | 'pending' | 'active'
  startX: number
  startY: number
  entry: FileEntry
  pointerId: number
  pointerType: string
  longPressTimer: number | null
  paths: string[]
}

const CODE_EXTS = new Set(['.ts', '.tsx', '.rs', '.js', '.py', '.go', '.c', '.h'])

function entryIcon(entry: FileEntry): 'folder' | 'file' | 'code' {
  if (entry.path_type === 'Dir' || entry.path_type === 'SymlinkDir') return 'folder'
  const dot = entry.name.lastIndexOf('.')
  if (dot > 0 && CODE_EXTS.has(entry.name.slice(dot))) return 'code'
  return 'file'
}

interface UseFileDragOptions {
  cwd: string
  selected: Set<string>
  fmSource: FmSource | null
  activeProjectId: string | null
  onMoveComplete: () => void
}

export function useFileDrag(opts: UseFileDragOptions) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)

  const [preview, setPreview] = useState<DragPreviewState>({ visible: false, x: 0, y: 0, names: [], icon: 'file' })
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const dragRef = useRef<DragState | null>(null)
  const suppressClick = useRef(false)
  const tableWrapRef = useRef<HTMLDivElement | null>(null)
  const rafRef = useRef<number>(0)
  const lastPos = useRef({ x: 0, y: 0 })

  const optsRef = useRef(opts)
  optsRef.current = opts

  const cleanup = useCallback(() => {
    const ds = dragRef.current
    if (ds?.longPressTimer != null) clearTimeout(ds.longPressTimer)
    dragRef.current = null
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    document.body.classList.remove('fm-dragging')
    setPreview((p) => ({ ...p, visible: false }))
    setDropTarget(null)
    setIsDragging(false)
  }, [])

  const findDropTarget = useCallback((x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y)
    if (!el) return null
    const target = el.closest('[data-drop-path]')
    return target?.getAttribute('data-drop-path') ?? null
  }, [])

  const autoScroll = useCallback((y: number) => {
    const container = tableWrapRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const EDGE = 40
    const SPEED = 8
    if (y < rect.top + EDGE) container.scrollTop -= SPEED
    else if (y > rect.bottom - EDGE) container.scrollTop += SPEED
  }, [])

  const tick = useCallback(() => {
    const ds = dragRef.current
    if (!ds || ds.phase !== 'active') return
    const { x, y } = lastPos.current
    setPreview((p) => ({ ...p, x: x + 12, y: y + 12 }))
    setDropTarget(findDropTarget(x, y))
    autoScroll(y)
    rafRef.current = requestAnimationFrame(tick)
  }, [findDropTarget, autoScroll])

  const activate = useCallback((ds: DragState) => {
    ds.phase = 'active'
    suppressClick.current = true
    document.body.classList.add('fm-dragging')
    setIsDragging(true)

    const { cwd: curCwd, selected: sel } = optsRef.current
    const fullPath = curCwd ? `${curCwd}/${ds.entry.name}` : ds.entry.name
    const isSel = sel.has(fullPath)
    const paths = isSel ? Array.from(sel) : [fullPath]
    ds.paths = paths

    const names = isSel && sel.size > 1
      ? Array.from(sel).map((p) => p.split('/').pop() || p)
      : [ds.entry.name]
    const icon = names.length > 1 ? 'multi' : entryIcon(ds.entry)

    setPreview({ visible: true, x: lastPos.current.x + 12, y: lastPos.current.y + 12, names, icon })
    rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  const handlePointerMove = useCallback((e: PointerEvent) => {
    const ds = dragRef.current
    if (!ds || ds.pointerId !== e.pointerId) return
    lastPos.current = { x: e.clientX, y: e.clientY }

    if (ds.phase === 'pending') {
      const dx = e.clientX - ds.startX
      const dy = e.clientY - ds.startY
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (ds.pointerType === 'mouse') {
        if (dist > 5) activate(ds)
      } else {
        if (dist > 10) {
          cleanup()
        }
      }
    }
  }, [activate, cleanup])

  const handlePointerUp = useCallback(async (e: PointerEvent) => {
    const ds = dragRef.current
    if (!ds || ds.pointerId !== e.pointerId) return

    document.removeEventListener('pointermove', handlePointerMove)
    document.removeEventListener('pointerup', handlePointerUp)
    document.removeEventListener('pointercancel', handlePointerCancel)

    if (ds.phase === 'active') {
      const target = findDropTarget(e.clientX, e.clientY)
      const { cwd: curCwd, fmSource: src, activeProjectId: pid } = optsRef.current

      if (target && target !== curCwd) {
        const invalid = ds.paths.some((p) => target.startsWith(p + '/'))
        if (!invalid) {
          try {
            await api.moveFiles2({
              session: src?.type === 'session' ? src.id : undefined,
              workspaceId: src?.type === 'workspace' ? src.id : undefined,
              projectId: pid ?? undefined,
              paths: ds.paths,
              destination: target,
            })
            addToast('success', t('fm.moveSuccess', { count: ds.paths.length }))
            optsRef.current.onMoveComplete()
          } catch {
            addToast('error', t('fm.moveFailed'))
          }
        }
      }
    }

    cleanup()
    setTimeout(() => { suppressClick.current = false }, 0)
  }, [handlePointerMove, findDropTarget, cleanup, addToast, t])

  const handlePointerCancel = useCallback((e: PointerEvent) => {
    const ds = dragRef.current
    if (!ds || ds.pointerId !== e.pointerId) return
    document.removeEventListener('pointermove', handlePointerMove)
    document.removeEventListener('pointerup', handlePointerUp)
    document.removeEventListener('pointercancel', handlePointerCancel)
    cleanup()
    setTimeout(() => { suppressClick.current = false }, 0)
  }, [handlePointerMove, handlePointerUp, cleanup])

  const handlePointerDown = useCallback((e: React.PointerEvent, entry: FileEntry) => {
    if (e.button !== 0) return
    if (dragRef.current) return

    const ds: DragState = {
      phase: 'pending',
      startX: e.clientX,
      startY: e.clientY,
      entry,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      longPressTimer: null,
      paths: [],
    }
    lastPos.current = { x: e.clientX, y: e.clientY }
    dragRef.current = ds

    if (e.pointerType !== 'mouse') {
      ds.longPressTimer = window.setTimeout(() => {
        const cur = dragRef.current
        if (cur && cur.phase === 'pending') {
          const dx = lastPos.current.x - cur.startX
          const dy = lastPos.current.y - cur.startY
          if (Math.sqrt(dx * dx + dy * dy) < 10) {
            activate(cur)
          }
        }
      }, 300)
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('pointercancel', handlePointerCancel)
  }, [handlePointerMove, handlePointerUp, handlePointerCancel, activate])

  useEffect(() => cleanup, [cleanup])

  return { handlePointerDown, preview, dropTarget, isDragging, suppressClick, tableWrapRef }
}
