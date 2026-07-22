import {
  useCallback,
  useEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type UIEvent,
} from 'react'

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
 * OverlayScroll — a thin, theme-aware native scrollbar wrapper.
 *
 * The native scrollbar is themed and stays interactive so it can be dragged
 * (the old overlay thumb was `pointer-events: none` and could not be dragged).
 * The gutter it reserves is part of the layout from first paint, so showing/
 * hiding it never reflows surrounding content; the thumb stays visually hidden
 * until the pointer enters or focus lands in the container, then themes in.
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

  const setScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as { current: HTMLDivElement | null }).current = node
    },
    [ref],
  )

  const handleScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      onScroll?.(e)
    },
    [onScroll],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      // no-op: native scrollbar reserves a stable gutter, no manual relayout
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

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
    </div>
  )
}
