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
  /** 历史窗口帧标记（方案 C）：本帧展示的历史窗口偏移（行，0 = live 屏）。
   * 仅 viewport_request 的响应帧携带；消费方为 ViewportController。 */
  viewport?: number
  /** alt-screen 激活标记（方案 C D4）：仅 overlay 帧携带；消费方为
   * ViewportController（alt-screen 期间禁用滚轮接管）。 */
  alt_screen?: boolean
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

  // Full frame: render every row with CUP + EL + content (no screen
  // clear).  Erase-to-EOL removes any stale characters left over from a
  // previous wider/longer frame so a shrink-then-grow cycle stays clean.
  // Skipping ESC[2J preserves scrollback — a full frame is a complete
  // repaint of the visible screen, not an "erase everything" command.
  if (isFull) {
    for (let r = 0; r < frame.height; r++) {
      const cells = frame.rows[r]?.cells ?? []
      chunks.push(`\x1b[${r + 1};1H`)
      chunks.push('\x1b[K')
      chunks.push(SGR_RESET)
      chunks.push(...renderRowCells(cells))
    }
    term.write(chunks.join(''))
    if (frame.cursor) {
      renderCursor(term, frame.cursor)
    }
    return
  }

  // Diff frame: render only changed rows (no screen clear).
  // SGR reset before each row prevents style leakage from the previous
  // frame's terminal state.
  const indices = frame.row_indices ?? []
  for (let i = 0; i < indices.length; i++) {
    const rowIdx = indices[i]
    const cells = frame.rows[i]?.cells ?? []
    chunks.push(`\x1b[${rowIdx + 1};1H`)
    chunks.push('\x1b[K')  // Erase to end of line — remove stale chars
    chunks.push(SGR_RESET)
    chunks.push(...renderRowCells(cells))
  }
  term.write(chunks.join(''))
  if (frame.cursor) {
    renderCursor(term, frame.cursor)
  }
}

// ──────────────────────────────────────────────────────────
// Ordered frame queue (§10.3 修订)
// ──────────────────────────────────────────────────────────

/** 待渲染帧上限。超限 = 渲染跟不上产出，清空积压并请求全帧重同步。 */
const MAX_PENDING_FRAMES = 120

/** resync 请求节流窗口：隐藏标签页等场景 rAF 停摆会持续超限，防刷屏。 */
const RESYNC_THROTTLE_MS = 1000

/**
 * Hook: queue cell_frames, render all pending frames in order once per rAF.
 *
 * diff 帧相对上一帧的编码基线，**中间帧不可丢弃**——丢掉即永久丢失那次
 * 行变化（症状：连按回车丢行，切换会话经补屏全帧才恢复）。故每个 rAF
 * 按序渲染全部积压帧；仅当积压超过上限（渲染跟不上）时清空队列并请求
 * 后端作废 diff 基线、下一帧发全帧兜底。
 *
 * 滚动期的帧丢弃（方案 C D3：viewport 模式下实时帧不渲染）由
 * ViewportController.acceptFrame 在入队前门控，本 hook 不感知滚动状态。
 */
export function useCellFrame(
  termRef: React.RefObject<Terminal | null>,
  requestResync?: () => void,
) {
  const frameQueue = useRef<CellFrame[]>([])
  const rafId = useRef<number | null>(null)
  const lastResyncAt = useRef(0)

  const enqueue = useCallback((frame: CellFrame) => {
    const q = frameQueue.current
    if (q.length >= MAX_PENDING_FRAMES) {
      q.length = 0
      const now = performance.now()
      if (now - lastResyncAt.current >= RESYNC_THROTTLE_MS) {
        lastResyncAt.current = now
        requestResync?.()
      }
      return
    }
    q.push(frame)
    if (rafId.current == null) {
      rafId.current = requestAnimationFrame(() => {
        rafId.current = null
        const term = termRef.current
        const frames = frameQueue.current
        frameQueue.current = []
        if (!term) return
        for (const f of frames) renderCellFrame(term, f)
      })
    }
  }, [termRef, requestResync])

  return { enqueue }
}
