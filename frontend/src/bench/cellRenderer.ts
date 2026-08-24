/**
 * Phase R1: cell-level renderer for xterm.js.
 *
 * Converts a grid of (char, style) cells into ANSI escape sequences
 * that can be written directly to an xterm.js instance.
 *
 * Strategy comparison:
 *   1. naivePerCell  — CUP+SGR+char per cell, individual write()
 *   2. batchedStream — same segments, but batched into one write()
 *   3. rowBatched    — one write per row (CUP + style runs + chars)
 */

export interface CellStyle {
  fg?: number   // 256-color index or true-color RGB packed (0xRRGGBB)
  bg?: number
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  hidden: boolean
  strike: boolean
  wide: boolean  // part of a wide char (DWC)
}

export interface Cell {
  char: string
  style: CellStyle
  skip: boolean  // DWC right-cell should be skipped
}

export const DEFAULT_STYLE: CellStyle = {
  fg: undefined, bg: undefined,
  bold: false, dim: false, italic: false,
  underline: false, inverse: false, hidden: false, strike: false,
  wide: false,
}

/** Standard terminal size — matches OmniTerm PtyEngine::DEFAULT_SIZE */
export const STD_COLS = 80
export const STD_ROWS = 24

// ──────────────────────────────────────────────────────────
// SGR builder
// ──────────────────────────────────────────────────────────
function sgrParts(style: CellStyle): string[] {
  const parts: string[] = []
  // Style flags → SGR codes (matching OmniTerm vt.rs sgr_body)
  if (style.bold)      parts.push('1')
  if (style.dim)       parts.push('2')
  if (style.italic)    parts.push('3')
  if (style.underline) parts.push('4')
  if (style.inverse)   parts.push('7')
  if (style.hidden)    parts.push('8')
  if (style.strike)    parts.push('9')
  if (style.fg != null) {
    const c = Number(style.fg)
    if (c < 256)      parts.push(`38;5;${c}`)      // 256-color
    else               parts.push(`38;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`) // true-color
  }
  if (style.bg != null) {
    const c = Number(style.bg)
    if (c < 256)      parts.push(`48;5;${c}`)
    else               parts.push(`48;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`)
  }
  return parts
}

export function cellSgr(style: CellStyle): string {
  const p = sgrParts(style)
  if (p.length === 0) return ''
  return `\x1b[${p.join(';')}m`
}

const SGR_RESET = '\x1b[0m'

function encodeCellPos(row: number, col: number): string {
  return `\x1b[${row + 1};${col + 1}H`
}

// ──────────────────────────────────────────────────────────
// Strategy 1: naive per-cell (individual write per cell)
// ──────────────────────────────────────────────────────────
export function naivePerCell(grid: Cell[][], cols: number, rows: number): string[] {
  // Returns list of strings, each intended for one term.write() call
  // This worst-case represents current approach if each cell is written separately
  const writes: string[] = []
  let curStyle = ''

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = grid[r]?.[c]
      if (!cell || cell.skip) continue

      const sgr = cellSgr(cell.style)
      const pos = encodeCellPos(r, c)
      const char = cell.char

      if (sgr !== curStyle) {
        writes.push(SGR_RESET + sgr + pos + char)
        curStyle = sgr
      } else {
        writes.push(pos + char)
      }
    }
  }
  return writes
}

// ──────────────────────────────────────────────────────────
// Strategy 2: row-batched (one write per row, style run grouping)
// ──────────────────────────────────────────────────────────

/**
 * Groups consecutive cells with the same SGR string into single writes.
 * One write per row (with cursor positioning), appends reset at end.
 */
export function rowBatched(grid: Cell[][], cols: number, rows: number): string[] {
  const writes: string[] = []
  // 每行重置 SGR 状态；初值由行循环内的 reset 赋予（外层不给占位值）
  let curSgr: string

  for (let r = 0; r < rows; r++) {
    const row: string[] = []
    row.push(`\x1b[${r + 1};1H`) // move to row start
    curSgr = ''

    for (let c = 0; c < cols; c++) {
      const cell = grid[r]?.[c]
      if (!cell || cell.skip) { c += (cell?.style.wide ? 1 : 0); continue }

      const sgr = cellSgr(cell.style)
      if (sgr !== curSgr) {
        row.push(SGR_RESET + sgr)
        curSgr = sgr
      }
      row.push(cell.char)
    }
    row.push(SGR_RESET)
    writes.push(row.join(''))
  }
  return writes
}

// ──────────────────────────────────────────────────────────
// Strategy 3: full streaming (entire grid as single string)
// ──────────────────────────────────────────────────────────
export function fullStream(grid: Cell[][], cols: number, rows: number): string {
  return rowBatched(grid, cols, rows).join('')
}

// ──────────────────────────────────────────────────────────
// Strategy 4: render_screen simulation (matching VtState::render_screen logic)
// ──────────────────────────────────────────────────────────
export function renderScreenSim(
  grid: Cell[][],
  cols: number,
  rows: number,
): string {
  const lines: string[] = []
  let curStyle = ''

  for (let r = 0; r < rows; r++) {
    const lineCells: string[] = []
    // Collect visible cells (skip DWC spacers and trailing blanks with default style)
    const visible: { ch: string; style: CellStyle }[] = []
    for (let c = 0; c < cols; c++) {
      const cell = grid[r]?.[c]
      if (!cell || cell.skip) continue
      visible.push({ ch: cell.char, style: cell.style })
    }

    // Trim trailing blanks that have default style (matching OmniTerm logic)
    let trimEnd = visible.length
    while (trimEnd > 0) {
      const s = visible[trimEnd - 1]!.style
      if (sgrParts(s).length === 0 && visible[trimEnd - 1]!.ch === ' ') {
        trimEnd--
      } else break
    }
    const cells = visible.slice(0, trimEnd)

    for (const { ch, style } of cells) {
      const sgr = cellSgr(style)
      if (sgr !== curStyle) {
        lineCells.push(SGR_RESET)
        if (sgr) lineCells.push(sgr)
        curStyle = sgr
      }
      lineCells.push(ch)
    }
    lineCells.push(SGR_RESET)
    lines.push(lineCells.join(''))
    curStyle = '' // reset per-line matching render_screen behavior
  }

  // Join with \r\n, no trailing \r\n (matching render_screen)
  const joined = lines.join('\r\n')

  // Append final reset + CUP cursor pos + visibility (matching vt.rs render_screen ending)
  // Default to bottom-right, cursors usually hidden in batch render
  return joined + '[0m[' + STD_ROWS + ';' + STD_COLS + 'H[?25h'
}

// ──────────────────────────────────────────────────────────
// Grid test data generators
// ──────────────────────────────────────────────────────────

function makeStyle(overrides: Partial<CellStyle> = {}): CellStyle {
  return { ...DEFAULT_STYLE, ...overrides }
}

/**
 * Empty grid (blank screen — worst case for diff: very little to write)
 */
export function emptyGrid(cols: number, rows: number): Cell[][] {
  const grid: Cell[][] = []
  for (let r = 0; r < rows; r++) {
    grid[r] = []
    for (let c = 0; c < cols; c++) {
      grid[r]![c] = { char: ' ', style: { ...DEFAULT_STYLE }, skip: false }
    }
  }
  return grid
}

/**
 * Plain text grid (small batch of text repeated — simulates cat output)
 */
export function plainTextGrid(cols: number, rows: number): Cell[][] {
  const grid = emptyGrid(cols, rows)
  const text = 'Hello, OmniTerm! This is a plain text test. '
  for (let r = 2; r < rows - 2; r++) {
    for (let c = 0; c < Math.min(cols, text.length); c++) {
      grid[r]![c] = { char: text[c]!, style: { ...DEFAULT_STYLE }, skip: false }
    }
  }
  return grid
}

/**
 * Color TUI grid — simulates a colorful terminal app with varied styles
 */
export function colorTuiGrid(cols: number, rows: number): Cell[][] {
  const grid: Cell[][] = []
  const colors = [
    { fg: 196, bold: true }, { fg: 46 }, { fg: 226 },
    { fg: 21, bold: true }, { fg: 201 }, { fg: 118 },
    { fg: 208 }, { fg: 33 }, { fg: 160, bold: true },
  ]

  for (let r = 0; r < rows; r++) {
    grid[r] = []
    for (let c = 0; c < cols; c++) {
      const ci = (r * 3 + c) % colors.length
      const colorFg = colors[ci]!.fg ?? undefined
      const colorBg = colors[(ci + 3) % colors.length]!.fg ?? undefined
      const cStyle = makeStyle({
        fg: colorFg,
        bg: colorBg !== colorFg ? colorBg : undefined,
        bold: c % 5 === 0,
        underline: c === Math.floor(cols / 2) && r === Math.floor(rows / 2),
      })
      // Fill region with varied chars
      const ch = c < 60
        ? `─┌│┐└┘├┤┬┴┼`[(r + c) % 11]
        : String.fromCharCode(0x30 + ((r * 7 + c * 13) % 10))
      grid[r]![c] = { char: ch, style: c < cols - 20 ? cStyle : { ...DEFAULT_STYLE }, skip: false }
    }
    // Trail blank with default style
    for (let c = Math.max(0, cols - 20); c < cols; c++) {
      grid[r]![c] = { char: ' ', style: { ...DEFAULT_STYLE }, skip: false }
    }
  }
  return grid
}

/**
 * Wide character grid — simulates CJK content (each char occupies 2 cells)
 */
export function wideCharGrid(cols: number, rows: number): Cell[][] {
  const grid = emptyGrid(cols, rows)
  const cjk = '你好世界终端渲染性能测试Background测试までことテスト'.repeat(3)
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c += 2) {
      const idx = ((r - 1) * (cols - 2) + c) % cjk.length
      const ch = cjk[idx]!
      grid[r]![c] = { char: ch, style: makeStyle({ wide: true }), skip: false }
      grid[r]![c + 1] = { char: '\u2002', style: makeStyle(), skip: true } // DWC right-cell spacer
    }
  }
  return grid
}
