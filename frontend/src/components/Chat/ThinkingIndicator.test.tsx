import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ThinkingIndicator } from './ThinkingIndicator'
import { useAppStore } from '../../stores/appStore'

/**
 * 接线测试（rAF stub 照 useCellFrame.test.ts 的手动灌帧模式）：只覆盖
 * 「开关 → 显隐」「特效切换 → 重启循环」「unmount → 取消帧」与首帧形态。
 * 帧序列 / 档位边界 / 字符集由 thinkingEffects.test.ts 的纯函数测试全量覆盖，
 * 这里不重复。
 */
let rafQueue: Array<{ id: number; cb: (ts: number) => void }> = []
let cancelledIds: number[] = []
let nextRafId = 0

/** 手动执行已排队的 rAF 回调（回调内会重新排队下一帧）。 */
function flushRaf(ts: number) {
  const pending = rafQueue
  rafQueue = []
  act(() => {
    for (const entry of pending) entry.cb(ts)
  })
}

describe('ThinkingIndicator', () => {
  let container: HTMLDivElement
  let root: Root
  /** 个别用例自行 unmount（取消帧断言），afterEach 不再重复卸载。 */
  let alreadyUnmounted = false

  const mount = () => {
    act(() => {
      root.render(<ThinkingIndicator />)
    })
  }

  beforeEach(() => {
    rafQueue = []
    cancelledIds = []
    nextRafId = 0
    vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => {
      nextRafId += 1
      rafQueue.push({ id: nextRafId, cb })
      return nextRafId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      cancelledIds.push(id)
      // 真实语义：取消后该回调不再执行——从队列移除，避免已取消的循环继续灌帧。
      rafQueue = rafQueue.filter((entry) => entry.id !== id)
    })
    // elapsed 用 Date.now()：固定时钟让首帧形态确定（frame 0 / 长度档 16）。
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    localStorage.clear()
    useAppStore.setState({ thinkingEffectEnabled: true, thinkingEffectId: 'scramble' })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    if (!alreadyUnmounted) act(() => root.unmount())
    alreadyUnmounted = false
    container.remove()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders nothing and schedules no frame when the master switch is off', () => {
    useAppStore.setState({ thinkingEffectEnabled: false })
    mount()
    expect(container.textContent).toBe('')
    expect(rafQueue).toHaveLength(0)
  })

  it('draws the scramble noise on the first frame', () => {
    mount()
    expect(rafQueue).toHaveLength(1)
    flushRaf(1000)
    expect(container.textContent).toMatch(/^▌[0-9a-f]{16}$/)
    // 循环仍在继续：tick 末尾重排了下一帧。
    expect(rafQueue).toHaveLength(1)
  })

  it('restarts the loop with the new renderer when the effect changes', () => {
    mount()
    flushRaf(1000)
    expect(container.textContent).toMatch(/^▌[0-9a-f]{16}$/)

    act(() => {
      useAppStore.setState({ thinkingEffectId: 'spinner' })
    })
    // 旧循环被取消、新循环重新排队（startTime 重置 → 首帧为第 0 帧）。
    expect(cancelledIds.length).toBeGreaterThan(0)
    expect(rafQueue).toHaveLength(1)
    flushRaf(2000)
    expect(container.textContent).toBe('▌◐')
  })

  it('appears and starts animating when re-enabled', () => {
    useAppStore.setState({ thinkingEffectEnabled: false })
    mount()
    expect(rafQueue).toHaveLength(0)

    act(() => {
      useAppStore.setState({ thinkingEffectEnabled: true })
    })
    expect(rafQueue).toHaveLength(1)
    flushRaf(1000)
    expect(container.textContent).toMatch(/^▌[0-9a-f]{16}$/)
  })

  it('cancels the pending frame on unmount', () => {
    mount()
    expect(cancelledIds).toHaveLength(0)
    act(() => root.unmount())
    alreadyUnmounted = true
    expect(cancelledIds).toHaveLength(1)
  })
})
