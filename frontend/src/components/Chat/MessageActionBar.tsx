import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { READER_FONT } from '../../utils/fonts'
import type { MessageAction, MessageActionContext } from './messageActions'

export interface ActionMenuPosition {
  x: number
  y: number
}

interface MessageActionBarProps {
  /** 已按 visible 过滤的动作（注册表里过滤，组件只渲染）。 */
  actions: MessageAction[]
  ctx: MessageActionContext
  /** 移动端长按菜单锚点；null 时不渲染菜单。 */
  menu: ActionMenuPosition | null
  /** 关闭菜单（遮罩点击 / 动作执行后）。 */
  onCloseMenu: () => void
}

const ACTION_ICON_SIZE = { width: 12, height: 12 }

/**
 * 气泡动作条（D2/D3）。桌面端渲染为 hover 动作条（`.chat-msg-actions`，
 * CSS 控制显隐）；移动端经 useLongPress 触发渲染为 portal 浮动菜单。
 * 两套形态共用 `actions` 数组（动作唯一真源在 `messageActions.ts`）。
 */
export function MessageActionBar({ actions, ctx, menu, onCloseMenu }: MessageActionBarProps) {
  const { t } = useTranslation()
  if (actions.length === 0) return null

  return (
    <>
      <div className="chat-msg-actions" style={{ marginTop: 2 }}>
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="chat-msg-action-btn"
            title={t(action.labelKey)}
            onClick={() => {
              action.run(ctx)
              onCloseMenu()
            }}
          >
            <action.Icon {...ACTION_ICON_SIZE} style={{ verticalAlign: 'text-bottom' }} />
            <span>{t(action.labelKey)}</span>
          </button>
        ))}
      </div>
      {menu &&
        createPortal(
          <>
            {/* 全屏遮罩：点击任意处关闭 */}
            <div
              style={{ position: 'fixed', inset: 0, zIndex: 199 }}
              onClick={onCloseMenu}
              onTouchStart={onCloseMenu}
            />
            <div
              className="pixel-float"
              style={{
                position: 'fixed',
                left: menu.x,
                top: menu.y,
                zIndex: 200,
                background: 'var(--bg-elevated)',
              }}
            >
              {actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => {
                    action.run(ctx)
                    onCloseMenu()
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '10px 18px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-primary)',
                    fontFamily: READER_FONT,
                    fontSize: 13,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <action.Icon {...ACTION_ICON_SIZE} />
                  <span>{t(action.labelKey)}</span>
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  )
}
