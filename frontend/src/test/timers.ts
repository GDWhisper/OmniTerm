import { vi } from 'vitest'

/**
 * 假时钟 + React 19 渲染的配套工具（UpdateBadge 轮询测试首创，TmuxHealthAlert
 * 轮询测试复用，故提为共享真源——两份拷贝会各自漂移）。
 *
 * React 19 调度器用 MessageChannel 排空渲染工作，fake timers 不拦截它：
 * 每推进一个时钟片段后必须让真实宏任务队列转一圈，setState 才会完成重渲染，
 * 组件续排的下一个 setTimeout/setInterval 才会落进已推进的假时钟里。
 */
export function realTick(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port2.onmessage = () => resolve()
    port1.postMessage(null)
  })
}

/** 逐秒推进假时钟并在每拍后让 React 完成渲染（见 realTick 的注释）。 */
export async function advanceClock(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    await vi.advanceTimersByTimeAsync(1000)
    await realTick()
  }
}
