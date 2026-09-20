/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * [TERMDBG] 临时诊断埋点 —— pty 打字延迟排查专用。
 *
 * 目的：在真实环境里量出「按键回显延迟」到底卡在哪一段。三个候选队列：
 *   1. rAF 队列：帧到达 → 开始渲染 的等待（`frameToRender`）
 *   2. xterm 写入队列：term.write → onWriteParsed 的等待（`writeToParsed`）
 *   3. 主线程卡顿：rAF 间隔（`raf`）
 * 另采样 xterm 内部未解析字节数（`_pendingData`）。
 *
 * 判读：
 *   - 若用户卡时这三项仍很小 → 前端管线无罪，延迟在上游（agent 重绘 / 后端 / 网络）。
 *   - 若某一项显著变大（>100ms）→ 就是那个队列在顶住。
 *
 * 仅在 DEV 生效；排查完成后本文件与各调用点一并删除（grep `TERMDBG`）。
 */

function pct(samples: number[], p: number): number {
  if (samples.length === 0) return 0
  const a = [...samples].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(a.length * p))]
}

class TermDebug {
  private term: any = null
  private frames = 0
  private bytes = 0
  private keys = 0
  private rafGaps: number[] = []
  private frameToRender: number[] = []
  private writeToParsed: number[] = []
  private batches: number[] = []
  /** 按键 → 下一条「含内容变化」的帧到达（≈ 回显延迟，含 agent 重绘时间）。 */
  private keyToEcho: number[] = []
  private pendingKeyAt = 0
  private pendingMax = 0
  private pendingNow = 0
  private queueMax = 0
  private lastRaf = 0
  private writeAt = 0
  private reporter: ReturnType<typeof setInterval> | null = null
  private rafId: number | null = null
  private lastReportAt = 0
  /** 最近 120 条报告（环形）。用户卡顿时用 `__termDebug.dump()` 一键导出。 */
  private history: string[] = []

  attachTerm(term: any): void {
    if (this.term) return
    this.term = term
    try {
      // xterm 写缓冲解析完成事件：衡量写入队列排空耗时
      term.onWriteParsed?.(() => {
        if (this.writeAt) {
          this.writeToParsed.push(performance.now() - this.writeAt)
          this.writeAt = 0
        }
      })
    } catch {
      /* 埋点不得影响终端 */
    }
    this.startRafProbe()
    this.startReporter()
    console.info(
      '[TERMDBG] 临时打字延迟埋点已启用（每 2s 一行）。卡顿时执行 __termDebugDump() 导出最近记录。',
    )
  }

  /** cell_frame 文本帧到达。`hasChange` = 帧内含变化行（full/overlay/diff 有行）。 */
  noteFrame(bytes: number, hasChange = false): void {
    this.frames++
    this.bytes += bytes
    if (hasChange && this.pendingKeyAt) {
      this.keyToEcho.push(performance.now() - this.pendingKeyAt)
      this.pendingKeyAt = 0
    }
  }

  /** 每帧即将交给渲染队列时记到达时刻（由 useCellFrame 用于算等待）。 */
  stamp(frame: any): void {
    frame.__t = performance.now()
  }

  /** 一帧开始渲染时调用：delayMs = now - 到达时刻。 */
  noteFrameRender(delayMs: number, batch: number): void {
    this.frameToRender.push(delayMs)
    this.batches.push(batch)
  }

  /** 用户按键（term.onData）。 */
  noteKey(): void {
    this.keys++
    this.pendingKeyAt = performance.now()
  }

  /** 一次 term.write 调用（同一批只记第一次）。 */
  noteWrite(): void {
    if (!this.writeAt) this.writeAt = performance.now()
  }

  private startRafProbe(): void {
    const loop = (t: number) => {
      if (this.lastRaf) this.rafGaps.push(t - this.lastRaf)
      this.lastRaf = t
      this.rafId = requestAnimationFrame(loop)
    }
    this.rafId = requestAnimationFrame(loop)
  }

  private samplePending(): void {
    try {
      const wb = this.term?._writeBuffer
      if (!wb) return
      const p = wb._pendingData ?? 0
      const q = wb._writeBuffer?.length ?? 0
      this.pendingNow = p
      if (p > this.pendingMax) this.pendingMax = p
      if (q > this.queueMax) this.queueMax = q
    } catch {
      /* ignore */
    }
  }

  private startReporter(): void {
    this.lastReportAt = performance.now()
    this.reporter = setInterval(() => {
      this.samplePending()
      const now = performance.now()
      const dt = (now - this.lastReportAt) / 1000
      this.lastReportAt = now
      const line = {
        fps: Math.round(this.frames / dt),
        kbps: Math.round(this.bytes / dt / 1024),
        keysPerSec: Math.round(this.keys / dt),
        keyToEchoMs: { p50: pct(this.keyToEcho, 0.5) | 0, p95: pct(this.keyToEcho, 0.95) | 0, max: Math.round(Math.max(0, ...this.keyToEcho)) },
        raf: { p50: pct(this.rafGaps, 0.5) | 0, p95: pct(this.rafGaps, 0.95) | 0, max: Math.round(Math.max(0, ...this.rafGaps)) },
        frameToRenderMs: { p50: pct(this.frameToRender, 0.5) | 0, p95: pct(this.frameToRender, 0.95) | 0, max: Math.round(Math.max(0, ...this.frameToRender)) },
        writeToParsedMs: { p50: pct(this.writeToParsed, 0.5) | 0, p95: pct(this.writeToParsed, 0.95) | 0, max: Math.round(Math.max(0, ...this.writeToParsed)) },
        maxBatch: Math.max(0, ...this.batches),
        xtermPendingB: this.pendingNow,
        xtermPendingMaxB: this.pendingMax,
        xtermQueueMax: this.queueMax,
      }
      const bad =
        line.frameToRenderMs.max > 100 ||
        line.writeToParsedMs.max > 100 ||
        line.raf.max > 100 ||
        line.xtermPendingMaxB > 200000
      const text = `[TERMDBG]${bad ? ' SLOW' : ''} ${JSON.stringify(line)}`
      console[bad ? 'warn' : 'log'](text)
      this.history.push(text)
      if (this.history.length > 120) this.history.shift()
      this.resetWindow()
    }, 2000)
  }

  private resetWindow(): void {
    this.frames = 0
    this.bytes = 0
    this.keys = 0
    this.rafGaps = []
    this.frameToRender = []
    this.writeToParsed = []
    this.batches = []
    this.keyToEcho = []
    this.pendingMax = 0
    this.queueMax = 0
  }

  snapshot() {
    this.samplePending()
    return {
      termFound: !!this.term,
      xtermPendingB: this.pendingNow,
      xtermPendingMaxB: this.pendingMax,
      xtermQueueMax: this.queueMax,
    }
  }

  /** 最近 120 条报告（每 2s 一条）拼接导出，复制粘贴即可。 */
  dump(): string {
    return this.history.join('\n')
  }

  stop(): void {
    if (this.reporter) clearInterval(this.reporter)
    if (this.rafId != null) cancelAnimationFrame(this.rafId)
    this.reporter = null
    this.rafId = null
  }
}

export const termDebug = new TermDebug()
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as any).__termDebug = termDebug
  // 卡顿时在控制台执行 `__termDebugDump()`（或 `copy(__termDebugDump())`）导出最近记录
  ;(window as any).__termDebugDump = () => termDebug.dump()
}
