import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface FilePreviewProps {
  /** Absolute file path (used to construct download URL) */
  filePath: string
  /** Session ID for API calls */
  sessionId: string
  /** File name for display */
  fileName: string
}

/**
 * Image preview component for the file drawer.
 * Displays images fetched via the download API endpoint.
 */
export function FilePreview({ filePath, sessionId, fileName }: FilePreviewProps) {
  const { t } = useTranslation()
  const [error, setError] = useState(false)

  // Build the image URL using the existing download endpoint
  const imageUrl = `/api/v1/files/download?session=${sessionId}&path=${encodeURIComponent(filePath)}`

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
          color: '#64748b',
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace",
        }}
      >
        <svg width="32" height="32" viewBox="0 0 16 16" fill="none" stroke="#475569" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="2" width="12" height="12" rx="1" />
          <circle cx="6" cy="6" r="1.5" />
          <path d="M14 10l-3-3-5 5" />
        </svg>
        <span>{t('preview.loadFailed')}</span>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{fileName}</span>
        <a
          href={imageUrl}
          download={fileName}
          style={{
            marginTop: 4,
            padding: '4px 12px',
            border: '1px solid #334155',
            borderRadius: 5,
            color: '#a78bfa',
            fontSize: 12,
            textDecoration: 'none',
            transition: 'all 0.15s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = '#a78bfa'
            e.currentTarget.style.background = 'rgba(167,139,250,0.1)'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = '#334155'
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
