import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { Settings } from './Settings'
import { MOBILE_NAV_HEIGHT, SIDEBAR_BOTTOM_BAR_HEIGHT, MOBILE_STATUS_BAR_RESERVE } from '../constants/popup'
import { useAnchorPopup } from '../../hooks/useAnchorPopup'

/** Desktop popup width = 1/4 of viewport (rendered as 25vw in CSS). */
const POPUP_WIDTH_RATIO = 0.25

export function SettingsPopup() {
  const { t } = useTranslation()
  // Track viewport width so useAnchorPopup can clamp horizontally to match the
  // popup's actual rendered width (which is 25vw in CSS).
  const [popupWidthPx, setPopupWidthPx] = useState(() =>
    Math.round(window.innerWidth * POPUP_WIDTH_RATIO),
  )
  useEffect(() => {
    const onResize = () => setPopupWidthPx(Math.round(window.innerWidth * POPUP_WIDTH_RATIO))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const { ref, pos, isMobile } = useAnchorPopup({
    toggleSelector: '[data-toggle="settings"]',
    topAnchorSelector: '.logo-title-bar',
    width: popupWidthPx,
    onClose: useAppStore((s) => s.toggleSettings),
  })

  // Mobile height constants — computed once so outer & inner stay in sync
  const mobileBottom = MOBILE_NAV_HEIGHT + SIDEBAR_BOTTOM_BAR_HEIGHT
  const mobileTotal = mobileBottom + MOBILE_STATUS_BAR_RESERVE

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className="settings-popup"
      style={{
        position: 'fixed',
        display: 'flex',
        flexDirection: 'column',
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
              left: pos.left,
              // Fixed-height desktop popup (1/3 of viewport). Right pane
              // (.settings-content) scrolls if its sections don't fit, so the
              // popup itself stays a stable size across tab switches.
              // maxHeight from useAnchorPopup is a safety cap when viewport is
              // too short for 33vh.
              height: '33vh',
              maxHeight: pos.maxHeight,
              top: pos.top,
              bottom: pos.bottom,
              borderRadius: 10,
              overflow: 'hidden',
            }),
        width: isMobile ? '100%' : `${POPUP_WIDTH_RATIO * 100}vw`,
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
      <div className="panel-title-bar">
        <span>◆</span>
        <span>{t('settings.title')}</span>
      </div>
      <Settings />
    </div>
  )
}
