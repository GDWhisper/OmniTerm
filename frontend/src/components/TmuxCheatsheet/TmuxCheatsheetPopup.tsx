import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { TmuxCheatsheet } from './TmuxCheatsheet'
import { MOBILE_NAV_HEIGHT, SIDEBAR_BOTTOM_BAR_HEIGHT, MOBILE_STATUS_BAR_RESERVE } from '../constants/popup'
import { useAnchorPopup } from '../../hooks/useAnchorPopup'

const POPUP_WIDTH = 360

export function TmuxCheatsheetPopup() {
  const { t } = useTranslation()
  const { ref, pos, isMobile } = useAnchorPopup({
    toggleSelector: '[data-toggle="tmux-cheatsheet"]',
    topAnchorSelector: '.logo-title-bar',
    width: POPUP_WIDTH,
    onClose: useAppStore((s) => s.toggleTmuxCheatsheet),
  })

  const mobileBottom = MOBILE_NAV_HEIGHT + SIDEBAR_BOTTOM_BAR_HEIGHT
  const mobileTotal = mobileBottom + MOBILE_STATUS_BAR_RESERVE

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className="tmux-cheatsheet-popup"
      style={{
        position: 'fixed',
        display: 'flex',
        flexDirection: 'column',
        // Mobile: bottom sheet above MobileNav + MobileStatusBar; Desktop: positioned popup
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
              maxHeight: pos.maxHeight,
              top: pos.top,
              bottom: pos.bottom,
              borderRadius: 10,
              overflow: 'hidden',
            }),
        width: isMobile ? '100%' : POPUP_WIDTH,
        zIndex: 50,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderWidth: isMobile ? '2px' : '1px',
        borderColor: isMobile ? 'var(--accent)' : 'var(--border-strong)',
        boxShadow: '0 20px 50px rgba(0,0,0,0.7)',
        animation: 'settings-slide-in 150ms ease-out',
      }}
    >
      <div className="panel-title-bar">
        <span>◆</span>
        <span>{t('tmuxCheatsheet.title')}</span>
      </div>
      <div
        className="tmux-cheatsheet-content themed-scrollbar"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}
      >
        <TmuxCheatsheet />
      </div>
    </div>
  )
}
