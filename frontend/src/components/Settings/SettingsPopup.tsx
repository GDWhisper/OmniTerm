import { useEffect, useRef, useState, useCallback } from 'react'
import { useAppStore } from '../../stores/appStore'
import { Settings } from './Settings'
import { GAP, MOBILE_NAV_HEIGHT, SIDEBAR_BOTTOM_BAR_HEIGHT, MOBILE_STATUS_BAR_RESERVE } from '../constants/popup'

const POPUP_WIDTH = 340

export function SettingsPopup() {
  const ref = useRef<HTMLDivElement>(null)
  const toggleSettings = useAppStore((s) => s.toggleSettings)
  const isMobile = useAppStore((s) => s.isMobile)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number }>({ left: 0 })

  // Mobile height constants — computed once so outer & inner stay in sync
  const mobileBottom = MOBILE_NAV_HEIGHT + SIDEBAR_BOTTOM_BAR_HEIGHT
  const mobileTotal = mobileBottom + MOBILE_STATUS_BAR_RESERVE

  // Calculate position based on gear button's bounding rect
  const calcPos = useCallback(() => {
    const btn = document.querySelector('[data-toggle="settings"]') as HTMLElement | null
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const vw = window.innerWidth
    const bottom = window.innerHeight - rect.top + GAP

    // Prefer left-align to button; if popup overflows right edge, right-align instead
    let left = rect.left
    if (left + POPUP_WIDTH + GAP > vw) {
      left = vw - POPUP_WIDTH - GAP
    }
    // Clamp left edge
    left = Math.max(GAP, left)

    setPos({ bottom, left })
  }, [])

  // Recalculate on open
  useEffect(() => {
    calcPos()
  }, [calcPos])

  // Viewport boundary protection: if popup would overflow top, flip to below
  useEffect(() => {
    if (!ref.current) return
    const el = ref.current
    const popupRect = el.getBoundingClientRect()
    if (popupRect.top < 0) {
      // Flip: show below the button instead
      const btn = document.querySelector('[data-toggle="settings"]') as HTMLElement | null
      if (btn) {
        const rect = btn.getBoundingClientRect()
        const vw = window.innerWidth
        let left = rect.left
        if (left + POPUP_WIDTH + GAP > vw) left = vw - POPUP_WIDTH - GAP
        left = Math.max(GAP, left)
        setPos({ top: rect.bottom + GAP, left })
      }
    }
  }, [pos])

  // Click outside to close (ignore clicks on the gear toggle button)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (ref.current && !ref.current.contains(target) && !target.closest('[data-toggle="settings"]')) {
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

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className="settings-popup"
      style={{
        position: 'fixed',
        // Mobile: bottom sheet above MobileNav; Desktop: positioned popup
        ...(isMobile
          ? {
              left: 0,
              right: 0,
              bottom: mobileBottom,
              height: `calc(100dvh - ${mobileTotal}px)`,
              maxHeight: `calc(100dvh - ${mobileTotal}px)`,
              borderRadius: 16,
              overflow: 'hidden',
            }
          : {
              ...pos,
              maxHeight: 'calc(100dvh - 16px)',
              borderRadius: 10,
              overflowY: 'auto',
              overflowX: 'hidden',
              padding: 4,
            }),
        width: isMobile ? '100%' : POPUP_WIDTH,
        zIndex: 50,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderWidth: isMobile ? '2px' : '1px',
        borderColor: isMobile ? 'var(--accent)' : 'var(--border-strong)',
        boxShadow: '0 20px 50px rgba(0,0,0,0.7)',
        WebkitOverflowScrolling: 'touch',
        animation: 'settings-slide-in 150ms ease-out',
      }}
    >
      {isMobile ? (
        <div style={{ height: '100%', overflowY: 'auto', padding: 4, WebkitOverflowScrolling: 'touch' }}>
          <Settings />
        </div>
      ) : (
        <Settings />
      )}
    </div>
  )
}
