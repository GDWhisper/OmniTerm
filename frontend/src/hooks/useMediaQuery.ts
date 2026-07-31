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
  const [vvOffsetTop, setVvOffsetTop] = useState(window.visualViewport?.offsetTop ?? 0)

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const update = () => {
      setVvHeight(vv.height)
      // With the keyboard open the browser pans the *visual* viewport to
      // reveal the focused input (xterm pins its hidden textarea to the
      // cursor row, behind the keyboard in tmux mode). That pan is not a
      // window scroll — scrollTo can't undo it — so the layout must follow
      // offsetTop to stay aligned with the visible region.
      setVvOffsetTop(vv.offsetTop)
      // Mobile keyboards make the browser scroll the (unscrollable) document
      // to reveal the focused input; the offset survives keyboard dismissal
      // and leaves the fixed-height layout clipped at the bottom. The layout
      // already tracks vv.height, so any window scroll is pure residue.
      if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0)
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

  return { vvHeight, vvOffsetTop }
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
