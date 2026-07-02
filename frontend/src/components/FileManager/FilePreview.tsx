import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

const REFRESH_DEBOUNCE_MS = 500

interface FilePreviewProps {
  /** Absolute file path (used to construct download URL) */
  filePath: string
  /** Session ID for API calls (session mode) */
  sessionId?: string
  /** Workspace ID for API calls (workspace mode) */
  workspaceId?: string
  /** Project ID — required with workspaceId */
  projectId?: string | null
  /** File name for display */
  fileName: string
  /** SSE file change event for auto-refresh */
  fileChangeEvent: { kind: string; path: string } | null
}

/**
 * Image preview component for the file drawer.
 * Displays images fetched via the download API endpoint.
 */
export function FilePreview({ filePath, sessionId, workspaceId, projectId, fileName, fileChangeEvent }: FilePreviewProps) {
  const { t } = useTranslation()
  const [error, setError] = useState(false)
  // Cache-bust version: incremented on external file change → browser bypasses cache
  const [version, setVersion] = useState(0)

  // Auto-refresh on SSE file change events (debounced)
  useEffect(() => {
    if (!fileChangeEvent) return
    if (fileChangeEvent.kind === 'delete') return
    // Match by basename (SSE event path is relative, filePath is absolute)
    const eventName = fileChangeEvent.path.split('/').pop()
    if (eventName !== fileName) return

    const timer = setTimeout(() => {
      setVersion((v) => v + 1)
      setError(false)
    }, REFRESH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [fileChangeEvent, fileName])

  // Build the image URL using the existing download endpoint
  const imageUrl = sessionId
    ? `/api/v1/files/download?session=${sessionId}&path=${encodeURIComponent(filePath)}&v=${version}`
    : `/api/v1/files/download?workspace_id=${workspaceId}&workspace=${projectId}&path=${encodeURIComponent(filePath)}&v=${version}`

  if (error) {
    return (
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
        <svg width="32" height="32" viewBox="0 0 16 16" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="12" height="12" rx="1" />
          <circle cx="6" cy="6" r="1.5" />
          <path d="M14 10l-3-3-5 5" />
        </svg>
        <span>{t('preview.loadFailed')}</span>
        <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{fileName}</span>
        <a
          href={imageUrl}
          download={fileName}
          style={{
            marginTop: 4,
            padding: '4px 12px',
            border: '1px solid var(--border-strong)',
            borderRadius: 5,
            color: 'var(--accent)',
            fontSize: 12,
            textDecoration: 'none',
            transition: 'all 0.15s ease',
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
          {t('preview.download')}
        </a>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        padding: 16,
        overflow: 'auto',
      }}
    >
      <img
        key={`${fileName}-${version}`}
        src={imageUrl}
        alt={fileName}
        onError={() => setError(true)}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          borderRadius: 4,
        }}
      />
    </div>
  )
}
