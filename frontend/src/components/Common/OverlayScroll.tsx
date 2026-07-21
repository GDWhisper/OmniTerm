import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type UIEvent,
} from 'react'

const HIDE_DELAY_MS = 900
const THUMB_MIN_HEIGHT = 24

interface OverlayScrollProps {
  children: ReactNode
  /** Ref to the inner scrollable element (for imperative scrolling). */
  ref?: Ref<HTMLDivElement>
  /** Layout + visual styles for the outer positioning box (flex, maxHeight, background…). */
  style?: CSSProperties
  className?: string
  /** Sizing + content-layout styles for the inner scrollable element. */
  contentStyle?: CSSProperties
  contentClassName?: string
  onScroll?: (e: UIEvent<HTMLDivElement>) => void
}

/**
 * OverlayScroll — scroll container with a theme-aware overlay scrollbar.
 *
 * The native scrollbar is hidden and replaced by a thin thumb drawn over the
 * content's right edge. The thumb fades in when scrolling starts and fades
 * out after a short idle period. Because it overlays the content instead of
 * reserving a native gutter, revealing it never reflows the layout.
 *
 * The outer box is a `position: relative; overflow: hidden` flex column; give
 * it a size via `style` (e.g. `flex: 1` in a flex parent, or `maxHeight` for a
 * menu). The inner scroll element is a `flex: 1; min-height: 0` item, so it
 * fills a sized box and scrolls. For shrink-to-fit menus, override with
 * `contentStyle={{ flex: '0 0 auto', maxHeight: … }}`.
 */
export function OverlayScroll({
  children,
  ref,
  style,
  className,
  contentStyle,
  contentClassName,
  onScroll,
}: OverlayScrollProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const thumbRef = useRef<HTMLDivElement | null>(null)
  const hideTimer = useRef<number | undefined>(undefined)
  const hasOverflow = useRef(false)

  const setScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as { current: HTMLDivElement | null }).current = node
    },
    [ref],
  )

  const layoutThumb = useCallback(() => {
    const el = scrollRef.current
    const thumb = thumbRef.current
    if (!el || !thumb) return
    const { scrollTop, scrollHeight, clientHeight } = el
    if (scrollHeight <= clientHeight + 1) {
      hasOverflow.current = false
      thumb.style.opacity = '0'
      return
    }
    hasOverflow.current = true
    const ratio = clientHeight / scrollHeight
    const height = Math.max(THUMB_MIN_HEIGHT, clientHeight * ratio)
    const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height)
    thumb.style.height = `${height}px`
    thumb.style.transform = `translateY(${top}px)`
  }, [])

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      onScroll?.(e)
      layoutThumb()
      const thumb = thumbRef.current
      if (!thumb || !hasOverflow.current) return
      thumb.style.opacity = '1'
      if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current)
      hideTimer.current = window.setTimeout(() => {
        thumb.style.opacity = '0'
      }, HIDE_DELAY_MS)
    },
    [onScroll, layoutThumb],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    layoutThumb()
    const observer = new ResizeObserver(() => layoutThumb())
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (hideTimer.current !== undefined) window.clearTimeout(hideTimer.current)
    }
  }, [layoutThumb])

  return (
    <div
      className={className}
      style={{ position: 'relative', overflow: 'hidden', display: 'flex', flexDirection: 'column', ...style }}
    >
      <div
        ref={setScrollRef}
        onScroll={handleScroll}
        className={contentClassName ? `overlay-scroll-content ${contentClassName}` : 'overlay-scroll-content'}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', ...contentStyle }}
      >
        {children}
      </div>
      <div ref={thumbRef} className="overlay-scroll-thumb" aria-hidden="true" />
    </div>
  )
}
