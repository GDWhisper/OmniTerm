import { useEffect, useState } from 'react'

const MINUTE_MS = 60_000

type Listener = (now: number) => void
const listeners = new Set<Listener>()
let timer: ReturnType<typeof setInterval> | null = null

function notify() {
  const now = Date.now()
  for (const listener of listeners) listener(now)
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible') notify()
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  if (timer === null) {
    timer = setInterval(notify, MINUTE_MS)
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }
}

/**
 * 共享的分钟级时钟：所有会话行共用一个 interval，最后一行卸载即停。
 * 相对时间只精确到分钟，无需更高频率；页面恢复可见时补一拍
 * （隐藏期间浏览器会节流定时器，回来时不能等下一个整分钟）。
 */
export function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => subscribe(setNow), [])
  return now
}
