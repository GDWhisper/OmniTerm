import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ViewportController,
  MAX_VIEWPORT_Y,
  type ViewportControllerCallbacks,
} from './viewportController'

/** rAF 桩：手动驱动，模拟一帧过去。 */
function stubRaf() {
  const cbs = new Map<number, FrameRequestCallback>()
  let nextId = 1
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cbs.set(nextId, cb)
    return nextId++
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => cbs.delete(id))
  return {
    flush: () => {
      const pending = [...cbs.values()]
      cbs.clear()
      pending.forEach((cb) => cb(0))
    },
    pending: () => cbs.size,
  }
}

/** setTimeout/clearTimeout 桩：手动驱动，模拟时间流逝。 */
function stubTimers() {
  const timers = new Map<number, () => void>()
  let nextId = 1
  vi.stubGlobal('setTimeout', (cb: () => void) => {
    const id = nextId++
    timers.set(id, cb)
    return id
  })
  vi.stubGlobal('clearTimeout', (id: number) => timers.delete(id))
  return {
    fireAll: () => {
      const pending = [...timers.values()]
      timers.clear()
      pending.forEach((cb) => cb())
    },
    pending: () => timers.size,
  }
}

function makeController(overrides?: Partial<ViewportControllerCallbacks>) {
  const sent: number[] = []
  const cb: ViewportControllerCallbacks = {
    sendRequest: (y) => sent.push(y),
    onModeChange: vi.fn(),
    onLiveRestore: vi.fn(),
    ...overrides,
  }
  return { ctl: new ViewportController(cb), sent, cb }
}

const METRICS = { lineHeightPx: 10, rows: 24, wsOpen: true }
const wheel = (deltaY: number, deltaMode = 0) => ({ deltaY, deltaMode })

let raf: ReturnType<typeof stubRaf>
let timers: ReturnType<typeof stubTimers>

beforeEach(() => {
  raf = stubRaf()
  timers = stubTimers()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ViewportController.handleWheel', () => {
  it('wheel up from live enters viewport mode and requests history window', () => {
    const { ctl, cb } = makeController()
    expect(ctl.handleWheel(wheel(-100), METRICS)).toBe(true)
    raf.flush()
    expect(cb.onModeChange).toHaveBeenCalledWith(true)
    // 100px / 10px = 10 行
    expect(ctl.viewportActive).toBe(true)
  })

  it('coalesces high-frequency wheels into the latest y per frame (D2)', () => {
    const { ctl, sent } = makeController()
    ctl.handleWheel(wheel(-30), METRICS) // y 3
    ctl.handleWheel(wheel(-30), METRICS) // y 6
    ctl.handleWheel(wheel(-30), METRICS) // y 9
    expect(raf.pending()).toBe(1) // rAF 合并：只挂一个调度
    raf.flush()
    expect(sent).toEqual([9]) // 只发最新 y
  })

  it('skips duplicate request when y unchanged at boundary', () => {
    const { ctl, sent } = makeController()
    // 直达上界
    ctl.handleWheel(wheel(-(MAX_VIEWPORT_Y + 500) * METRICS.lineHeightPx), METRICS)
    raf.flush()
    expect(sent).toEqual([MAX_VIEWPORT_Y])
    // 已在上界继续上滚：y 钳住不变则不重发
    ctl.handleWheel(wheel(-100), METRICS)
    raf.flush()
    expect(sent).toEqual([MAX_VIEWPORT_Y])
  })

  it('pixel fractions accumulate across events (trackpad smoothness)', () => {
    const { ctl, sent } = makeController()
    ctl.handleWheel(wheel(-5), METRICS) // 0.5 行，累积
    expect(sent).toEqual([])
    ctl.handleWheel(wheel(-5), METRICS) // 凑满 1 行
    raf.flush()
    expect(sent).toEqual([1])
  })

  it('line deltaMode maps directly, page deltaMode multiplies by rows', () => {
    const { ctl, sent } = makeController()
    ctl.handleWheel(wheel(-3, 1), METRICS)
    raf.flush()
    expect(sent).toEqual([3])
    ctl.handleWheel(wheel(-2, 2), METRICS) // 2 页 × 24 行
    raf.flush()
    expect(sent).toEqual([3, 3 + 48])
  })

  it('does not take over in alt-screen or when ws closed (D4/D1)', () => {
    const { ctl } = makeController()
    ctl.acceptFrame({ alt_screen: true })
    expect(ctl.handleWheel(wheel(-100), METRICS)).toBe(false)
    expect(ctl.viewportActive).toBe(false)

    const offline = makeController()
    expect(offline.ctl.handleWheel(wheel(-100), { ...METRICS, wsOpen: false })).toBe(false)
  })

  it('clamps y to MAX_VIEWPORT_Y (bounded, P1)', () => {
    const { ctl, sent } = makeController()
    ctl.handleWheel(wheel(-(MAX_VIEWPORT_Y + 500) * METRICS.lineHeightPx), METRICS)
    raf.flush()
    expect(sent).toEqual([MAX_VIEWPORT_Y])
  })
})

describe('ViewportController.restore-to-live (D3)', () => {
  it('wheel down to bottom keeps viewport for 200ms then restores + resync', () => {
    const { ctl, cb } = makeController()
    ctl.handleWheel(wheel(-100), METRICS) // 进 viewport，y=10
    raf.flush()
    ctl.handleWheel(wheel(100), METRICS) // 回底 y=0，arm 200ms
    raf.flush()
    expect(ctl.viewportActive).toBe(true) // 仍是 viewport
    timers.fireAll()
    expect(ctl.viewportActive).toBe(false)
    expect(cb.onModeChange).toHaveBeenLastCalledWith(false)
    expect(cb.onLiveRestore).toHaveBeenCalledTimes(1)
  })

  it('wheel up during the 200ms window cancels restore', () => {
    const { ctl, cb } = makeController()
    ctl.handleWheel(wheel(-100), METRICS)
    raf.flush()
    ctl.handleWheel(wheel(100), METRICS) // 回底
    raf.flush()
    ctl.handleWheel(wheel(-30), METRICS) // 窗口期内又滚上去
    raf.flush()
    timers.fireAll()
    expect(ctl.viewportActive).toBe(true)
    expect(cb.onLiveRestore).not.toHaveBeenCalled()
  })

  it('page scroll landing at bottom restores immediately (no 200ms wait)', () => {
    const { ctl, cb } = makeController()
    ctl.pageScroll(-1, 23) // PageUp 一页
    raf.flush()
    expect(ctl.viewportActive).toBe(true)
    ctl.pageScroll(1, 23) // PageDown 回底
    raf.flush()
    expect(ctl.viewportActive).toBe(false)
    expect(cb.onLiveRestore).toHaveBeenCalledTimes(1)
    expect(timers.pending()).toBe(0)
  })

  it('scrollToLive restores immediately; no-op when already live', () => {
    const { ctl, cb } = makeController()
    ctl.scrollToLive()
    expect(cb.onLiveRestore).not.toHaveBeenCalled()
    ctl.handleWheel(wheel(-100), METRICS)
    raf.flush()
    ctl.scrollToLive()
    expect(ctl.viewportActive).toBe(false)
    expect(cb.onLiveRestore).toHaveBeenCalledTimes(1)
  })
})

describe('ViewportController.acceptFrame', () => {
  it('drops live frames in viewport mode, passes viewport frames', () => {
    const { ctl } = makeController()
    ctl.handleWheel(wheel(-100), METRICS)
    raf.flush()
    expect(ctl.acceptFrame({})).toBe(false) // 实时帧
    expect(ctl.acceptFrame({ viewport: 10 })).toBe(true) // 窗口帧
    expect(ctl.acceptFrame({ viewport: 0 })).toBe(true) // 回底校准帧
  })

  it('passes all frames in live mode', () => {
    const { ctl } = makeController()
    expect(ctl.acceptFrame({})).toBe(true)
    expect(ctl.acceptFrame({ viewport: 0 })).toBe(true)
  })

  it('drops stale history window frame arriving after restore (defensive)', () => {
    const { ctl } = makeController()
    ctl.handleWheel(wheel(-100), METRICS)
    raf.flush()
    ctl.pageScroll(1, 23) // 立即回底恢复
    expect(ctl.viewportActive).toBe(false)
    expect(ctl.acceptFrame({ viewport: 10 })).toBe(false)
  })

  it('alt_screen=true forces live and drops subsequent live frames no more (D4)', () => {
    const { ctl, cb } = makeController()
    ctl.handleWheel(wheel(-100), METRICS)
    raf.flush()
    expect(ctl.acceptFrame({ alt_screen: true })).toBe(true) // overlay 帧本身要渲染
    expect(ctl.viewportActive).toBe(false) // 强制回底
    expect(cb.onLiveRestore).toHaveBeenCalledTimes(1)
    expect(ctl.acceptFrame({})).toBe(true) // live 恢复正常渲染
    expect(ctl.handleWheel(wheel(-100), METRICS)).toBe(false) // alt-screen 期间不接管
    ctl.acceptFrame({ alt_screen: false })
    expect(ctl.handleWheel(wheel(-100), METRICS)).toBe(true) // 退出后恢复接管
  })

  it('syncs local y to clamped response y (authoritative)', () => {
    const { ctl, sent } = makeController()
    // 会话历史不足：请求 50 行，后端钳到 3 行
    ctl.handleWheel(wheel(-500), METRICS)
    raf.flush()
    expect(sent).toEqual([50])
    ctl.acceptFrame({ viewport: 3 })
    // 再向下滚 1 行：从同步后的 y=3 出发而不是 y=50
    ctl.handleWheel(wheel(10), METRICS)
    raf.flush()
    expect(sent).toEqual([50, 2])
  })
})

describe('ViewportController.reset', () => {
  it('returns to live initial state without emitting requests', () => {
    const { ctl, cb, sent } = makeController()
    ctl.handleWheel(wheel(-100), METRICS)
    raf.flush()
    ctl.reset()
    expect(ctl.viewportActive).toBe(false)
    expect(sent).toEqual([10])
    expect(cb.onModeChange).toHaveBeenLastCalledWith(false)
    // 重置后实时帧照常渲染
    expect(ctl.acceptFrame({})).toBe(true)
    // alt-screen 状态也被清除
    expect(ctl.handleWheel(wheel(-100), METRICS)).toBe(true)
  })
})
