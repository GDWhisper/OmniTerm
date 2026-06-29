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
    // 处理两种情况：
    // 1. 页面未滚动（键盘未打开或不支持）：使用 visualViewport.height
    // 2. 页面滚动（键盘打开后页面自动滚动）：使用 window.innerHeight - offsetTop
    return vv.offsetTop > 0 ? window.innerHeight - vv.offsetTop : vv.height
  })

  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    const update = () => {
      // 当页面滚动时（offsetTop > 0），可见区域 = window.innerHeight - offsetTop
      // 当页面未滚动时（offsetTop = 0），可见区域 = visualViewport.height
      const newHeight = vv.offsetTop > 0 
        ? window.innerHeight - vv.offsetTop 
        : vv.height
      console.log('[Viewport] offsetTop:', vv.offsetTop, 'vv.height:', vv.height, 'innerHeight:', window.innerHeight, '-> using:', newHeight)
      setHeight(newHeight)
    }
    
    // 同时监听 visualViewport 和 window 的 resize/scroll 事件
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
