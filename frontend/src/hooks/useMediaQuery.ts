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
  const [vvHeight, setVvHeight] = useState(window.visualViewport?.height ?? window.innerHeight)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const update = () => setVvHeight(vv.height)

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

  return { vvHeight }
}

export function useIsLandscape() {
  const [landscape, setLandscape] = useState(
    () => window.matchMedia('(orientation: landscape)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape)')
    const handler = (e: MediaQueryListEvent | MediaQueryList) => setLandscape(e.matches)
    handler(mq)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return landscape
}
