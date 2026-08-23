// Phase 1: cell-frame decoder + 30fps throttle for Pty sessions.
//
// CellFrame wire format per design §9 — JSON via WebSocket Text frame.
// Frontend receives cell_frame → renderCellFrame writes ANSI to xterm.js.

import { useCallback, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'

// ──────────────────────────────────────────────────────────
// Wire format types (§9.2)
// ──────────────────────────────────────────────────────────

export interface CursorState {
  row: number
  col: number
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
  full: boolean
  cursor?: CursorState
  overlay: boolean
  rows: CellRow[]
}

// ──────────────────────────────────────────────────────────
// Row-batched renderer (§10.2)
// ──────────────────────────────────────────────────────────

const SGR_RESET = '\x1b[0m'

/**
 * Convert cell_frame JSON → ANSI escape sequences on an xterm.js instance.
 *
 * Row-batched: one CUP + style runs + chars per row, with per-row SGR reset.
 * Matches existing `rowBatched` pattern in cellRenderer.ts (Phase R1 verified).
 */
export function renderCellFrame(term: Terminal, frame: CellFrame): void {
  // overlay / full frame: clear screen + home cursor first
  if (frame.overlay || frame.full) {
    term.write('\x1b[2J\x1b[H')
  }

  let prevSgr = ''
  const chunks: string[] = []

  for (let r = 0; r < frame.height; r++) {
    chunks.push(`\x1b[${r + 1};1H`)
    const row = frame.rows[r]?.cells ?? []
    for (const cell of row) {
      if (cell.skip) continue
      if (cell.sgr !== prevSgr) {
        chunks.push(SGR_RESET)
        if (cell.sgr) chunks.push(`\x1b[${cell.sgr}m`)
        prevSgr = cell.sgr
      }
      chunks.push(cell.ch)
    }
    chunks.push(SGR_RESET)
    prevSgr = '' // reset per row (matches render_screen behavior)
  }

  term.write(chunks.join(''))

  if (frame.cursor) {
    term.write(`\x1b[${frame.cursor.row};${frame.cursor.col}H`)
    term.write(frame.cursor.visible ? '\x1b[?25h' : '\x1b[?25l')
  }
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
