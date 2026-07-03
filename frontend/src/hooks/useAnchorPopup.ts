import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useAppStore } from '../stores/appStore'
import { GAP } from '../components/constants/popup'

export interface AnchorPopupPos {
  /** Distance from viewport top to popup top edge (px). */
  top: number
  /** Distance from viewport left to popup left edge (px). */
  left: number
  /** Max height the popup is allowed to render (px), so it never overflows the viewport. */
  maxHeight: number
}

export interface UseAnchorPopupOptions {
  /** CSS selector for the trigger button. The outside-click handler ignores clicks on it. */
  toggleSelector: string
  /** Popup width in pixels. Used for horizontal clamping. */
  width: number
  /** Callback to close the popup. */
  onClose: () => void
  /**
   * Minimum vertical space required above the button to prefer "above" placement.
   * If the space above is less than this, the popup flips below the button.
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
 * Computes space above and below the button in a single pass, picks the better side,
 * and clamps the max-height so the popup never overflows the viewport top or bottom.
 * Re-runs on window resize and on mount.
 *
 * Also wires up outside-click and Escape-to-close handlers. The consumer just needs
 * to attach the returned `ref` to the popup root and render it.
 */
export function useAnchorPopup({
  toggleSelector,
  width,
  onClose,
  minSpaceAbove = DEFAULT_MIN_SPACE_ABOVE,
}: UseAnchorPopupOptions): UseAnchorPopupResult {
  const ref = useRef<HTMLDivElement>(null)
  const isMobile = useAppStore((s) => s.isMobile)
  const [pos, setPos] = useState<AnchorPopupPos>({ top: GAP, left: GAP, maxHeight: 0 })

  const calcPos = useCallback(() => {
    if (typeof window === 'undefined') return
    const btn = document.querySelector(toggleSelector) as HTMLElement | null
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    // Available vertical space above and below the button.
    const spaceAbove = Math.max(0, rect.top - GAP)
    const spaceBelow = Math.max(0, vh - rect.bottom - GAP)

    // Prefer "above" (anchored to top of viewport with GAP); flip to "below" only if
    // above-space is too small for usable content.
    const useBelow = spaceAbove < minSpaceAbove
    const top = useBelow ? rect.bottom + GAP : GAP
    const maxHeight = useBelow ? spaceBelow : spaceAbove

    // Horizontal: align left to button, clamp to viewport edges.
    let left = rect.left
    if (left + width + GAP > vw) left = vw - width - GAP
    left = Math.max(GAP, left)

    setPos({ top, left, maxHeight })
  }, [toggleSelector, width, minSpaceAbove])

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
