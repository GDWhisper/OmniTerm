import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderRow, renderCellFrame, useCellFrame, type CellFrame } from './useCellFrame'

// Probe-component pattern (no @testing-library/react in deps),
// following useLongPress.test.ts.

type HookResult = ReturnType<typeof useCellFrame>

function Probe(props: {
  termRef: React.RefObject<FakeTerminal | null>
  requestResync?: () => void
  onResult: (r: HookResult) => void
}) {
  props.onResult(
    useCellFrame(
      props.termRef as React.RefObject<import('@xterm/xterm').Terminal | null>,
      props.requestResync,
    ),
  )
  return null
}

class FakeTerminal {
  writes: string[] = []
  write(data: string): void {
    this.writes.push(data)
  }
}

function fullFrame(marker: string): CellFrame {
  return {
    t: 'cell_frame',
    session_id: 's',
    width: 2,
    height: 1,
    full: true,
    overlay: false,
    rows: [{ runs: ['', marker + ' '] }],
  }
}

function diffFrame(marker: string): CellFrame {
  return {
    t: 'cell_frame',
    session_id: 's',
    width: 2,
    height: 1,
    full: false,
    overlay: false,
    row_indices: [0],
    rows: [{ runs: ['', marker + ' '] }],
  }
}

// ──────────────────────────────────────────────────────────
// 行渲染无损性判据（RLE 行编码，2026-08-28-pty-frame-rle.md D5/D6）
// ──────────────────────────────────────────────────────────

/**
 * 逐字符渲染的参考实现：runs 展开后按每个字符单独切样式。
 *
 * RLE 版省掉了 run 内的冗余样式切换，输出字节不等但渲染等价 —— 故比对的
 * 是渲染后的 (字符, sgr) 序列而非字节串。
 */
function renderPerChar(runs: string[]): string[] {
  const chunks: string[] = []
  let prevSgr = ''
  for (let i = 0; i + 1 < runs.length; i += 2) {
    for (const ch of runs[i + 1] ?? '') {
      if ((runs[i] ?? '') !== prevSgr) {
        chunks.push('\x1b[0m')
        if (runs[i]) chunks.push(`\x1b[${runs[i]}m`)
        prevSgr = runs[i] ?? ''
      }
      chunks.push(ch)
    }
  }
  chunks.push('\x1b[0m')
  return chunks
}

/**
 * 模拟 xterm 的 SGR 状态机，产出「字符 + 该字符生效时 sgr」序列。
 *
 * 不能直接比对输出字节串：RLE 版会省掉冗余的样式切换（字节不等但渲染等价）。
 */
function simulate(ansi: string): string {
  const out: string[] = []
  let sgr = ''
  let i = 0
  while (i < ansi.length) {
    if (ansi[i] === '\x1b' && ansi[i + 1] === '[') {
      // eslint-disable-next-line no-control-regex -- 判据就是要匹配 ESC 转义序列本身
      const m = /^\x1b\[([0-9;]*)m/.exec(ansi.slice(i))
      if (m) {
        sgr = m[1] === '0' ? '' : m[1]
        i += m[0].length
        continue
      }
    }
    out.push(ansi[i], sgr)
    i++
  }
  return out.join(' ')
}

describe('renderRow', () => {
  const cases: Array<{ name: string; runs: string[] }> = [
    { name: '空行', runs: [] },
    { name: '纯文本（整行同样式）', runs: ['', 'ab '] },
    { name: '样式切换', runs: ['1;32', 'ab', '', 'c'] },
    // 宽字符：占位 cell 已由后端跳过，runs 里只留可见字符（D5）
    { name: '宽字符混排', runs: ['31', '中文', '', ' '] },
  ]

  it.each(cases)('$name：runs 渲染与逐字符渲染等价', ({ runs }) => {
    expect(simulate(renderRow(runs).join(''))).toBe(simulate(renderPerChar(runs).join('')))
  })

  it('runs 缺失时渲染空行，不抛异常', () => {
    expect(renderRow(undefined).join('')).toBe('\x1b[0m')
  })

  it('runs 长度为奇数时忽略末尾不完整的对，不抛异常', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const chunks = renderRow(['1;32', 'ab', ''])
    expect(chunks.join('')).toContain('ab')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// rAF stub: collect callbacks, flush manually.
let rafQueue: Array<() => void> = []
function flushRaf(): void {
  const q = rafQueue
  rafQueue = []
  q.forEach((cb) => cb())
}

/** 带 seq 的 diff 帧（A2 连续性校验用）。 */
function seqFrame(n: number, marker = 'S '): CellFrame {
  return { ...diffFrame(marker), seq: n }
}

describe('useCellFrame', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb)
      return rafQueue.length
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
    rafQueue = []
  })

  function mount(termRef: { current: FakeTerminal | null }, requestResync?: () => void) {
    let hook: HookResult | null = null
    act(() => {
      root.render(
        createElement(Probe, {
          termRef,
          requestResync,
          onResult: (r) => { hook = r },
        }),
      )
    })
    return hook as unknown as HookResult
  }

  it('renders every queued frame in order within one rAF (no latest-wins drops)', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const hook = mount(termRef)

    // Two full frames enqueued before rAF fires — BOTH must render, in order.
    act(() => hook.enqueue(fullFrame('A')))
    act(() => hook.enqueue(fullFrame('B')))
    act(() => flushRaf())

    const joined = term.writes.join('|')
    const idxA = joined.indexOf('A')
    const idxB = joined.indexOf('B')
    expect(idxA).toBeGreaterThanOrEqual(0)
    expect(idxB).toBeGreaterThan(idxA)
  })

  it('on overflow keeps the last full frame (and diffs after it) as the recovery anchor, without resync', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const resync = vi.fn()
    const hook = mount(termRef, resync)
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => 2000)

    // 60 diffs + 1 full + 60 diffs; the 121st enqueue overflows.
    act(() => {
      for (let i = 0; i < 60; i++) hook.enqueue(diffFrame(`d${i} `))
      hook.enqueue(fullFrame('FULL'))
      for (let i = 0; i < 60; i++) hook.enqueue(diffFrame(`e${i} `))
    })
    // full 帧自含完整状态：保留它即自带恢复，无需请求重同步。
    expect(resync).not.toHaveBeenCalled()
    nowSpy.mockRestore()

    // The diffs before the kept full frame were dropped; the full frame and
    // the diffs after it are rendered in order.
    act(() => flushRaf())
    const joined = term.writes.join('|')
    expect(joined).toContain('FULL')
    expect(joined).toContain('e59')
    expect(joined).not.toContain('d59')
    const idxFull = joined.indexOf('FULL')
    const idxE59 = joined.indexOf('e59')
    expect(idxE59).toBeGreaterThan(idxFull)
  })

  it('on overflow of an all-diff backlog clears it and requests resync', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const resync = vi.fn()
    const hook = mount(termRef, resync)
    // 首帧 resync 需 `performance.now() >= RESYNC_THROTTLE_MS`（lastResync 起始为 0），
    // 而 jsdom 时钟起点随环境初始化耗时浮动——固定它，断言才不依赖环境快慢。
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => 2000)

    // Never flush rAF → queue grows to the cap; the next enqueue overflows.
    for (let i = 0; i < 121; i++) {
      act(() => hook.enqueue(diffFrame('X')))
    }
    expect(resync).toHaveBeenCalledTimes(1)
    nowSpy.mockRestore()

    // Overflow cleared the backlog; the incoming frame itself is still queued
    // (a dropped diff loses that row change permanently), so exactly one
    // frame renders.
    act(() => flushRaf())
    const xCount = term.writes.join('|').split('X ').length - 1
    expect(xCount).toBe(1)
  })

  it('on overflow with the full frame at queue head keeps it, drops the diffs after it and resyncs', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const resync = vi.fn()
    const hook = mount(termRef, resync)
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => 2000)

    // 1 full + 121 diffs: the full sits at index 0, so keeping it and
    // everything after would not shrink the queue — keep only the full.
    act(() => {
      hook.enqueue(fullFrame('FULL'))
      for (let i = 0; i < 121; i++) hook.enqueue(diffFrame(`d${i} `))
    })
    nowSpy.mockRestore()

    // 被丢弃的 diff 增量由重同步全帧覆盖，resync 必须在途。
    expect(resync).toHaveBeenCalledTimes(1)
    act(() => flushRaf())
    const joined = term.writes.join('|')
    expect(joined).toContain('FULL')
    expect(joined).not.toContain('d117')
  })

  it('resyncs at most one immediately per second, and schedules a catch-up resync for overflows inside the throttle window', async () => {
    vi.useFakeTimers()
    try {
      const term = new FakeTerminal()
      const termRef = { current: term as unknown as FakeTerminal }
      const resync = vi.fn()
      const hook = mount(termRef, resync)

      let now = 1000
      const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now)

      // 窗口内第一次超限：立即 resync。
      for (let i = 0; i < 121; i++) act(() => hook.enqueue(diffFrame('X')))
      expect(resync).toHaveBeenCalledTimes(1)
      act(() => flushRaf())

      // 100ms 后再次超限（节流窗口内）：不立即发，但安排补发——否则这次
      // 丢帧永久无恢复（TUI 启动错位的根因）。
      now += 100
      for (let i = 0; i < 121; i++) act(() => hook.enqueue(diffFrame('Y')))
      expect(resync).toHaveBeenCalledTimes(1)

      // 补发定时器到点（距首次 resync 1s）后触发。
      await vi.advanceTimersByTimeAsync(900)
      expect(resync).toHaveBeenCalledTimes(2)

      nowSpy.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  // ──────────────────────────────────────────────────────
  // A2（2026-09-08 增量同步加固）：seq 连续性校验
  // ──────────────────────────────────────────────────────

  /** 固定 performance.now（armResync 节流窗口判断依赖它；jsdom 时钟起点
   *  浮动，不固定则断言依赖环境快慢）。 */
  function pinNow() {
    return vi.spyOn(performance, 'now').mockImplementation(() => 2000)
  }

  it('seq 连续帧不触发 resync', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const resync = vi.fn()
    const hook = mount(termRef, resync)
    const nowSpy = pinNow()

    act(() => {
      hook.enqueue(seqFrame(1))
      hook.enqueue(seqFrame(2))
      hook.enqueue(seqFrame(3))
    })
    expect(resync).not.toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it('seq 断链触发 armResync（立即一次，节流窗口内不重复）', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const resync = vi.fn()
    const hook = mount(termRef, resync)
    const nowSpy = pinNow()

    act(() => {
      hook.enqueue(seqFrame(1))
      hook.enqueue(seqFrame(3)) // seq 2 被并发连接偷走 → 断链
    })
    expect(resync).toHaveBeenCalledTimes(1)

    // 断链后的帧继续入队（全帧在途覆盖），同一窗口内再次断链不重复触发
    act(() => {
      hook.enqueue(seqFrame(5))
    })
    expect(resync).toHaveBeenCalledTimes(1)
    nowSpy.mockRestore()
  })

  it('无 seq 帧跳过检测：不触发校验也不推进 lastSeq', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const resync = vi.fn()
    const hook = mount(termRef, resync)
    const nowSpy = pinNow()

    act(() => {
      hook.enqueue(seqFrame(1))
      hook.enqueue(fullFrame('VP')) // viewport/overlay：无 seq 字段
      hook.enqueue(seqFrame(2)) // 相对最近 live 帧仍连续
    })
    expect(resync).not.toHaveBeenCalled()
    nowSpy.mockRestore()
  })

  it('首帧（lastSeq 未建立）直接接受，无论 seq 值', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const resync = vi.fn()
    const hook = mount(termRef, resync)
    const nowSpy = pinNow()

    // 后端重启归零/切换会话后首帧带任意 seq 都不算断链
    act(() => hook.enqueue(seqFrame(42)))
    expect(resync).not.toHaveBeenCalled()
    nowSpy.mockRestore()
  })
})

// ──────────────────────────────────────────────────────────
// applyCursor：行渲染污染后的光标恢复（2026-09-09）
//
// 渲染行内容必然 CUP 到重画终点（全帧 = 底行 = 右下角）；后端 cursor 去重
// 使「带 rows 但缺 cursor」成为常态帧，缺恢复则光标停在重画终点直到下次
// 光标实际变化（症状：打字间歇光标闪跳右下角）。
// ──────────────────────────────────────────────────────────

describe('applyCursor 光标恢复', () => {
  function cursorAt(row: number, col: number): NonNullable<CellFrame['cursor']> {
    return { row, col, visible: true }
  }

  /** 学习光标 (5,10) 后再渲染一个缺 cursor 的全帧，返回写入串。 */
  function renderFullWithoutCursor(cursor: NonNullable<CellFrame['cursor']> | null): string {
    const term = new FakeTerminal()
    const learned = fullFrame('LEARN')
    if (cursor) learned.cursor = cursor
    renderCellFrame(
      term as unknown as import('@xterm/xterm').Terminal,
      learned,
    )
    const plain = fullFrame('PLAIN')
    renderCellFrame(term as unknown as import('@xterm/xterm').Terminal, plain)
    return term.writes.join('|')
  }

  it('全帧缺 cursor：渲染后回写上次学习的光标位置', () => {
    const joined = renderFullWithoutCursor(cursorAt(5, 10))
    // renderCursor 对 CUP 与 DECTCEM 分次 write，join 后有分隔符，逐段断言。
    expect(joined).toContain('\x1b[5;10H')
    // PLAIN 全帧渲染到 height=1 行，若不恢复光标会停在 (1, 内容尾)。
    const restored = joined.lastIndexOf('\x1b[5;10H')
    expect(restored).toBeGreaterThan(joined.lastIndexOf('PLAIN'))
  })

  it('缺 cursor 全帧且从未学过光标：不回写（避免瞎定位）', () => {
    const joined = renderFullWithoutCursor(null)
    expect(joined).not.toContain('\x1b[5;10H')
  })

  it('diff 帧缺 cursor 且有变化行：同样回写', () => {
    const term = new FakeTerminal()
    const T = term as unknown as import('@xterm/xterm').Terminal
    const learned = { ...diffFrame('L'), cursor: cursorAt(3, 7) }
    renderCellFrame(T, learned)
    renderCellFrame(T, diffFrame('D'))
    const joined = term.writes.join('|')
    expect(joined.indexOf('\x1b[3;7H')).toBeGreaterThan(joined.indexOf('L'))
  })

  it('空 diff 帧缺 cursor：无行渲染无污染，不回写', () => {
    const term = new FakeTerminal()
    const T = term as unknown as import('@xterm/xterm').Terminal
    renderCellFrame(T, { ...diffFrame('L'), cursor: cursorAt(3, 7) })
    const empty: CellFrame = { ...diffFrame('E'), row_indices: [], rows: [] }
    renderCellFrame(T, empty)
    const afterEmpty = term.writes.join('|').slice(term.writes.join('|').indexOf('E'))
    expect(afterEmpty).not.toContain('\x1b[3;7H')
  })

  it('viewport 历史窗口帧的光标不学习（非 live 光标）', () => {
    const term = new FakeTerminal()
    const T = term as unknown as import('@xterm/xterm').Terminal
    renderCellFrame(T, { ...fullFrame('L'), cursor: cursorAt(5, 10) })
    const vp: CellFrame = {
      ...fullFrame('VP'),
      viewport: 12,
      cursor: cursorAt(1, 1),
    }
    renderCellFrame(T, vp)
    renderCellFrame(T, fullFrame('PLAIN'))
    // 恢复应回到 live 光标 (5,10) 而非历史窗口假光标 (1,1)。
    const restored = term.writes.join('|').lastIndexOf('\x1b[5;10H')
    expect(restored).toBeGreaterThan(term.writes.join('|').lastIndexOf('VP'))
  })

  it('viewport=0 回底校准帧携带真实光标，学习', () => {
    const term = new FakeTerminal()
    const T = term as unknown as import('@xterm/xterm').Terminal
    const calib: CellFrame = {
      ...fullFrame('C'),
      viewport: 0,
      cursor: cursorAt(2, 3),
    }
    renderCellFrame(T, calib)
    renderCellFrame(T, fullFrame('PLAIN'))
    expect(term.writes.join('|').lastIndexOf('\x1b[2;3H')).toBeGreaterThan(
      term.writes.join('|').lastIndexOf('PLAIN'),
    )
  })
})
