import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { PopoverAnchor, PopoverAnchorRect } from '../../utils/popover'
import { PixelButton } from '../PixelUI/PixelButton'
import { useConfirmCheckbox, type ConfirmCheckbox } from '../../hooks/useConfirmCheckbox'
import { ConfirmCheckboxRow } from './ConfirmCheckbox'
import { OverlayScroll } from './OverlayScroll'

/** Preferred bubble width; clamped to the viewport on narrow screens. */
const POPOVER_WIDTH = 320
const VIEWPORT_MARGIN = 8
/** Gap between the trigger button and the bubble. */
const TRIGGER_GAP = 6

interface PopoverPosition {
  top: number
  left: number
  maxHeight: number
}

function pointInRect(rect: PopoverAnchorRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}

/**
 * 锚定确认气泡（PopoverConfirm）——单条目标的行内二次确认。
 *
 * 与 `ConfirmDialog` 的区别是**没有遮罩、不打断上下文**：气泡贴着触发按钮
 * 弹出，点外部 / Esc / 滚动 / 窗口尺寸变化即关闭，焦点进入气泡（取消按钮
 * 可通过 Tab 到达，避免误按 Enter 直接删除）。批量与不可逆的大动作仍用
 * Modal 版确认（见 frontend-patterns「锚定确认气泡」）。
 *
 * 定位用触发元素在点击时的视口矩形快照（`PopoverAnchor.rect`），不持有
 * 触发元素的 DOM 引用：列表轮询重渲染时按钮节点可能被替换，但气泡仍按旧
 * 位置显示一拍，不会把确认投向错误目标。滚动关闭只监听触发元素当时所在的
 * 滚动容器（`PopoverAnchor.scrollRoot`），后台聊天/终端自动滚动不会误关。
 * 气泡优先出现在按钮下方，下方放不下再翻到上方；水平方向右对齐按钮并
 * clamp 在视口内。
 */
export function PopoverConfirm(props: {
  open: boolean
  /** 触发按钮的点击时快照 + 其滚动祖先（见 utils/popover.ts）。 */
  anchor: PopoverAnchor | null
  title: string
  message: string
  confirmText?: string
  destructive?: boolean
  checkbox?: ConfirmCheckbox
  /** 确认回调；参数为复选框勾选状态（无复选框时恒 false）。 */
  onConfirm: (checked: boolean) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const { open, anchor, checkbox, onClose } = props
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<PopoverPosition | null>(null)
  const { checked, setChecked } = useConfirmCheckbox(open, checkbox)
  const titleId = useId()
  const messageId = useId()

  // 先量内容高度再定位：下方放得下优先放下方，否则翻上方；两侧都放不下时
  // 取空间大的一侧并把内容区限高滚动（OverlayScroll）。
  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPos(null)
      return
    }
    const el = ref.current
    if (!el) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const width = Math.min(POPOVER_WIDTH, vw - VIEWPORT_MARGIN * 2)
    const height = el.offsetHeight
    const rect = anchor.rect
    const spaceBelow = Math.max(0, vh - rect.bottom - VIEWPORT_MARGIN - TRIGGER_GAP)
    const spaceAbove = Math.max(0, rect.top - VIEWPORT_MARGIN - TRIGGER_GAP)
    const fitsBelow = height <= spaceBelow
    const fitsAbove = height <= spaceAbove
    const placeBelow = fitsBelow || (!fitsAbove && spaceBelow >= spaceAbove)
    const available = placeBelow ? spaceBelow : spaceAbove
    const renderedHeight = Math.min(height, available)
    const top = placeBelow
      ? rect.bottom + TRIGGER_GAP
      : rect.top - TRIGGER_GAP - renderedHeight
    let left = rect.right - width
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - width - VIEWPORT_MARGIN))
    setPos({ top, left, maxHeight: available })
    // title/message/checkbox 变化会改变高度；anchor 变化（同一行重新打开）要重算。
  }, [open, anchor, props.title, props.message, checkbox?.label, checkbox?.hint, checkbox?.disabled])

  // 焦点进入气泡（容器可聚焦），关闭时尽量还给触发按钮。焦点移动用
  // preventScroll，避免打开瞬间触发滚动而命中下面的 scroll 关闭逻辑。
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ref.current?.focus({ preventScroll: true })
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open])

  // 点外部 / Esc / 滚动 / resize 关闭。锚点矩形内视为触发按钮本身——按下
  // 同一按钮不再先关后开（否则会是「关闭又弹出」的闪动）。
  useEffect(() => {
    if (!open || !anchor) return
    const onDown = (e: MouseEvent) => {
      const target = e.target
      if (target instanceof Node && ref.current?.contains(target)) return
      if (pointInRect(anchor.rect, e.clientX, e.clientY)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onScroll = (e: Event) => {
      // window 级滚动事件的 target 是 window（不是 Node），别直接把它塞给 contains
      const target = e.target
      if (target instanceof Node && ref.current?.contains(target)) return
      onClose()
    }
    const onResize = () => onClose()
    const scrollRoot = anchor.scrollRoot
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    scrollRoot.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      scrollRoot.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [open, anchor, onClose])

  if (!open || !anchor) return null

  const width =
    typeof window === 'undefined'
      ? POPOVER_WIDTH
      : Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)

  return createPortal(
    <div
      ref={ref}
      className="popover-confirm pixel-float"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      tabIndex={-1}
      style={{
        width,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        maxHeight: pos?.maxHeight,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <OverlayScroll
        style={{ flex: '1 1 auto', minHeight: 0 }}
        contentStyle={{ flex: '0 0 auto' }}
      >
        <div className="popover-confirm-content">
          <div id={titleId} className="popover-confirm-title">
            <span
              aria-hidden="true"
              style={{ color: props.destructive ? 'var(--danger)' : 'var(--accent)' }}
            >
              ◆
            </span>
            <span>{props.title}</span>
          </div>
          <p id={messageId} className="popover-confirm-message">{props.message}</p>
          {checkbox && (
            <div className="popover-confirm-checkbox">
              <ConfirmCheckboxRow checkbox={checkbox} checked={checked} onChange={setChecked} />
            </div>
          )}
        </div>
      </OverlayScroll>
      <div className="popover-confirm-actions">
        <PixelButton variant="secondary" onClick={onClose}>
          {t('modal.cancel')}
        </PixelButton>
        <PixelButton
          variant={props.destructive ? 'danger' : 'primary'}
          onClick={() => props.onConfirm(checked)}
        >
          {props.confirmText ?? t('modal.confirm')}
        </PixelButton>
      </div>
    </div>,
    document.body,
  )
}
