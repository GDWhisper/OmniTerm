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
    onNewOutput: vi.fn(),
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

// ──────────────────────────────────────────────────────────
// 绝对锚定（2026-08-30）：新输出不得把视口冻在上翻时刻的快照
//
// 回归背景：修复前窗口帧只在滚轮时请求一次，之后实时帧被 acceptFrame
// 丢弃且无人重拉，屏幕永久停在上翻瞬间的历史内容——用户在压测中途上翻
// 后，后续 12s 的输出完全不可见，只有切换会话（reset）才恢复。
// ──────────────────────────────────────────────────────────
describe('ViewportController 新输出重拉（绝对锚定）', () => {
  it('历史增长时按锚点重算 y，视口看到的行保持不变', () => {
    const { ctl, sent, cb } = makeController()
    ctl.acceptFrame({ history_size: 100 })
    ctl.handleWheel(wheel(-100), METRICS) // 上翻 10 行 → y=10，锚点距历史顶 90
    raf.flush()
    expect(sent).toEqual([10])

    // 后端持续输出：历史涨到 110 行（实时帧在 viewport 模式被丢弃）
    ctl.acceptFrame({ history_size: 110 })
    expect(ctl.acceptFrame({})).toBe(false)
    ctl.notifyLiveOutput(true)
    timers.fireAll()
    raf.flush()
    // 锚点 90 不变 → y = 110 - 90 = 20：用户看到的行仍是同一批
    expect(sent).toEqual([10, 20])
    expect(cb.onNewOutput).toHaveBeenCalledWith(true)
  })

  it('历史饱和（y 钳住不变）时仍重拉——内容仍在变', () => {
    const { ctl, sent, cb } = makeController()
    ctl.acceptFrame({ history_size: MAX_VIEWPORT_Y })
    ctl.handleWheel(wheel(-100), METRICS) // y=10，锚点距历史顶 990
    raf.flush()
    expect(sent).toEqual([10])
    // 历史已达上界：新输出挤掉顶部行，history_size 恒为 1000，锚点换算
    // 出的 y 仍是 10，但窗口内容已被推新——必须重拉，否则永久冻结。
    ctl.notifyLiveOutput(true)
    timers.fireAll()
    raf.flush()
    expect(sent).toEqual([10, 10])
    expect(cb.onNewOutput).toHaveBeenCalledWith(true)
  })

  it('空 diff 帧（仅光标移动）不重拉、不报新输出', () => {
    const { ctl, sent, cb } = makeController()
    ctl.acceptFrame({ history_size: 100 })
    ctl.handleWheel(wheel(-100), METRICS)
    raf.flush()
    ctl.notifyLiveOutput(false)
    expect(sent).toEqual([10])
    expect(cb.onNewOutput).not.toHaveBeenCalled()
    expect(timers.pending()).toBe(0)
  })

  it('锚点换算结果钳制在 MAX_VIEWPORT_Y 内', () => {
    const { ctl, sent } = makeController()
    ctl.acceptFrame({ history_size: 100 })
    ctl.handleWheel(wheel(-100), METRICS) // y=10，锚点 90
    raf.flush()
    ctl.acceptFrame({ history_size: 100 + MAX_VIEWPORT_Y + 500 })
    ctl.notifyLiveOutput(true)
    timers.fireAll()
    raf.flush()
    expect(sent.at(-1)).toBe(MAX_VIEWPORT_Y)
  })

  it('live 模式下 notifyLiveOutput 无副作用', () => {
    const { ctl, sent, cb } = makeController()
    ctl.acceptFrame({ history_size: 100 })
    ctl.notifyLiveOutput(true)
    expect(sent).toEqual([])
    expect(cb.onNewOutput).not.toHaveBeenCalled()
  })

  it('回底后清除新输出标志并撤掉待发重拉', () => {
    const { ctl, cb } = makeController()
    ctl.acceptFrame({ history_size: 100 })
    ctl.handleWheel(wheel(-100), METRICS)
    raf.flush()
    ctl.acceptFrame({ history_size: 110 })
    ctl.notifyLiveOutput(true)
    expect(cb.onNewOutput).toHaveBeenLastCalledWith(true)
    ctl.scrollToLive()
    expect(cb.onNewOutput).toHaveBeenLastCalledWith(false)
    expect(timers.pending()).toBe(0)
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

// ──────────────────────────────────────────────────────────
// touch → wheel → y 方向契约（回归：D8「内容跟手」语义）
//
// 链路：touchScroll 把相邻 clientY 差分后乘 2 倍率（TOUCH_SCROLL_FACTOR）
// 当作 wheel deltaY 派发，deltaMode=0（像素）。ViewPortController 把它
// 解释为：deltaY 正 = 屏幕内容向上移 = 看新内容（live 方向，y 减小）；
// deltaY 负 = 屏幕内容向下移 = 看历史（y 增大）。
// 与 touchScroll.test.ts 配合：touch 产 deltaY 的符号在那一层覆盖，
// 本组断言 wheel → y 的最终落点。
// ──────────────────────────────────────────────────────────
describe('touch → viewport y 方向契约', () => {
  let raf: ReturnType<typeof stubRaf>
  beforeEach(() => { raf = stubRaf() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('deltaY 负（手指下滑）→ y 增大 → 看历史（内容跟手向下）', () => {
    const { ctl, sent } = makeController()
    ctl.handleWheel({ deltaY: -60, deltaMode: 0 }, METRICS)
    raf.flush()
    expect(sent).toEqual([6])
    expect(ctl.viewportActive).toBe(true)
  })

  it('deltaY 正（手指上滑）→ y 减小 → 回 live（内容跟手向上）', () => {
    const { ctl, sent } = makeController()
    // 先下滑进历史
    ctl.handleWheel({ deltaY: -120, deltaMode: 0 }, METRICS)
    raf.flush()
    const first = sent[0]
    expect(first).toBeGreaterThan(0)
    // 再上滑
    ctl.handleWheel({ deltaY: 60, deltaMode: 0 }, METRICS)
    raf.flush()
    expect(sent.length).toBe(2)
    expect(sent[1]).toBeLessThan(first)
  })

  it('live 底部 deltaY 正应为 no-op（已无更新内容可看）', () => {
    const { ctl, sent } = makeController()
    ctl.handleWheel({ deltaY: 30, deltaMode: 0 }, METRICS)
    raf.flush()
    expect(sent).toEqual([])
    expect(ctl.viewportActive).toBe(false)
  })
})
