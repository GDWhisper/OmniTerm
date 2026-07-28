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

  // Capture current uiZoom on mount so the popup keeps a stable size during
  // slider drag (content behind it previews the change in real time).
  const [localZoom] = useState(() => useAppStore.getState().uiZoom)
  const zoomRatio = localZoom / 100

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
      className="settings-popup pixel-float"
      style={{
        position: 'fixed',
        display: 'flex',
        flexDirection: 'column',
        zoom: zoomRatio,
        // Mobile: bottom sheet above MobileNav; Desktop: positioned popup
        ...(isMobile
          ? {
              left: 0,
              width: `calc(100vw / ${zoomRatio})`,
              bottom: mobileBottom,
              height: `calc((100dvh - ${mobileTotal}px) / ${zoomRatio})`,
              maxHeight: `calc((100dvh - ${mobileTotal}px) / ${zoomRatio})`,
              borderColor: 'var(--accent)',
              overflow: 'hidden',
            }
          : {
              left: pos.left,
              // Fixed-height desktop popup (1/3 of viewport). Right pane
              // (.settings-content) scrolls if its sections don't fit, so the
              // popup itself stays a stable size across tab switches.
              // maxHeight from useAnchorPopup is a safety cap when viewport is
              // too short for 33vh. Dimensions are divided by zoomRatio so the
              // visual (post-zoom) size matches the original intent.
              height: `calc(33vh / ${zoomRatio})`,
              maxHeight: pos.maxHeight / zoomRatio,
              top: pos.top,
              bottom: pos.bottom,
              overflow: 'hidden',
            }),
        width: isMobile ? undefined : `${POPUP_WIDTH_RATIO * 100 / zoomRatio}vw`,
        zIndex: 50,
        background: 'var(--bg-elevated)',
        borderRadius: 2,
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
