import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useAppStore } from '../stores/appStore'
import { GAP } from '../components/constants/popup'

export interface AnchorPopupPos {
  /** Distance from viewport top to popup top edge (px). Set when popup sits below the button. */
  top?: number
  /** Distance from viewport bottom to popup bottom edge (px). Set when popup sits above the button. */
  bottom?: number
  /** Distance from viewport left to popup left edge (px). */
  left: number
  /**
   * Max height in pixels. The popup renders at content height by default and only
   * grows to this value if its content is taller. Use this to bound the popup
   * within the available space (e.g. between a top anchor and the trigger button).
   */
  maxHeight: number
}

export interface UseAnchorPopupOptions {
  /** CSS selector for the trigger button. The outside-click handler ignores clicks on it. */
  toggleSelector: string
  /**
   * Optional CSS selector for a top anchor element (e.g. sidebar logo title bar).
   * When provided:
   *   - The popup's BOTTOM edge sits just above the trigger button (visually near it).
   *   - The popup grows upward to fit its content; maxHeight is bounded so the
   *     popup's top can never go above this element + GAP.
   * When omitted, the popup prefers to appear above the button; if the space above
   * is less than `minSpaceAbove`, it flips below.
   */
  topAnchorSelector?: string
  /** Popup width in pixels. Used for horizontal clamping. */
  width: number
  /** Callback to close the popup. */
  onClose: () => void
  /**
   * Free-mode only: minimum vertical space required above the button to prefer
   * "above" placement. If the space above is less than this, the popup flips below.
   * Default 240px.
   */
  minSpaceAbove?: number
}

export interface UseAnchorPopupResult {
  ref: RefObject<HTMLDivElement | null>
  pos: AnchorPopupPos
  isMobile: boolean
}

const DEFAULT_MIN_SPACE_ABOVE = 240

/**
 * Positions a popup relative to a trigger button and keeps it inside the viewport.
 *
 * The popup's bottom edge is anchored just above the trigger button (visually
 * attached to it). The popup grows upward to fit its content; if the content
 * exceeds the available space, maxHeight caps it and the popup scrolls. With
 * `topAnchorSelector`, the available space is bounded above by that element so
 * the popup never overflows the top boundary (e.g. into the sidebar logo).
 *
 * Re-positions on window resize, and wires up outside-click and Escape-to-close
 * handlers automatically.
 */
export function useAnchorPopup({
  toggleSelector,
  topAnchorSelector,
  width,
  onClose,
  minSpaceAbove = DEFAULT_MIN_SPACE_ABOVE,
}: UseAnchorPopupOptions): UseAnchorPopupResult {
  const ref = useRef<HTMLDivElement>(null)
  const isMobile = useAppStore((s) => s.isMobile)
  // Default: popup anchored near the viewport bottom (where sidebar buttons live),
  // so the first render before calcPos doesn't flash at the wrong place.
  const [pos, setPos] = useState<AnchorPopupPos>({ bottom: GAP, left: GAP, maxHeight: 0 })

  const calcPos = useCallback(() => {
    if (typeof window === 'undefined') return
    const btn = document.querySelector(toggleSelector) as HTMLElement | null
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    // Horizontal: align left to button, clamp to viewport edges.
    let left = rect.left
    if (left + width + GAP > vw) left = vw - width - GAP
    left = Math.max(GAP, left)

    const topAnchorEl = topAnchorSelector
      ? (document.querySelector(topAnchorSelector) as HTMLElement | null)
      : null

    if (topAnchorEl) {
      // Anchored mode: popup bottom sits just above the button (visually near it).
      // Grows upward to fit content; maxHeight is bounded so the popup top can
      // never go above the top anchor.
      const topBoundary = topAnchorEl.getBoundingClientRect().bottom + GAP
      const popupBottomY = rect.top - GAP
      setPos({
        bottom: vh - popupBottomY,
        left,
        maxHeight: Math.max(0, popupBottomY - topBoundary),
      })
      return
    }

    // Free mode: prefer above the button (bottom-anchored), flip below if too small.
    const spaceAbove = Math.max(0, rect.top - GAP)
    const spaceBelow = Math.max(0, vh - rect.bottom - GAP)
    if (spaceAbove < minSpaceAbove) {
      setPos({ top: rect.bottom + GAP, left, maxHeight: spaceBelow })
    } else {
      setPos({ bottom: vh - rect.top + GAP, left, maxHeight: spaceAbove })
    }
  }, [toggleSelector, topAnchorSelector, width, minSpaceAbove])

  useEffect(() => {
    calcPos()
    window.addEventListener('resize', calcPos)
    return () => window.removeEventListener('resize', calcPos)
  }, [calcPos])

  // Click outside to close (ignore clicks on the trigger button).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (ref.current && !ref.current.contains(target) && !target.closest(toggleSelector)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose, toggleSelector])

  // Escape to close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return { ref, pos, isMobile }
}
