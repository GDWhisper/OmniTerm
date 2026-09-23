// Phase 1: cell-frame decoder + 30fps throttle for Pty sessions.
// Phase 3: diff-frame support (row-level delta).
//
// CellFrame wire format per design §9 + Phase 3 node — JSON via WebSocket Text frame.
// Frontend receives cell_frame → renderCellFrame writes ANSI to xterm.js.

import { useCallback, useEffect, useRef } from 'react'
import type { Terminal } from '@xterm/xterm'
// [TERMDBG] 临时诊断埋点（打字延迟排查用，排查完删除）
import { termDebug } from '../utils/termDebug'

/** [TERMDBG] 是否开启临时埋点（仅 DEV）。 */
const TERMDBG = import.meta.env.DEV

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

/**
 * 一行线格数据：行内 RLE 扁平数组 `[sgr, text, sgr, text, ...]`。
 *
 * `sgr` 是 SGR 参数体（不含 \x1b[ 前缀和 m 后缀，空串 = 默认样式），`text` 是
 * 同一 sgr 下的连续字符。宽字符占位 cell 不产生输出（已由后端跳过），故解码
 * 侧无需处理它（`docs/dev/plans/archive/2026-08-28-pty-frame-rle.md` D1/D5）。
 */
export interface CellRow {
  runs: string[]
}

/** 鼠标上报跟踪模式（wire，2026-09-23）：none=关闭 / press=DECSET 1000 /
 *  drag=DECSET 1002 / motion=DECSET 1003。与后端 `TermMode::MOUSE_REPORT_*`
 *  对应（alacritty 使三者互斥）。 */
export type MouseMode = 'none' | 'press' | 'drag' | 'motion'

/** 鼠标上报编码（wire，2026-09-23）：default=X10 风格 / utf8=DECSET 1005 /
 *  sgr=DECSET 1006。 */
export type MouseEncoding = 'default' | 'utf8' | 'sgr'

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
  /** bracketed paste 模式标记（2026-09-06）：所有帧携带，取后端编码时刻
   * 的 `TermMode::BRACKETED_PASTE`。消费方为 useTerminal——与 xterm 实际
   * 状态（`term.modes.bracketedPasteMode`）不一致时写 `?2004h/l` 同步
   * （cell_frame 模式下 raw 流不转发，TUI 的模式序列前端永远收不到，
   * 不同步则多行粘贴被 TUI 逐行当 Enter 提交）。
   * `docs/dev/plans/archive/2026-09-06-pty-bracketed-paste-relay.md` D2/D3。 */
  bracketed_paste?: boolean
  /** 鼠标上报模式真值（2026-09-23）：所有帧携带，取后端编码时刻的
   * `TermMode::MOUSE_REPORT_CLICK/DRAG/MOTION`。与 `bracketed_paste` 同型——
   * cell_frame 模式下 raw 流不转发，TUI 的鼠标上报 DECSET 到不了 xterm，
   * `term.modes.mouseTrackingMode` 恒 'none' 时 useTerminal 的 wheel 放行
   * 分支永不触发、xterm 也不生成 SGR 鼠标上报（opencode 类 TUI 滚轮完全失效
   * 的根因）。消费方为 useTerminal——与 xterm 解析态不一致时写 DECSET 同步。
   * `docs/dev/debug-patterns/terminal-pty.md` 模式 9 家族第三例。 */
  mouse_mode?: MouseMode
  /** 鼠标上报编码（2026-09-23）：所有帧携带，与 `mouse_mode` 同批中继
   * （同 bracketed_paste 形态），取 `TermMode::UTF8_MOUSE/SGR_MOUSE`。 */
  mouse_encoding?: MouseEncoding
  /** 当前 grid 历史行数。所有帧都携带，`scripts/pty-frame-regression.mjs`
   *  T7 守护其「帧帧携带 / 随输出增长 / 上界钳制」契约（诊断与回归判据）。 */
  history_size?: number
  /** 帧序号（2026-09-08 增量同步加固 A2）：仅 live 编码帧携带，会话级
   * 单调递增。入队时校验 `seq == lastSeq + 1`，断链（并发连接偷 diff 基线、
   * 后端重启归零）即主动 resync。viewport/overlay 帧省略此字段——无 seq
   * 帧不占 diff 基线，跳过检测（不校验、不推进 lastSeq）。 */
  seq?: number
  rows: CellRow[]
}

// ──────────────────────────────────────────────────────────
// Row renderer helpers
// ──────────────────────────────────────────────────────────

const SGR_RESET = '\x1b[0m'

/** 畸形 runs（奇数长度）告警只报一次，避免刷屏控制台。 */
let warnedOddRuns = false

/**
 * Render one RLE row into the chunks buffer.
 *
 * The caller has already emitted SGR_RESET before this row, so each run
 * re-establishes its style from a known-clean state. 连续同 sgr 的字符已在
 * 后端合并，故每 run 只切一次样式。
 *
 * CUP to the target row is done by the caller so that diff frames can
 * EL (erase-to-EOL) before rendering to remove leftover characters.
 */
export function renderRow(runs: string[] | undefined): string[] {
  if (!runs) return [SGR_RESET]
  // 奇数长度属协议畸形：忽略末尾不完整的 (sgr, text) 对并告警一次。
  if (runs.length % 2 !== 0 && !warnedOddRuns) {
    warnedOddRuns = true
    console.warn('[cell_frame] odd-length runs array, trailing pair ignored')
  }
  const chunks: string[] = []
  for (let i = 0; i + 1 < runs.length; i += 2) {
    const sgr = runs[i]
    chunks.push(SGR_RESET)
    if (sgr) chunks.push(`\x1b[${sgr}m`)
    chunks.push(runs[i + 1])
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

/**
 * 每个 terminal 最近一次学到的真实光标位置（后端帧显式携带 cursor 时更新）。
 * WeakMap 按 term 实例隔离，会话销毁后自动可回收。
 */
const lastCursorByTerm = new WeakMap<Terminal, CursorState>()

/**
 * 帧渲染后的光标落位。
 *
 * 渲染行内容必然伴随 CUP（全帧逐行 CUP 到 `height` 行；diff 帧 CUP 到各
 * 变化行），渲染结束时 xterm 光标停在**重画终点**而非真实光标处 —— 全帧
 * 终点即底行行尾（右下角）。后端对 cursor 做去重（与上次编码值相同则
 * 省略字段），因此「带 rows 但不带 cursor」的帧是常态：不回写的话，光标
 * 每次全帧/diff 渲染后都会停在重画终点，直到下一次光标实际变化才恢复
 * （症状：打字间歇/状态栏更新时光标闪跳右下角）。
 *
 * - 帧显式携带 cursor：以其为准；同时学习（viewport 历史窗口帧的光标
 *   不是 live 光标，不学习；`viewport === 0` 的回底校准帧携带的就是真实
 *   光标，学习）。
 * - 帧缺 cursor 且本帧渲染了行：回写上次学习的位置，抵消渲染污染。
 *   全帧必然渲染行（循环执行即污染）；diff 帧仅在 `row_indices` 非空时。
 */
function applyCursor(term: Terminal, frame: CellFrame, renderedRows: boolean): void {
  if (frame.cursor) {
    renderCursor(term, frame.cursor)
    if (frame.viewport == null || frame.viewport === 0) {
      lastCursorByTerm.set(term, frame.cursor)
    }
    return
  }
  if (!renderedRows) return
  const last = lastCursorByTerm.get(term)
  if (last) renderCursor(term, last)
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
      chunks.push(`\x1b[${r + 1};1H`)
      chunks.push('\x1b[K')
      chunks.push(SGR_RESET)
      chunks.push(...renderRow(frame.rows[r]?.runs))
    }
    if (TERMDBG) termDebug.noteWrite()
    term.write(chunks.join(''))
    applyCursor(term, frame, true)
    return
  }

  // Diff frame: render only changed rows (no screen clear).
  // SGR reset before each row prevents style leakage from the previous
  // frame's terminal state.
  const indices = frame.row_indices ?? []
  for (let i = 0; i < indices.length; i++) {
    const rowIdx = indices[i]
    chunks.push(`\x1b[${rowIdx + 1};1H`)
    chunks.push('\x1b[K')  // Erase to end of line — remove stale chars
    chunks.push(SGR_RESET)
    chunks.push(...renderRow(frame.rows[i]?.runs))
  }
  if (TERMDBG) termDebug.noteWrite()
  term.write(chunks.join(''))
  applyCursor(term, frame, indices.length > 0)
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
 * 按序渲染全部积压帧；仅当积压超过上限（渲染跟不上）时才清空积压，
 * 并保证「清空必有重同步在途」（见 armResync / 超限分支注释）。
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
  const resyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 最近一帧的 seq（A2）：null = 尚未见过带 seq 的帧（首帧直接接受）。 */
  const lastSeq = useRef<number | null>(null)

  // 卸载时清掉补发定时器，避免卸载后触发 requestResync。
  useEffect(
    () => () => {
      if (resyncTimer.current != null) clearTimeout(resyncTimer.current)
    },
    [],
  )

  /**
   * 清空积压后的重同步：节流防刷屏（隐藏标签页等场景 rAF 停摆会持续
   * 超限），但**节流窗口内的清空必须补发**——「清空必有重同步在途」是
   * 画面自愈的不变式。补发若也被吞，丢失的 diff 帧永久无恢复：后端基线
   * 已前进不会重发，画面冻结/错位在旧状态，直到切换会话经补屏全帧才
   * 恢复（TUI 启动错位的根因）。
   */
  const armResync = useCallback(() => {
    if (resyncTimer.current != null) return // 补发已在途，到点必发
    const now = performance.now()
    const wait = RESYNC_THROTTLE_MS - (now - lastResyncAt.current)
    if (wait <= 0) {
      lastResyncAt.current = now
      requestResync?.()
      return
    }
    resyncTimer.current = setTimeout(() => {
      resyncTimer.current = null
      lastResyncAt.current = performance.now()
      requestResync?.()
    }, wait)
  }, [requestResync])

  const enqueue = useCallback(
    (frame: CellFrame) => {
      // seq 连续性校验（A2）：断链 ≡ diff 基线被并发连接消费（缺陷 1 的
      // 直接信号）或后端重启归零，随后 diff 帧不可信 → 主动 resync 请求
      // 全帧。复用 armResync 的节流 + 补发定时器，天然限频。无 seq 帧
      // （viewport/overlay）不占 diff 基线，跳过检测且不推进 lastSeq，
      // 保持与最近 live 帧的连续性判断。首帧（lastSeq 为 null）直接接受。
      if (frame.seq != null) {
        if (lastSeq.current != null && frame.seq !== lastSeq.current + 1) {
          armResync()
        }
        lastSeq.current = frame.seq
      }
      const q = frameQueue.current
      if (q.length >= MAX_PENDING_FRAMES) {
        // 渲染跟不上产出。full/overlay 帧自含完整屏幕状态，是积压中唯一的
        // 自愈锚点：保留**最后一个** full（其后 diff 的基线是它），只丢弃
        // 它之前的 diff（将被 full 覆盖，丢弃无损）——保留的 full 渲染即
        // 恢复，本次清空自带重同步，无需请求。
        let keepFrom = -1
        for (let i = q.length - 1; i >= 0; i--) {
          if (q[i].overlay || q[i].full) {
            keepFrom = i
            break
          }
        }
        if (keepFrom > 0 && q.length - keepFrom < MAX_PENDING_FRAMES) {
          // 瘦身有效：丢 full 之前的 diff（将被 full 覆盖），保留 full 及其后。
          q.splice(0, keepFrom)
        } else if (keepFrom === 0) {
          // full 在队首：保留它（下一个渲染批次立即恢复画面），丢弃其后
          // 的 diff——它们的基线是 full，丢失的增量由重同步全帧覆盖。
          q.length = 1
          armResync()
        } else {
          // 队列全是 diff：清空并请求后端作废 diff 基线、重发全帧。
          q.length = 0
          armResync()
        }
      }
      // 瘦身/清空后当前帧照常入队：diff 帧的中间变化不可丢，丢一帧 =
      // 永久丢那次行变化（后端基线已前进，不会重发）。
      if (TERMDBG) termDebug.stamp(frame)
      q.push(frame)
      if (rafId.current == null) {
        rafId.current = requestAnimationFrame(() => {
          rafId.current = null
          const term = termRef.current
          const frames = frameQueue.current
          frameQueue.current = []
          if (!term) return
          for (const f of frames) {
            if (TERMDBG) {
              const arrivedAt = (f as { __t?: number }).__t
              termDebug.noteFrameRender(
                arrivedAt ? performance.now() - arrivedAt : 0,
                frames.length,
              )
            }
            renderCellFrame(term, f)
          }
        })
      }
    },
    [termRef, armResync],
  )

  return { enqueue }
}
