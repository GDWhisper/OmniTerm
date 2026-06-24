import { useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { Settings } from './Settings'

const STATUS_BAR_H = 50 // px — matches Sidebar bottom status bar height

export function SettingsPopup() {
  const ref = useRef<HTMLDivElement>(null)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSettings = useAppStore((s) => s.toggleSettings)

  // Click outside to close
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        toggleSettings()
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [toggleSettings])

  // Escape to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleSettings()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [toggleSettings])

  const expanded = !sidebarCollapsed

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className="settings-popup"
      style={{
        position: 'absolute',
        ...(expanded
          ? {
              bottom: STATUS_BAR_H,
              left: 0,
              width: '100%',
              maxHeight: `calc(100% - ${STATUS_BAR_H}px - 8px)`,
            }
          : {
              bottom: 0,
              left: '100%',
              width: 280,
              maxHeight: 400,
            }),
        zIndex: 50,
        background: '#0f1729',
        border: '1px solid #1e293b',
        borderRadius: 8,
        boxShadow: '0 -4px 20px rgba(0,0,0,0.5)',
        overflowY: 'auto',
        animation: 'settings-slide-in 150ms ease-out',
      }}
    >
      <Settings />
    </div>
  )
}
