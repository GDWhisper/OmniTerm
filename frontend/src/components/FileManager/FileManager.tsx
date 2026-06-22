import { useState, useEffect, useRef, type KeyboardEvent, type DragEvent } from 'react'
import { api } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'
import { useAppStore } from '../../stores/appStore'
import { IconFolder, IconFile, IconLink, IconArrowUp, IconRefresh, IconUpload, IconPencil, IconTrash, IconFolderOpen } from './icons'

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
  const addToast = useToastStore((s) => s.addToast)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const fileManagerCollapsed = useAppStore((s) => s.fileManagerCollapsed)
  const toggleFileManagerCollapsed = useAppStore((s) => s.toggleFileManagerCollapsed)

  const [files, setFiles] = useState<FileEntry[]>([])
  const [currentPath, setCurrentPath] = useState('')
  const [loading, setLoading] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDesc, setSortDesc] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editingName, setEditingName] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [colWidths, setColWidths] = useState({ name: 300, mtime: 140, size: 100 })

  useEffect(() => {
    const hash = window.location.hash
    if (hash.startsWith('#/fm')) {
      const raw = hash.slice(4).replace(/^\//, '')
      setCurrentPath(decodeURIComponent(raw))
    }
  }, [])

  const fetchFiles = async (path: string, sort?: string, desc?: boolean) => {
    if (!activeWorkspaceId) { setFiles([]); return }
    setLoading(true)
    try {
      const data = await api.listFiles(activeWorkspaceId, path, sort ?? sortKey, desc ?? sortDesc)
      setFiles(data)
      setSelected(new Set())
    } catch (err: any) {
      addToast('error', err.message || '加载文件列表失败')
      setFiles([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchFiles(currentPath)
  }, [currentPath, activeWorkspaceId])

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

  const navigateTo = (path: string) => {
    setCurrentPath(path)
    window.location.hash = path ? `/fm/${path}` : '/fm'
  }

  const handleRowClick = (entry: FileEntry, e: React.MouseEvent) => {
    if (editingName) return
    if (entry.path_type === 'Dir' || entry.path_type === 'SymlinkDir') {
      navigateTo(currentPath ? `${currentPath}/${entry.name}` : entry.name)
      return
    }
    const fullPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        next.has(fullPath) ? next.delete(fullPath) : next.add(fullPath)
        return next
      })
    } else {
      setSelected(new Set([fullPath]))
    }
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
    fetchFiles(currentPath, key, newDesc)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (editingName) return
    if (e.key === 'Backspace' || e.key === 'Delete') {
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
      setSelected(new Set(files.map((f) => currentPath ? `${currentPath}/${f.name}` : f.name)))
    }
  }

  const handleDragOver = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }
  const handleDragLeave = (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOver(false) }

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const droppedFiles = e.dataTransfer?.files
    if (!droppedFiles?.length) return
    for (let i = 0; i < droppedFiles.length; i++) {
      const file = droppedFiles[i]
      try {
        await api.uploadFile(activeWorkspaceId!, currentPath, file)
      } catch (err: any) {
        addToast('error', `上传 ${file.name} 失败: ${err.message}`)
      }
    }
    addToast('success', '上传完成')
    fetchFiles(currentPath)
  }

  const startRename = () => {
    if (selected.size !== 1) return
    const path = Array.from(selected)[0]
    const name = path.split('/').pop() || ''
    setEditingName(path)
    setEditValue(name)
  }

  const commitRename = async () => {
    if (!editingName || !editValue.trim()) { setEditingName(null); return }
    try {
      await api.rename(activeWorkspaceId!, editingName, editValue.trim())
      addToast('success', '重命名成功')
      fetchFiles(currentPath)
    } catch (err: any) {
      addToast('error', err.message || '重命名失败')
    }
    setEditingName(null)
  }

  const handleDelete = async () => {
    if (selected.size === 0) return
    if (!confirm(`确定删除 ${selected.size} 个项目？`)) return
    try {
      for (const path of selected) {
        await api.deleteFile(activeWorkspaceId!, path)
      }
      addToast('success', `已删除 ${selected.size} 个项目`)
      fetchFiles(currentPath)
    } catch (err: any) {
      addToast('error', err.message || '删除失败')
    }
  }

  const handleUpload = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = async () => {
      if (!input.files?.length) return
      for (let i = 0; i < input.files.length; i++) {
        try {
          await api.uploadFile(activeWorkspaceId!, currentPath, input.files[i])
        } catch (err: any) {
          addToast('error', `上传失败: ${err.message}`)
        }
      }
      addToast('success', '上传完成')
      fetchFiles(currentPath)
    }
    input.click()
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) { fetchFiles(currentPath); return }
    setLoading(true)
    try {
      const results = await api.searchFiles(activeWorkspaceId!, currentPath, searchQuery)
      setFiles(results)
    } catch (err: any) {
      addToast('error', err.message || '搜索失败')
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
          title="展开文件管理器"
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
          title="展开文件管理器"
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
            title="收起文件管理器"
            onMouseEnter={(e) => { e.currentTarget.style.color = '#a78bfa'; e.currentTarget.style.background = 'rgba(167,139,250,0.1)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#64748b'; e.currentTarget.style.background = 'transparent' }}
          >
            ▶
          </button>
        </div>
        <div className="fm-toolbar-right">
          <input
            className="fm-search"
            placeholder="搜索文件名..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
          />
          <button
            className="fm-btn"
            onClick={() => navigateTo(getParentPath(currentPath))}
            disabled={!currentPath}
            title="返回上级"
          >
            <IconArrowUp />
          </button>
          <button className="fm-btn" onClick={() => fetchFiles(currentPath)} title="刷新">
            <IconRefresh />
          </button>
          <button className="fm-btn" onClick={handleUpload} title="上传文件">
            <IconUpload />
          </button>
        </div>
      </div>

      {currentPath && (
        <div className="fm-breadcrumb">
          <span className="fm-bc-seg" onClick={() => navigateTo('')}>~</span>
          {currentPath.split('/').filter(Boolean).map((seg, i, arr) => {
            const segPath = arr.slice(0, i + 1).join('/')
            return (
              <span key={segPath}>
                <span className="fm-bc-sep">/</span>
                <span className="fm-bc-seg" onClick={() => navigateTo(segPath)}>{seg}</span>
              </span>
            )
          })}
        </div>
      )}

      <div
        className={`fm-table-wrap ${dragOver ? 'fm-drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {!activeWorkspaceId ? (
          <div className="fm-empty">
            <span className="fm-empty-icon"><IconFolderOpen width={32} height={32} style={{ color: '#a78bfa', filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.4))' }} /></span>
            <span>请先在侧栏创建或选择一个工作区</span>
          </div>
        ) : loading ? (
          <div className="fm-empty">加载中...</div>
        ) : files.length === 0 ? (
          <div className="fm-empty">
            <span className="fm-empty-icon"><IconFolderOpen width={32} height={32} style={{ color: '#a78bfa', filter: 'drop-shadow(0 0 10px rgba(167,139,250,0.4))' }} /></span>
            <span>此目录为空</span>
            <span className="fm-empty-hint">拖放文件到此处上传</span>
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
                      Name <SI col="name" />
                    </span>
                    <span className="fm-th-resize" onMouseDown={(e) => handleResizeStart('name', e)} />
                  </th>
                  <th>
                    <span className="fm-th-sort" onClick={() => handleSort('mtime')}>
                      Last Modified <SI col="mtime" />
                    </span>
                    <span className="fm-th-resize" onMouseDown={(e) => handleResizeStart('mtime', e)} />
                  </th>
                  <th>
                    <span className="fm-th-sort" onClick={() => handleSort('size')}>
                      Size <SI col="size" />
                    </span>
                    <span className="fm-th-resize" onMouseDown={(e) => handleResizeStart('size', e)} />
                  </th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => {
                  const fullPath = currentPath ? `${currentPath}/${f.name}` : f.name
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
                      <td className="fm-td-size">{isDir ? `${f.size} 项` : formatSize(f.size)}</td>
                      <td className="fm-td-actions-cell">
                        <span
                          className="fm-act-icon"
                          title="重命名"
                          onClick={(e) => { e.stopPropagation(); setSelected(new Set([fullPath])); startRename() }}
                        >
                          <IconPencil />
                        </span>
                        <span
                          className="fm-act-icon fm-act-icon-danger"
                          title="删除"
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
    </div>
  )
}
