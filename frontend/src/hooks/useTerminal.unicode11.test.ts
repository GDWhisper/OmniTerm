// Unicode 11 宽表回归（2026-09-09）：
// xterm 默认宽表停留在 Unicode 6，⬛⬜🟥🟩 等方块 emoji 按 1 列渲染，而后端
// alacritty 的 unicode-width 按 2 列布局 grid。cell_frame 编码跳过宽字符占位
// cell 后，前端每个方块少占 1 列 —— 「像素方格」logo 从第一个方块起整体压扁
// 错位。useTerminal 加载 Unicode11Addon 并激活 '11' 宽表后，前端列宽与后端对齐。
//
// 本文件用真实 @xterm/xterm（不 mock），直接验证 buffer 的列宽语义。
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { Unicode11Addon } from '@xterm/addon-unicode11'

async function write(term: Terminal, text: string): Promise<void> {
  await new Promise<void>(resolve => term.write(text, resolve))
}

/** 逐 cell 读取第 0 行的 code/width 序列（宽字符占位 cell 跳过，首个空格截止）。 */
function rowCells(term: Terminal): Array<{ code: number; width: number }> {
  const line = term.buffer.active.getLine(0)
  expect(line).toBeTruthy()
  const cells: Array<{ code: number; width: number }> = []
  for (let i = 0; i < term.cols; i++) {
    const cell = line!.getCell(i)
    if (!cell) break
    if (cell.getWidth() === 0) continue // 宽字符占位 cell
    if (cell.getCode() === 0) break // 行尾空格，内容结束
    cells.push({ code: cell.getCode(), width: cell.getWidth() })
  }
  return cells
}

const BLACK_SQUARE = 0x2b1b // ⬛ Unicode 9 起为 Wide（alacritty 按 2 列布局）
const RED_SQUARE = 0x1f7e5 // 🟥 Unicode 12 起为 Wide（alacritty 按 2 列布局）

describe('xterm unicode11 宽表与后端对齐', () => {
  it('默认宽表把 ⬛ 按 1 列渲染（记录差异来源，修复前基线）', async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    await write(term, 'X⬛')
    // X 在 col 0，⬛ 紧随其后占 1 列 —— 与后端 2 列布局相差 1 列。
    expect(rowCells(term)).toEqual([
      { code: 'X'.codePointAt(0)!, width: 1 },
      { code: BLACK_SQUARE, width: 1 },
    ])
  })

  it('激活 unicode11 后 ⬛🟥 占 2 列，与后端 alacritty 对齐', async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    await write(term, '⬛🟥X')
    // ⬛(2) + 🟥(2) + X(1)：X 落在 col 4，与后端 grid 列号一致。
    expect(rowCells(term)).toEqual([
      { code: BLACK_SQUARE, width: 2 },
      { code: RED_SQUARE, width: 2 },
      { code: 'X'.codePointAt(0)!, width: 1 },
    ])
  })

  it('unicode11 下常规块字符 ▀▄█ 仍为 1 列（不引入回归）', async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    await write(term, '▀▄█X')
    expect(rowCells(term)).toEqual([
      { code: 0x2580, width: 1 },
      { code: 0x2584, width: 1 },
      { code: 0x2588, width: 1 },
      { code: 'X'.codePointAt(0)!, width: 1 },
    ])
  })

  it('unicode11 下 CJK 全角字符仍为 2 列', async () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true })
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    await write(term, '中X')
    expect(rowCells(term)).toEqual([
      { code: 0x4e2d, width: 2 },
      { code: 'X'.codePointAt(0)!, width: 1 },
    ])
  })
})
