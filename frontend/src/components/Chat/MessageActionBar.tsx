import { createPortal } from 'react-dom'
import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react'
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
/** 浮层与按钮的垂直间距（px）。 */
const FLOAT_GAP = 4

/**
 * 气泡动作条（D2/D3）。桌面端渲染为 hover 动作条（`.chat-msg-actions`，
 * CSS 控制显隐）；移动端经 useLongPress 触发渲染为 portal 浮动菜单。
 * 两套形态共用 `actions` 数组（动作唯一真源在 `messageActions.ts`）。
 *
 * 桌面浮层定位（label 文字）运行时测量：优先显示在图标**下方**；下方空间
 * 不足（如消息贴近滚动容器底部）则翻转到上方。水平方向 clamp 到视口内，
 * 避免 user 消息（右对齐）靠右按钮的浮层溢出右缘。
 */
export function MessageActionBar({ actions, ctx, menu, onCloseMenu }: MessageActionBarProps) {
  const { t } = useTranslation()
  // 当前 hover 按钮的浮层布局：下方 / 上方。仅桌面动作条用。
  const [floatDir, setFloatDir] = useState<'below' | 'above'>('below')
  const [floatLeft, setFloatLeft] = useState(0)

  const handleBtnEnter = useCallback(
    (e: ReactMouseEvent<HTMLButtonElement>) => {
      const btn = e.currentTarget
      const rect = btn.getBoundingClientRect()
      // 浮层实际尺寸：span 常驻 DOM（仅 opacity 切换），可直接测量，避免
      // 用估算阈值——下方空间略大于 0 但放不下浮层时仍应翻转。
      const label = btn.querySelector('span')
      const floatH = label ? label.offsetHeight : 0
      const floatW = label ? label.offsetWidth : 0
      // 向上找最近滚动容器：浮层 absolute 定位会被其 overflow 裁剪，
      // 可用空间以容器边界为准（聊天气泡列表即 `.overlay-scroll-content`）。
      let container: HTMLElement | null = btn.parentElement
      while (container && container !== document.body) {
        const cs = window.getComputedStyle(container)
        if (/(auto|scroll)/.test(cs.overflowY)) break
        container = container.parentElement
      }
      const cRect = container ? container.getBoundingClientRect() : { top: 0, bottom: window.innerHeight }
      const spaceBelow = cRect.bottom - rect.bottom
      // 优先下方；下方容不下浮层（贴滚动容器底）则翻转上方
      setFloatDir(spaceBelow >= floatH + FLOAT_GAP ? 'below' : 'above')
      // 水平 clamp：浮层左缘对齐按钮左缘，超出视口右缘时右缩
      const maxLeft = window.innerWidth - floatW - FLOAT_GAP
      const left = Math.min(rect.left, maxLeft)
      setFloatLeft(Math.max(FLOAT_GAP, left) - rect.left)
    },
    [],
  )

  if (actions.length === 0) return null

  return (
    <>
      <div className="chat-msg-actions" style={{ marginTop: 2 }}>
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="chat-msg-action-btn"
            // 功能文字用自定义浮层（hover 图标时显示），aria-label 保留可访问性，
            // 不设 title 避免与浮层双重 tooltip
            aria-label={t(action.labelKey)}
            onMouseEnter={handleBtnEnter}
            onClick={() => {
              action.run(ctx)
              onCloseMenu()
            }}
          >
            <action.Icon {...ACTION_ICON_SIZE} style={{ verticalAlign: 'text-bottom' }} />
            {/* 布局方向与水平偏移由 hover 时测量决定；不参与布局（absolute），
                文字出现不挤动其他图标。 */}
            <span data-dir={floatDir} style={{ left: floatLeft }}>{t(action.labelKey)}</span>
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
