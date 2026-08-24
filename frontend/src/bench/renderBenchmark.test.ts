/**
 * Phase R1: xterm.js cell-level render benchmark runner.
 *
 * Measures execution time (encoding time) and output size for each strategy.
 * Genuine xterm.js render time requires a browser (Playwright); this module
 * measures the data-processing cost that feeds into xterm.write().
 */

import { describe, it, expect } from 'vitest'
import {
  type Cell,
  cellSgr,
  naivePerCell,
  rowBatched,
  fullStream,
  renderScreenSim,
  emptyGrid,
  plainTextGrid,
  colorTuiGrid,
  wideCharGrid,
  DEFAULT_STYLE,
} from './cellRenderer'

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

const COLS = 80
const ROWS = 24

function measure<T>(fn: () => T): { result: T; ms: number } {
  const t0 = performance.now()
  const result = fn()
  const ms = performance.now() - t0
  return { result, ms }
}

function totalBytes(writes: string[]): number {
  return writes.reduce((sum, w) => sum + new TextEncoder().encode(w).length, 0)
}

// ──────────────────────────────────────────────────────────
// Suite
// ──────────────────────────────────────────────────────────

describe('Phase R1: cell-level render feasibility', () => {
  // ──── cellSgr unit tests ────

  describe('cellSgr', () => {
    it('returns empty string for default style', () => {
      expect(cellSgr(DEFAULT_STYLE)).toBe('')
    })

    it('encodes bold', () => {
      expect(cellSgr({ ...DEFAULT_STYLE, bold: true })).toBe('\x1b[1m')
    })

    it('encodes bold + 256-color fg', () => {
      expect(cellSgr({ ...DEFAULT_STYLE, bold: true, fg: 196 })).toBe('\x1b[1;38;5;196m')
    })

    it('encodes true-color fg+bg', () => {
      const s = cellSgr({ ...DEFAULT_STYLE, fg: 0xff0000, bg: 0x00ff00 })
      expect(s).toBe('\x1b[38;2;255;0;0;48;2;0;255;0m')
    })

    it('encodes multiple flags', () => {
      const s = cellSgr({ ...DEFAULT_STYLE, bold: true, italic: true, underline: true })
      expect(s).toBe('\x1b[1;3;4m')
    })
  })

  // ──── Strategy comparison ────

  const scenarios = [
    { name: 'empty',   grid: () => emptyGrid(COLS, ROWS) },
    { name: 'plain',   grid: () => plainTextGrid(COLS, ROWS) },
    { name: 'colorTui', grid: () => colorTuiGrid(COLS, ROWS) },
    { name: 'wideChar', grid: () => wideCharGrid(COLS, ROWS) },
  ]

  const strategies: { name: string; fn: (grid: Cell[][]) => string | string[]; measureWrites?: boolean }[] = [
    { name: 'renderScreenSim', fn: (grid: Cell[][]) => renderScreenSim(grid, COLS, ROWS) },
    { name: 'rowBatched',      fn: (grid: Cell[][]) => rowBatched(grid, COLS, ROWS).join('') },
    { name: 'fullStream',      fn: (grid: Cell[][]) => fullStream(grid, COLS, ROWS) },
    { name: 'naivePerCell',    fn: (grid: Cell[][]) => naivePerCell(grid, COLS, ROWS), measureWrites: true },
  ]

  for (const scenario of scenarios) {
    describe(`scenario: ${scenario.name}`, () => {
      const grid = scenario.grid()

      describe('output size comparison', () => {
        const ssData: Record<string, number> = {}

        for (const strategy of strategies) {
          it(`${strategy.name}: measures bytes${strategy.measureWrites ? ' + write count' : ''}`, () => {
            const result = measure(() => strategy.fn(grid))

            // 两条分支都在读之前赋值，无需占位初值；writeCount 仅 measureWrites 分支有意义
            let byteCount: number

            if (strategy.measureWrites) {
              const writes = result.result as string[]
              const writeCount = writes.length
              byteCount = totalBytes(writes)
              console.log(
                `  [${scenario.name}] ${strategy.name}: ${result.ms.toFixed(3)}ms, ${byteCount} bytes, ${writeCount} writes`
              )
            } else {
              const out = result.result as string
              byteCount = new TextEncoder().encode(out).length
              console.log(`  [${scenario.name}] ${strategy.name}: ${result.ms.toFixed(3)}ms, ${byteCount} bytes`)
            }

            expect(byteCount).toBeGreaterThan(0)
            expect(result.ms).toBeGreaterThanOrEqual(0)
            ssData[strategy.name] = byteCount
          })
        }

        it('rowBatched vs renderScreenSim size ratio', () => {
          const base = ssData['renderScreenSim']!
          const ratio = ssData['rowBatched']! / base
          console.log(`  [${scenario.name}] rowBatched/renderscreen = ${ratio.toFixed(3)}x`)
          expect(ratio).toBeGreaterThan(0)
          console.log(`  [R1_NOTE] ${scenario.name} rowBatched/renderscreen = ${ratio.toFixed(2)}x`)
        })

        it('naivePerCell overhead ratio vs renderScreenSim', () => {
          const base = ssData['renderScreenSim']!
          const ratio = ssData['naivePerCell']! / base
          console.log(`  [${scenario.name}] naivePerCell/renderscreen = ${ratio.toFixed(3)}x`)
          expect(ratio).toBeGreaterThan(0)
          console.log(`  [R1_NOTE] ${scenario.name} naivePerCell overhead = ${ratio.toFixed(1)}x`)
        })
      })

      describe('encoding latency < 16ms target (60fps budget)', () => {
        for (const strategy of strategies) {
          if (strategy.measureWrites) continue
          it(`${strategy.name}: within 16ms budget`, () => {
            const { ms } = measure(() => strategy.fn(grid))
            console.log(`  [${scenario.name}] ${strategy.name}: ${ms.toFixed(3)}ms (16ms budget)`)
            expect(ms).toBeLessThan(16)
          })
        }
      })

      it('round-trip: rowBatched ends with reset', () => {
        const rb = rowBatched(grid, COLS, ROWS)
        expect(rb.length).toBeGreaterThanOrEqual(1)
        const last = rb[rb.length - 1]!
        expect(last).toContain('\x1b[0m')
      })

      it('renderScreenSim ends with reset + cursor pos + visibility (matching vt.rs)', () => {
        const out = renderScreenSim(grid, COLS, ROWS)
        expect(out).toContain('\x1b[0m')
        expect(out).toContain(`\x1b[${ROWS};${COLS}H`)
        // no-control-regex：被测对象就是终端转义序列，控制字符在此是合法输入
        // eslint-disable-next-line no-control-regex
        expect(out).toMatch(/\x1b\[\?25[hl]$/)
      })
    })
  }

  // ──── Grid data generator correctness ────

  it('emptyGrid has correct dimensions', () => {
    const g = emptyGrid(COLS, ROWS)
    expect(g.length).toBe(ROWS)
    expect(g[0]!.length).toBe(COLS)
  })

  it('plainTextGrid places text correctly', () => {
    const g = plainTextGrid(COLS, ROWS)
    expect(g[2]![0]!.char).toBe('H')
    expect(g[2]![7]!.char).toBe('O')
  })

  it('wideCharGrid has correct DWC skip pattern', () => {
    const g = wideCharGrid(COLS, ROWS)
    let skipped = 0
    let wide = 0
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (g[r]![c]!.skip) skipped++
        if (g[r]![c]!.style.wide) wide++
      }
    }
    expect(skipped).toBeGreaterThan(0)
    expect(wide).toBe(skipped)
  })

  // ──── H5: Hardware readiness (encoding < 16ms) ────

  describe('HARDWARE READINESS', () => {
    it('renderScreenSim/rowBatched/fullStream < 16ms in all scenarios', () => {
      const fastStrategies = [
        { name: 'renderScreenSim', fn: (g: Cell[][]) => renderScreenSim(g, COLS, ROWS) },
        { name: 'rowBatched',      fn: (g: Cell[][]) => rowBatched(g, COLS, ROWS).join('') },
        { name: 'fullStream',      fn: (g: Cell[][]) => fullStream(g, COLS, ROWS) },
      ]
      for (const scenario of scenarios) {
        const grid = scenario.grid()
        for (const s of fastStrategies) {
          const { ms } = measure(() => s.fn(grid))
          console.log(`  [R1_TIMING] ${scenario.name}/${s.name}: ${ms.toFixed(3)}ms`)
          expect(ms).toBeLessThan(16)
        }
      }
    })
  })
})
