import { useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/appStore'
import { Settings } from './Settings'

// Status bar height: py-3 (24px) + content (~26px). Update if Sidebar status bar layout changes.
const STATUS_BAR_H = 50

export function SettingsPopup() {
  const ref = useRef<HTMLDivElement>(null)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSettings = useAppStore((s) => s.toggleSettings)

  // Click outside to close (ignore clicks on the gear toggle button)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (ref.current && !ref.current.contains(target) && !target.closest('[data-settings-toggle]')) {
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
        background: '#111827',
        border: '1px solid #334155',
        borderRadius: 10,
        boxShadow: '0 20px 50px rgba(0,0,0,0.7)',
        overflowY: 'auto',
        animation: 'settings-slide-in 150ms ease-out',
      }}
    >
      <Settings />
    </div>
  )
}
