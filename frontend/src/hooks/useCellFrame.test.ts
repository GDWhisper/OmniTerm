import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderRow, useCellFrame, type CellFrame } from './useCellFrame'

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

  it('on queue overflow clears backlog, drops the incoming frame and requests resync', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const resync = vi.fn()
    const hook = mount(termRef, resync)
    // 首帧 resync 需 `performance.now() >= RESYNC_THROTTLE_MS`（lastResync 起始为 0），
    // 而 jsdom 时钟起点随环境初始化耗时浮动——固定它，断言才不依赖环境快慢。
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => 2000)

    // Never flush rAF → queue grows to the cap; the next enqueue overflows.
    for (let i = 0; i < 121; i++) {
      act(() => hook.enqueue(fullFrame('X')))
    }
    expect(resync).toHaveBeenCalledTimes(1)
    nowSpy.mockRestore()

    // Overflow cleared the backlog: the rAF render sees nothing queued.
    act(() => flushRaf())
    expect(term.writes.join('')).not.toContain('X')
  })

  it('throttles resync requests to at most one per second', () => {
    const term = new FakeTerminal()
    const termRef = { current: term as unknown as FakeTerminal }
    const resync = vi.fn()
    const hook = mount(termRef, resync)

    let now = 1000
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now)

    for (let burst = 0; burst < 3; burst++) {
      for (let i = 0; i < 121; i++) {
        act(() => hook.enqueue(fullFrame('X')))
      }
      act(() => flushRaf())
      now += 100 // bursts 100ms apart — inside the throttle window
    }
    expect(resync).toHaveBeenCalledTimes(1)

    // Past the throttle window the next overflow resyncs again.
    now += 1000
    for (let i = 0; i < 121; i++) {
      act(() => hook.enqueue(fullFrame('X')))
    }
    expect(resync).toHaveBeenCalledTimes(2)
    nowSpy.mockRestore()
  })
})
