import { useEffect, useRef, useState, useCallback } from 'react'
import { useAppStore } from '../../stores/appStore'
import { TmuxCheatsheet } from './TmuxCheatsheet'

const POPUP_WIDTH = 360
const GAP = 8

export function TmuxCheatsheetPopup() {
  const ref = useRef<HTMLDivElement>(null)
  const toggleTmuxCheatsheet = useAppStore((s) => s.toggleTmuxCheatsheet)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number }>({ left: 0 })

  const calcPos = useCallback(() => {
    const btn = document.querySelector('[data-toggle="tmux-cheatsheet"]') as HTMLElement | null
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const vw = window.innerWidth
    const bottom = window.innerHeight - rect.top + GAP

    let left = rect.left
    if (left + POPUP_WIDTH + GAP > vw) {
      left = vw - POPUP_WIDTH - GAP
    }
    left = Math.max(GAP, left)

    setPos({ bottom, left })
  }, [])

  useEffect(() => {
    calcPos()
  }, [calcPos])

  useEffect(() => {
    if (!ref.current) return
    const popupRect = ref.current.getBoundingClientRect()
    if (popupRect.top < 0) {
      const btn = document.querySelector('[data-toggle="tmux-cheatsheet"]') as HTMLElement | null
      if (btn) {
        const rect = btn.getBoundingClientRect()
        const vw = window.innerWidth
        let left = rect.left
        if (left + POPUP_WIDTH + GAP > vw) left = vw - POPUP_WIDTH - GAP
        left = Math.max(GAP, left)
        setPos({ top: rect.bottom + GAP, left })
      }
    }
  }, [pos])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (
        ref.current &&
        !ref.current.contains(target) &&
        !target.closest('[data-toggle="tmux-cheatsheet"]')
      ) {
        toggleTmuxCheatsheet()
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [toggleTmuxCheatsheet])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleTmuxCheatsheet()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [toggleTmuxCheatsheet])

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className="tmux-cheatsheet-popup"
      style={{
        position: 'fixed',
        ...pos,
        width: POPUP_WIDTH,
        maxHeight: 'calc(100dvh - 16px)',
        zIndex: 50,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderRadius: 10,
        boxShadow: '0 20px 50px rgba(0,0,0,0.7)',
        overflowY: 'auto',
        animation: 'settings-slide-in 150ms ease-out',
      }}
    >
      <TmuxCheatsheet />
    </div>
  )
}
