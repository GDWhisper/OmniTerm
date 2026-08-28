/**
 * ViewportController — PTY 历史视口状态机（方案 C Phase 2，
 * `docs/dev/plans/backlog/pty-herdr-style-full-buffer-render.md` D1-D6）。
 *
 * 职责：把「查看历史」从 xterm 本地 scrollback（cell_frame 模式下结构性
 * 冻结，见 pty-scroll-handover.md §零核查点 3）整体移交后端——前端只维护
 * 一个窗口偏移 y，滚轮/翻页时请求后端 `encode_viewport_frame(y)` 的窗口帧。
 *
 * 状态机（D3）：
 * - `live`：贴底，正常渲染 30fps 实时帧；
 * - `viewport`：滚离底部，丢弃全部实时帧（full/overlay/diff 都会以 CUP
 *   写入当前 xterm 屏，污染正在展示的历史窗口），只渲染带 `viewport`
 *   标记的窗口帧；
 * - 回底且停止滚动 200ms → 恢复 live 并触发一次 resync（后端作废 diff
 *   基线 → 下一帧全帧，光标状态随之校准）。
 *
 * alt-screen（D4）：overlay 帧携带 `alt_screen` 标记，激活期间接管禁用
 * （wheel 交回 xterm 默认路径——无 scrollback 时 xterm 自动转方向键），
 * 且进入时强制回底。鼠标协议（vim/htop 等）的互斥由调用方在 wheel
 * handler 入口用 `term.modes.mouseTrackingMode` 判断（D1：xterm 6.0.0 中
 * 自定义 wheel handler 在鼠标协议路径同样最先执行，必须显式放行）。
 *
 * stale 响应处理（D2 勘误）：协议无请求回显字段，响应携带的 y 经后端
 * history_size 钳制后与请求值可能不等，无法可靠判定「帧旧于最新请求」；
 * 故不做按单调性丢弃，改为「响应 y 权威同步 + 有序 WS 保证收敛」——
 * WS 有序 + rAF 合并（单请求在飞）+ 本地 RTT <1ms，乱序窗口实际不存在。
 */

/** 本地窗口偏移上界（行）。与后端 grid scrollback 容量对齐
 * （`src/engine/pty/vt.rs` VT_SCROLLBACK_LINES = 1000）；后端还会按实际
 * history_size 二次钳制，响应 y 权威回同步。 */
export const MAX_VIEWPORT_Y = 1000

/** 回底后等待滚轮空闲的时长（D3）：期间仍处 viewport 模式，超时才恢复
 * live——避免连续下滚穿越底部时提前切回实时渲染。 */
export const RESTORE_DELAY_MS = 200

/** 每次滚轮事件滚动的行数（deltaMode = line / page 之外的像素换算基准
 * 由调用方传入行高）。 */
const WHEEL_LINES_PER_TICK = 3

export interface WheelMetrics {
  /** 当前字号下一行的像素高度（deltaMode = pixel 时换算用）。 */
  lineHeightPx: number
  /** 当前屏行数（deltaMode = page 时换算用）。 */
  rows: number
  /** WS 是否可发请求；不可发时不接管（离线时 xterm 默认路径无害）。 */
  wsOpen: boolean
}

/** controller 消费的帧字段（结构子集，避免依赖完整 CellFrame 类型）。 */
export interface ViewportFrameLike {
  /** 窗口帧标记：本帧展示的历史窗口偏移（行，0 = live 屏）。 */
  viewport?: number
  /** alt-screen 激活标记：仅 overlay 帧携带。 */
  alt_screen?: boolean
}

export interface ViewportControllerCallbacks {
  /** 发送 `viewport_request { y }`（调用方保证 WS 打开时才真正发送）。 */
  sendRequest: (y: number) => void
  /** viewport 模式启停（驱动 MobileKeyBar 高亮 + 软键盘抑制）。 */
  onModeChange: (active: boolean) => void
  /** 恢复 live 时触发一次（调用方发 resync，后端下一帧发全帧）。 */
  onLiveRestore: () => void
}

export class ViewportController {
  private mode: 'live' | 'viewport' = 'live'
  /** 当前窗口偏移（行，0 = live 屏，向上递增）。 */
  private currentY = 0
  /** rAF 合并窗口内待发送的最新 y（D2：仅发最新，旧请求被覆盖）。 */
  private pendingY: number | null = null
  /** 最近一次实际发出的 y（去重：抖动在边界时跳过相同请求）。 */
  private lastSentY: number | null = null
  /** 像素 deltaMode 的小数行累进器（触摸/触控板小步长平滑滚动）。 */
  private wheelAccumLines = 0
  private rafId: number | null = null
  private restoreTimer: ReturnType<typeof setTimeout> | null = null
  private altScreen = false
  private disposed = false

  private readonly cb: ViewportControllerCallbacks

  constructor(cb: ViewportControllerCallbacks) {
    this.cb = cb
  }

  /** 是否处于 viewport 模式（等价于 scrollMode UI 状态）。 */
  get viewportActive(): boolean {
    return this.mode === 'viewport'
  }

  /**
   * wheel 接管入口（D1）。返回 true 表示本控制器已接管（调用方应令
   * xterm 取消默认滚动），false 表示交还 xterm 默认路径。
   *
   * 调用方（wheel handler）负责在进入本方法前放行：tmux/external 会话、
   * 鼠标协议激活（`term.modes.mouseTrackingMode !== 'none'`）。
   */
  handleWheel(ev: { deltaY: number; deltaMode: number }, m: WheelMetrics): boolean {
    if (this.disposed || this.altScreen || !m.wsOpen) return false
    const lines = this.deltaToLines(ev.deltaY, ev.deltaMode, m)
    // deltaY < 0（滚轮向上）= 查看历史 = y 增大
    if (lines !== 0) this.scrollBy(-lines)
    return true
  }

  /** 翻页（MobileKeyBar PageUp/Down 路由）：pages < 0 向上翻看历史。 */
  pageScroll(pages: number, pageRows: number): void {
    if (this.disposed || this.altScreen) return
    // 离散翻页是明确意图：落底立即恢复，不等 200ms。
    // 符号约定：PageUp（pages < 0）向历史方向 = y 增大，与 scrollBy 相反。
    this.scrollBy(-pages * Math.max(1, pageRows), true)
  }

  /** 显式回底（MobileKeyBar「滚动」退出按钮路由）。 */
  scrollToLive(): void {
    if (this.disposed || this.mode === 'live') return
    this.restoreLive()
  }

  /**
   * 帧入口：返回是否应渲染该帧（live 模式恒 true；viewport 模式只放行
   * 窗口帧）。同时消费 `alt_screen` 标记同步 D4 状态——即使本帧因
   * viewport 模式被丢弃，标记也必须先消费（alt-screen 可能恰在滚动中
   * 切换）。
   */
  acceptFrame(frame: ViewportFrameLike): boolean {
    if (this.disposed) return false
    if (typeof frame.alt_screen === 'boolean' && frame.alt_screen !== this.altScreen) {
      this.altScreen = frame.alt_screen
      // D4：进入 alt-screen 时强制回底（真实终端行为：alt 屏切换把视口
      // 拉回 live）。退出不需特殊处理——当前必然已在 live。
      if (this.altScreen && this.mode === 'viewport') this.restoreLive()
    }
    if (frame.viewport != null) {
      // 防御：live 模式下的历史窗口帧只可能是恢复/重置前发出的迟到请求
      // （y > 0），丢弃以免覆盖刚恢复的实时屏；y = 0 窗口帧即 live 屏，
      // 渲染无害（像素与实时全帧一致）。
      if (frame.viewport > 0 && this.mode === 'live') return false
      // 响应 y 权威同步：后端按实际 history_size 钳制，以响应为准修正
      // 本地 y（仅在无更新请求排队时——pendingY 是更新的用户意图）
      if (this.pendingY == null) this.currentY = frame.viewport
      return true
    }
    return this.mode === 'live'
  }

  /** 会话切换 / 重连：无条件回到 live 初态（不发任何请求）。 */
  reset(): void {
    const wasActive = this.mode === 'viewport'
    this.cancelRestore()
    this.cancelRaf()
    this.mode = 'live'
    this.currentY = 0
    this.pendingY = null
    this.lastSentY = null
    this.wheelAccumLines = 0
    this.altScreen = false
    if (wasActive) this.cb.onModeChange(false)
  }

  /** 释放定时器/rAF（hook 卸载或测试收尾用）。 */
  dispose(): void {
    this.disposed = true
    this.cancelRestore()
    this.cancelRaf()
  }

  // ── 内部 ──

  /** deltaMode 三态换算为带符号行数（向下滚动为正），像素模式带累进。 */
  private deltaToLines(deltaY: number, deltaMode: number, m: WheelMetrics): number {
    if (deltaMode === 1) return deltaY // 行
    if (deltaMode === 2) return deltaY * Math.max(1, m.rows) // 页
    // 像素（桌面鼠标一齿 ~100px；触摸/触控板小步长）：换算成行，小数
    // 部分累积到下次事件，保证小步长也能平滑滚出整数行。
    const step = m.lineHeightPx
    if (!(step > 0)) return Math.sign(deltaY) * WHEEL_LINES_PER_TICK
    this.wheelAccumLines += deltaY / step
    if (Math.abs(this.wheelAccumLines) < 1) return 0
    const lines = Math.trunc(this.wheelAccumLines)
    this.wheelAccumLines -= lines
    return lines
  }

  /** 滚动 deltaLines 行（正 = 向历史方向）。immediateRestore：落底立即
   * 恢复 live（离散翻页）；否则滚轮路径等 200ms 空闲（D3）。 */
  private scrollBy(deltaLines: number, immediateRestore = false): void {
    const next = Math.min(MAX_VIEWPORT_Y, Math.max(0, this.currentY + deltaLines))
    // live 贴底时向下滚 = 纯 no-op（常见空闲路径，不建定时器不发请求）
    if (next === 0 && this.mode === 'live') return
    this.currentY = next
    if (next > 0) {
      this.cancelRestore()
      if (this.mode !== 'viewport') {
        this.mode = 'viewport'
        this.cb.onModeChange(true)
      }
      this.pendingY = next
      this.scheduleRequest()
      return
    }
    // 落底：先发 y=0 窗口帧（RTT <1ms，即时重绘 live 内容），恢复 live
    // 的 resync 全帧随后到达（两者像素一致，先到先绘）。
    if (this.mode === 'viewport') {
      this.pendingY = 0
      this.scheduleRequest()
    }
    if (immediateRestore) this.restoreLive()
    else this.armRestore()
  }

  private scheduleRequest(): void {
    if (this.rafId != null) return // 已有待发调度，pendingY 保留最新值
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null
      if (this.disposed) return
      const y = this.pendingY
      this.pendingY = null
      if (y == null || y === this.lastSentY) return
      this.lastSentY = y
      this.cb.sendRequest(y)
    })
  }

  private armRestore(): void {
    this.cancelRestore()
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = null
      if (!this.disposed && this.currentY === 0 && this.mode === 'viewport') this.restoreLive()
    }, RESTORE_DELAY_MS)
  }

  private restoreLive(): void {
    const wasActive = this.mode === 'viewport'
    this.cancelRestore()
    this.cancelRaf()
    this.pendingY = null
    this.lastSentY = null
    this.wheelAccumLines = 0
    this.mode = 'live'
    this.currentY = 0
    if (wasActive) this.cb.onModeChange(false)
    if (wasActive) this.cb.onLiveRestore()
  }

  private cancelRestore(): void {
    if (this.restoreTimer != null) {
      clearTimeout(this.restoreTimer)
      this.restoreTimer = null
    }
  }

  private cancelRaf(): void {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }
}
