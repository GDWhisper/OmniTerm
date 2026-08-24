// Phase 1: cell-frame decoder + 30fps throttle for Pty sessions.
// Phase 3: diff-frame support (row-level delta).
//
// CellFrame wire format per design §9 + Phase 3 node — JSON via WebSocket Text frame.
// Frontend receives cell_frame → renderCellFrame writes ANSI to xterm.js.

import { useCallback, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'

// ──────────────────────────────────────────────────────────
// Wire format types (§9.2, Phase 3 additions)
// ──────────────────────────────────────────────────────────

export interface CursorState {
  row: number
  col: number
  /** DECSCUSR shape code (0-6). Undefined → keep frontend's current shape. */
  shape?: number
  visible: boolean
}

export interface CellData {
  /** SGR 参数体（不含 \x1b[ 前缀和 m 后缀）。空 = 默认样式 */
  sgr: string
  /** 单个 Unicode scalar */
  ch: string
  /** 宽字符占位位：前端应跳过渲染 */
  skip?: boolean
}

export interface CellRow {
  cells: CellData[]
}

export interface CellFrame {
  t: string
  session_id: string
  width: number
  height: number
  /** true = 全帧（覆盖全部 rows）；false = diff 帧（rows 仅含变化行） */
  full: boolean
  cursor?: CursorState
  overlay: boolean
  /** diff 帧时必填：变化行在原 grid 中的 0-based 行号。 */
  row_indices?: number[]
  rows: CellRow[]
}

// ──────────────────────────────────────────────────────────
// Row renderer helpers
// ──────────────────────────────────────────────────────────

const SGR_RESET = '\x1b[0m'

/**
 * Render one row's cells into the chunks buffer.
 *
 * CUP to the target row is done by the caller so that diff frames can
 * EL (erase-to-EOL) before rendering to remove leftover characters.
 */
function renderRowCells(cells: CellData[]): string[] {
  const chunks: string[] = []
  let prevSgr = ''

  for (const cell of cells) {
    if (cell.skip) continue
    if (cell.sgr !== prevSgr) {
      chunks.push(SGR_RESET)
      if (cell.sgr) chunks.push(`\x1b[${cell.sgr}m`)
      prevSgr = cell.sgr
    }
    chunks.push(cell.ch)
  }
  chunks.push(SGR_RESET)
  return chunks
}

function renderCursor(term: Terminal, cursor?: CursorState): void {
  if (!cursor) return
  term.write(`\x1b[${cursor.row};${cursor.col}H`)
  if (cursor.shape !== undefined) {
    term.write(`\x1b[?${cursor.shape}h`)
  }
  term.write(cursor.visible ? '\x1b[?25h' : '\x1b[?25l')
}

// ──────────────────────────────────────────────────────────
// Main renderer
// ──────────────────────────────────────────────────────────

/**
 * Convert cell_frame JSON → ANSI escape sequences on an xterm.js instance.
 *
 * Phase 3 diff support:
 * - `overlay || full`: clear screen + home + render all rows (Phase 1 behavior).
 * - `diff` (`full: false` + `row_indices`): per-row CUP + EL + render only
 *   changed rows; no screen clear.
 */
export function renderCellFrame(term: Terminal, frame: CellFrame): void {
  const isFull = frame.overlay || frame.full
  const chunks: string[] = []

  if (isFull) {
    term.write('\x1b[2J\x1b[H')
    for (let r = 0; r < frame.height; r++) {
      const cells = frame.rows[r]?.cells ?? []
      chunks.push(`\x1b[${r + 1};1H`)
      chunks.push(...renderRowCells(cells))
    }
  } else {
    // Diff frame: render only changed rows (no screen clear)
    const indices = frame.row_indices ?? []
    for (let i = 0; i < indices.length; i++) {
      const rowIdx = indices[i]
      const cells = frame.rows[i]?.cells ?? []
      chunks.push(`\x1b[${rowIdx + 1};1H`)
      chunks.push('\x1b[K') // Erase to end of line — remove stale chars
      chunks.push(...renderRowCells(cells))
    }
  }

  term.write(chunks.join(''))
  renderCursor(term, frame.cursor)
}

// ──────────────────────────────────────────────────────────
// 30fps latest-wins throttle (§10.3)
// ──────────────────────────────────────────────────────────

/**
 * Hook: queue cell_frames, render at most once per rAF.
 *
 * Latest-wins semantics: only the most recent frame in each animation
 * frame is rendered — intermediate states are discarded.
 *
 * Phase 1: backend already sends ≤30fps (timer), but hook protects
 * against future changes (e.g. raw passthrough mode with higher rate).
 */
export function useCellFrame(termRef: React.RefObject<Terminal | null>) {
  const frameQueue = useRef<CellFrame | null>(null)
  const rafId = useRef<number | null>(null)

  const enqueue = useCallback((frame: CellFrame) => {
    frameQueue.current = frame
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null
        const f = frameQueue.current
        if (f && termRef.current) {
          frameQueue.current = null
          renderCellFrame(termRef.current, f)
        }
      })
    }
  }, [termRef])

  return { enqueue }
}
