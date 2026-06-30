import { useEffect, useState } from 'react'
import { useAppStore } from '../stores/appStore'

export function useMobileDetection() {
  const setIsMobile = useAppStore((s) => s.setIsMobile)

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(e.matches)
    }

    handler(mq)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [setIsMobile])
}

export function useKeyboardHeight() {
  const [kbHeight, setKbHeight] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(window.innerHeight)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const update = () => {
      setViewportHeight(window.innerHeight)
      const rawKb = window.innerHeight - vv.height
      
      // 如果没有输入框聚焦，键盘一定已关闭
      const activeEl = document.activeElement
      const isInputFocused = activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        (activeEl as HTMLElement).isContentEditable
      )
      
      const kb = isInputFocused && rawKb > 50 ? rawKb : 0
      console.log('[Keyboard]', { 
        innerHeight: window.innerHeight, 
        vvHeight: vv.height, 
        rawKb, 
        kbHeight: kb,
        isInputFocused 
      })
      setKbHeight(kb)
    }

    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    update()

    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return { kbHeight, viewportHeight }
}
