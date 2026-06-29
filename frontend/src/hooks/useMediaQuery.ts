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

export function useVisualViewportHeight() {
  const [height, setHeight] = useState(() => {
    const vv = window.visualViewport
    if (!vv) return window.innerHeight
    // 使用 offsetTop 来计算键盘上方可见区域高度
    // 在 iOS 上，键盘弹出时 offsetTop 会增加
    return vv.height
  })

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const update = () => {
      // 直接使用 visualViewport.height - 这是键盘上方可见区域的高度
      // 同时用 window.innerHeight 作为上限，防止某些浏览器行为异常
      const newHeight = Math.min(vv.height, window.innerHeight)
      console.log('[Viewport] vv.height:', vv.height, 'innerHeight:', window.innerHeight, 'offsetTop:', vv.offsetTop, '-> using:', newHeight)
      setHeight(newHeight)
    }
    
    // 同时监听 visualViewport 和 window 的 resize 事件
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    
    update() // 初始化
    
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  return height
}
