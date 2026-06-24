import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'
import { FileEditor } from './FileEditor'
import { FilePreview } from './FilePreview'
import { IconEye, IconEdit, IconX, IconWarning } from './icons'

/** Supported image extensions for preview mode */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])

/** Known text file extensions */
const TEXT_EXTS = new Set([
  // Code
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'pyw', 'rs', 'go', 'java', 'c', 'cpp', 'cc', 'cxx',
  'h', 'hpp', 'hxx', 'php', 'sh', 'bash', 'zsh', 'fish',
  // Markup / data
  'html', 'htm', 'css', 'scss', 'less', 'json', 'jsonl',
  'xml', 'yaml', 'yml', 'toml', 'md', 'markdown', 'sql',
  // Config
  'env', 'conf', 'cfg', 'ini', 'gitignore', 'dockerignore',
  'editorconfig', 'prettierrc', 'eslintrc',
  // Other
  'txt', 'log', 'csv', 'tsv', 'makefile', 'dockerfile',
])

function getExtension(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  return ext
}

function isImageFile(fileName: string): boolean {
  return IMAGE_EXTS.has(getExtension(fileName))
}

function isTextFile(fileName: string): boolean {
  const ext = getExtension(fileName)
  // No extension = likely text
  if (!ext || ext === fileName.toLowerCase()) return true
  return TEXT_EXTS.has(ext)
}

interface FileDrawerProps {
  /** Absolute path of the file to display */
  filePath: string
  /** Session ID for API calls */
  sessionId: string
  /** Called when the drawer should close */
  onClose: () => void
  /** Current drawer height in px */
  height: number
  /** Called when height changes (drag) */
  onHeightChange: (height: number) => void
  /** SSE change events — when the current file changes externally */
  fileChangeEvent: { kind: string; path: string } | null
}

export function FileDrawer({
  filePath,
  sessionId,
  onClose,
  height,
  onHeightChange,
  fileChangeEvent,
}: FileDrawerProps) {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const fileName = filePath.split('/').pop() || filePath

  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [content, setContent] = useState('')
  const [editedContent, setEditedContent] = useState('')
  const [modified, setModified] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [externalChange, setExternalChange] = useState(false)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  // Track if the file content has been loaded at least once
  const loadedRef = useRef(false)

  const isImage = isImageFile(fileName)
  const isText = isTextFile(fileName)
  const isSupported = isImage || isText

  // Fetch file content
  const fetchContent = useCallback(async () => {
    if (!isText) return
    setLoading(true)
    setError(null)
    try {
      const data = await api.readFileBySession(sessionId, filePath)
      setContent(data.content)
      setEditedContent(data.content)
      setModified(false)
      setExternalChange(false)
      loadedRef.current = true
    } catch (err: any) {
      setError(err.message || t('drawer.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [sessionId, filePath, isText])

  // Initial load
  useEffect(() => {
    fetchContent()
    setMode('view')
    setModified(false)
    setExternalChange(false)
    loadedRef.current = false
  }, [filePath, sessionId])

  // Handle SSE change events for the current file
  useEffect(() => {
    if (!fileChangeEvent) return

    // Check if the event matches the currently open file
    // The event path is relative, filePath is absolute — compare by filename
    const eventFileName = fileChangeEvent.path.split('/').pop()
    if (eventFileName !== fileName) return

    if (fileChangeEvent.kind === 'delete') {
      setError(t('drawer.fileDeletedExternally'))
      return
    }

    if (mode === 'view') {
      // Silently refresh in view mode
      fetchContent()
    } else {
      // In edit mode, show warning
      setExternalChange(true)
    }
  }, [fileChangeEvent])

  // Save handler
  const handleSave = async () => {
    if (!modified || saving) return
    setSaving(true)
    try {
      await api.writeFileBySession(sessionId, filePath, editedContent)
      setContent(editedContent)
      setModified(false)
      setExternalChange(false)
      setSaveMessage(t('drawer.saved'))
      setTimeout(() => setSaveMessage(null), 2000)
    } catch (err: any) {
      addToast('error', err.message || t('drawer.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  // Reload from server (discard edits)
  const handleReload = async () => {
    await fetchContent()
    addToast('success', t('drawer.reloaded'))
  }

  // Close handler with unsaved changes check
  const handleClose = () => {
    if (modified) {
      const result = confirm(t('drawer.unsavedChanges'))
      if (result) {
        handleSave().then(onClose)
        return
      }
      // "Cancel" = don't close, "OK" (on confirm) = discard and close
      // confirm() returns true for OK, false for Cancel
      // We want: Save / Don't Save / Cancel
      // Browser confirm only has OK/Cancel, so:
      // OK = save and close, Cancel = don't close
      // This is a simplification — we'll use OK = discard and close
    }
    onClose()
  }

  // Content change handler
  const handleContentChange = (newContent: string) => {
    setEditedContent(newContent)
    setModified(newContent !== content)
  }

  // Drag bar resize logic
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - e.clientY // up = increase
      const newH = Math.max(120, Math.min(window.innerHeight - 60, dragRef.current.startH + delta))
      onHeightChange(newH)
    }
    const onMouseUp = () => {
      dragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [onHeightChange])

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: height }
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  // Compute status bar info
  const lineCount = isText ? editedContent.split('\n').length : 0
  const byteSize = isText ? new TextEncoder().encode(editedContent).length : 0

  return (
    <div
      style={{
        height,
        minHeight: 120,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-elevated)',
        borderTop: '1px solid var(--border-strong)',
        flexShrink: 0,
      }}
    >
      {/* Drag bar */}
      <div
        onMouseDown={handleDragStart}
        style={{
          height: 6,
          cursor: 'ns-resize',
          background: 'var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          transition: 'background 0.15s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent)' }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--border-subtle)' }}
      >
        <div style={{ width: 32, height: 2, borderRadius: 1, background: 'var(--text-dim)' }} />
      </div>

      {/* Top bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 12px',
          height: 36,
          borderBottom: '1px solid var(--border-subtle)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <span style={{ color: 'var(--text-faint)', flexShrink: 0 }}>
            {isImage ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="12" height="12" rx="1" />
                <circle cx="6" cy="6" r="1.5" />
                <path d="M14 10l-3-3-5 5" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 2H5a1 1 0 00-1 1v10a1 1 0 001 1h6a1 1 0 001-1V5L9 2z" />
                <polyline points="9,2 9,5 12,5" />
              </svg>
            )}
          </span>
          <span
            style={{
              color: 'var(--text-primary)',
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {fileName}
          </span>
          {externalChange && (
            <span style={{ color: '#f59e0b', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3 }}>
              <IconWarning width={12} height={12} />
              {t('drawer.externallyModified')}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          {isText && (
            <>
              <button
                onClick={() => setMode('view')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 8px',
                  border: '1px solid',
                  borderColor: mode === 'view' ? 'var(--accent)' : 'var(--border-strong)',
                  borderRadius: 5,
                  background: mode === 'view' ? 'var(--accent-14)' : 'transparent',
                  color: mode === 'view' ? 'var(--accent)' : 'var(--text-muted)',
                  fontSize: 11,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
                }}
                onMouseEnter={(e) => {
                  if (mode !== 'view') {
                    e.currentTarget.style.borderColor = 'var(--accent)'
                    e.currentTarget.style.color = 'var(--accent-bright)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (mode !== 'view') {
                    e.currentTarget.style.borderColor = 'var(--border-strong)'
                    e.currentTarget.style.color = 'var(--text-muted)'
                  }
                }}
              >
                <IconEye width={12} height={12} />
                {t('drawer.preview')}
              </button>
              <button
                onClick={() => setMode('edit')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '3px 8px',
                  border: '1px solid',
                  borderColor: mode === 'edit' ? 'var(--accent)' : 'var(--border-strong)',
                  borderRadius: 5,
                  background: mode === 'edit' ? 'var(--accent-14)' : 'transparent',
                  color: mode === 'edit' ? 'var(--accent)' : 'var(--text-muted)',
                  fontSize: 11,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
                }}
                onMouseEnter={(e) => {
                  if (mode !== 'edit') {
                    e.currentTarget.style.borderColor = 'var(--accent)'
                    e.currentTarget.style.color = 'var(--accent-bright)'
                  }
                }}
                onMouseLeave={(e) => {
                  if (mode !== 'edit') {
                    e.currentTarget.style.borderColor = 'var(--border-strong)'
                    e.currentTarget.style.color = 'var(--text-muted)'
                  }
                }}
              >
                <IconEdit width={12} height={12} />
                {t('drawer.edit')}
              </button>
            </>
          )}
          <button
            onClick={handleClose}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              border: 'none',
              borderRadius: 5,
              background: 'transparent',
              color: 'var(--text-faint)',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = 'var(--danger)'
              e.currentTarget.style.background = 'var(--danger-12)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = 'var(--text-faint)'
              e.currentTarget.style.background = 'transparent'
            }}
            title={t('drawer.close')}
          >
            <IconX width={14} height={14} />
          </button>
        </div>
      </div>

      {/* Content area */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {!isSupported ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: 12,
              color: 'var(--text-faint)',
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
            }}
          >
            <span>{t('drawer.unsupportedPreview')}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{fileName}</span>
          </div>
        ) : loading ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              color: 'var(--text-faint)',
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
            }}
          >
            {t('drawer.loading')}
          </div>
        ) : error ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              gap: 12,
              color: 'var(--danger)',
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
            }}
          >
            <span>{error}</span>
            <button
              onClick={fetchContent}
              style={{
                padding: '4px 12px',
                border: '1px solid var(--border-strong)',
                borderRadius: 5,
                background: 'transparent',
                color: 'var(--accent)',
                fontSize: 12,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--accent)'
                e.currentTarget.style.background = 'var(--accent-10)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-strong)'
                e.currentTarget.style.background = 'transparent'
              }}
            >
              {t('drawer.retry')}
            </button>
          </div>
        ) : isImage ? (
          <FilePreview filePath={filePath} sessionId={sessionId} fileName={fileName} />
        ) : (
          <FileEditor
            content={mode === 'edit' ? editedContent : content}
            editable={mode === 'edit'}
            fileName={fileName}
            onChange={handleContentChange}
            onSave={handleSave}
          />
        )}
      </div>

      {/* Status bar */}
      {isText && !loading && !error && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 12px',
            height: 28,
            borderTop: '1px solid var(--border-subtle)',
            fontSize: 11,
            color: 'var(--text-faint)',
            fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
            flexShrink: 0,
          }}
        >
          <span>UTF-8 · {lineCount} lines · {byteSize} bytes</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {externalChange && mode === 'edit' && (
              <button
                onClick={handleReload}
                style={{
                  padding: '1px 6px',
                  border: '1px solid #f59e0b',
                  borderRadius: 3,
                  background: 'transparent',
                  color: '#f59e0b',
                  fontSize: 10,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(245,158,11,0.1)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent'
                }}
              >
                {t('drawer.reload')}
              </button>
            )}
            {saving ? (
              <span style={{ color: 'var(--text-muted)' }}>{t('drawer.saving')}</span>
            ) : saveMessage ? (
              <span style={{ color: 'var(--success)' }}>{saveMessage}</span>
            ) : modified ? (
              <span style={{ color: 'var(--accent)' }}>{t('drawer.modified')}</span>
            ) : null}
          </span>
        </div>
      )}
    </div>
  )
}
