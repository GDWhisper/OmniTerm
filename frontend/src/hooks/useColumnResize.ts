import { useEffect, useRef, useState, useCallback } from 'react'

export type ColName = string

interface UseColumnResizeOptions<C extends ColName> {
  /** Initial column widths in px */
  initial: Record<C, number>
  /** Minimum column width in px */
  minWidth?: number
}

/** Hook for table column resize by dragging handles on `<th>` headers.
 *
 *  Returns `colRefs` to attach to `<col>` elements, `colWidths` (React state) for
 *  rendering, and `handleResizeStart` to wire to the drag handle's onMouseDown.
 *  Column widths are written directly to the DOM during drag (60fps), then synced
 *  to React state on mouseup.
 */
export function useColumnResize<C extends ColName>({
  initial,
  minWidth = 80,
}: UseColumnResizeOptions<C>) {
  const [colWidths, setColWidths] = useState<Record<C, number>>(initial)

  const colRefs = useRef<Record<string, HTMLTableColElement | null>>({})
  const resizingRef = useRef<{ col: C; startX: number; startW: number } | null>(null)

  useEffect(() => {
    const onMove = (e: MouseEvent | TouchEvent) => {
      const r = resizingRef.current
      if (!r) return
      e.preventDefault()
      const mvX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const delta = mvX - r.startX
      const newW = Math.max(minWidth, r.startW + delta)
      const colEl = colRefs.current[r.col]
      if (colEl) {
        colEl.style.width = `${newW}px`
        r.startW = newW
      }
    }
    const onUp = () => {
      const r = resizingRef.current
      if (!r) return
      setColWidths((prev) => ({ ...prev, [r.col]: r.startW } as Record<C, number>))
      resizingRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onUp)
    }
  }, [minWidth])

  const handleResizeStart = useCallback(
    (col: C, e: React.MouseEvent | React.TouchEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
      const startW = colWidths[col]
      resizingRef.current = { col, startX: clientX, startW }
    },
    [colWidths],
  )

  return { colRefs, colWidths, handleResizeStart }
}
