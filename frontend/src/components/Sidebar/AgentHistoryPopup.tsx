import { useTranslation } from 'react-i18next'
import { useAppStore } from '../../stores/appStore'
import { AgentHistory } from './AgentHistory'
import { MOBILE_NAV_HEIGHT, SIDEBAR_BOTTOM_BAR_HEIGHT, MOBILE_STATUS_BAR_RESERVE } from '../constants/popup'
import { useAnchorPopup } from '../../hooks/useAnchorPopup'
import { OverlayScroll } from '../Common/OverlayScroll'

const POPUP_WIDTH = 380

/** 「Agent 历史」弹出面板（sidebar-popup 约定，见 frontend-patterns.md）。 */
export function AgentHistoryPopup() {
  const { t } = useTranslation()
  const { ref, pos, isMobile } = useAnchorPopup({
    toggleSelector: '[data-toggle="agent-history"]',
    topAnchorSelector: '.logo-title-bar',
    width: POPUP_WIDTH,
    onClose: useAppStore((s) => s.toggleAgentHistory),
  })

  const mobileBottom = MOBILE_NAV_HEIGHT + SIDEBAR_BOTTOM_BAR_HEIGHT
  const mobileTotal = mobileBottom + MOBILE_STATUS_BAR_RESERVE

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className="agent-history-popup pixel-float"
      style={{
        position: 'fixed',
        display: 'flex',
        flexDirection: 'column',
        ...(isMobile
          ? {
              left: 0,
              right: 0,
              bottom: mobileBottom,
              height: `calc(100dvh - ${mobileTotal}px)`,
              maxHeight: `calc(100dvh - ${mobileTotal}px)`,
              borderColor: 'var(--accent)',
              overflow: 'hidden',
            }
          : {
              left: pos.left,
              maxHeight: pos.maxHeight,
              top: pos.top,
              bottom: pos.bottom,
              overflow: 'hidden',
            }),
        width: isMobile ? '100%' : POPUP_WIDTH,
        zIndex: 50,
        background: 'var(--bg-elevated)',
        borderRadius: 2,
        animation: 'settings-slide-in 150ms ease-out',
      }}
    >
      <div className="panel-title-bar">
        <span>◆</span>
        <span>{t('agentHistory.title')}</span>
      </div>
      <OverlayScroll style={{ flex: 1, minHeight: 0 }}>
        <AgentHistory />
      </OverlayScroll>
    </div>
  )
}
