import { useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { READER_FONT } from '../../utils/fonts'
import { useAnchorPopup } from '../../hooks/useAnchorPopup'
import { hapticTap } from '../../utils/haptics'
import { IconFile, IconPhoto } from '../FileManager/icons'
import { MOBILE_NAV_HEIGHT, MOBILE_STATUS_BAR_RESERVE } from '../constants/popup'

/** 桌面浮层宽度：容纳「图标 + 主副文案」两行卡片。 */
const DRAWER_WIDTH = 280
/** 卡片最小高度：满足移动端触控目标下限。 */
const CARD_MIN_HEIGHT = 52

interface ChatAttachDrawerProps {
  onClose: () => void
  /** 选择「相册」——由 ChatInput 触发隐藏的 image input。 */
  onSelectAlbum: () => void
  /** 选择「文件」——由 ChatInput 触发隐藏的 file input。 */
  onSelectFile: () => void
  /** `promptCapabilities.image`；false = 相册卡片置灰。 */
  albumSupported: boolean
  /** `promptCapabilities.embeddedContext`；false = 文件卡片置灰。 */
  fileSupported: boolean
}

/**
 * 输入框「+」按钮的附件抽屉：相册 / 文件两张卡片。
 *
 * 必须 portal 到 body：移动端聊天面板位于带 `will-change: transform` 的 300%
 * strip 内，`position: fixed` 会以该 strip 为包含块而错位（同 Modal.tsx 注释）。
 *
 * 形态：移动端贴 MobileNav 上方的 bottom sheet（复用 sidebar popup 的
 * bottom-sheet 定位常量与视觉骨架）；桌面端锚定「+」按钮上方的浮层。
 */
export function ChatAttachDrawer({
  onClose,
  onSelectAlbum,
  onSelectFile,
  albumSupported,
  fileSupported,
}: ChatAttachDrawerProps) {
  const { t } = useTranslation()
  const { ref, pos, isMobile } = useAnchorPopup({
    toggleSelector: '[data-toggle="chat-attach"]',
    width: DRAWER_WIDTH,
    onClose,
  })

  // 选择即关闭（系统 picker 接管后抽屉不应留在屏幕上），关闭前给一次触感反馈。
  const pick = useCallback(
    (action: () => void) => {
      hapticTap()
      onClose()
      action()
    },
    [onClose],
  )

  return createPortal(
    <div
      ref={ref}
      className="pixel-float"
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 50,
        background: 'var(--bg-elevated)',
        borderRadius: 2,
        overflow: 'hidden',
        animation: 'settings-slide-in 150ms ease-out',
        ...(isMobile
          ? {
              left: 0,
              right: 0,
              bottom: `calc(${MOBILE_NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
              maxHeight: `calc(100dvh - ${MOBILE_NAV_HEIGHT + MOBILE_STATUS_BAR_RESERVE}px - env(safe-area-inset-bottom, 0px))`,
            }
          : {
              left: pos.left,
              width: DRAWER_WIDTH,
              ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
              maxHeight: pos.maxHeight,
            }),
      }}
    >
      <div className="panel-title-bar">
        <span>◆</span>
        <span>{t('chat.input.attachTitle')}</span>
      </div>
      <AttachCard
        icon={<IconPhoto width={20} height={20} />}
        label={t('chat.input.attachAlbum')}
        hint={
          albumSupported
            ? t('chat.input.attachAlbumHint')
            : t('chat.input.attachAlbumUnsupported')
        }
        disabled={!albumSupported}
        onClick={() => pick(onSelectAlbum)}
      />
      <AttachCard
        divider
        icon={<IconFile width={20} height={20} />}
        label={t('chat.input.attachFile')}
        hint={
          fileSupported ? t('chat.input.attachFileHint') : t('chat.input.attachFileUnsupported')
        }
        disabled={!fileSupported}
        onClick={() => pick(onSelectFile)}
      />
    </div>,
    document.body,
  )
}

interface AttachCardProps {
  icon: ReactNode
  label: string
  /** 副文案：支持时是功能说明，不支持时替换为原因。 */
  hint: string
  disabled: boolean
  onClick: () => void
  /** 与上一行之间的分隔线（首行不加，避免与标题条边框重叠）。 */
  divider?: boolean
}

function AttachCard({ icon, label, hint, disabled, onClick, divider }: AttachCardProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={hint}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        minHeight: CARD_MIN_HEIGHT,
        padding: '8px 12px',
        background: 'transparent',
        border: 'none',
        borderTop: divider ? '1px solid var(--border-subtle)' : 'none',
        fontFamily: READER_FONT,
        textAlign: 'left',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        color: disabled ? 'var(--text-faint)' : 'var(--text-primary)',
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = 'var(--bg-surface)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
      }}
    >
      <span
        style={{
          display: 'flex',
          flexShrink: 0,
          color: disabled ? 'var(--text-faint)' : 'var(--accent)',
        }}
      >
        {icon}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.02em' }}>{label}</span>
        <span
          style={{
            fontSize: 11,
            color: 'var(--text-faint)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {hint}
        </span>
      </span>
    </button>
  )
}
