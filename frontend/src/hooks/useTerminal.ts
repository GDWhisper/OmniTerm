import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { useAttention } from './useAttention'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../stores/appStore'
import { useToastStore } from '../stores/toastStore'
import { copyText } from '../utils/clipboard'
import { READER_FONT } from '../utils/fonts'
import { syncTextareaInputMode } from '../utils/terminalInputMode'
import { attachTouchScroll } from '../utils/touchScroll'
import { rewriteLocalUrl } from '../utils/proxyUrl'
import { isTerminalAutoResponse } from '../utils/ptyInputFilter'
import { ViewportController } from '../utils/viewportController'
import { useCellFrame, type CellFrame } from './useCellFrame'

// Eagerly preload xterm addons at module level. The dynamic imports start
// fetching immediately when this module is evaluated, so by the time
// createTerminal runs the addons are already resolved — no async gap.
// This keeps the code-splitting benefit (addons in separate chunks)
// while keeping createTerminal synchronous (no yield window for CSS
// transitions / font swaps to change the container size mid-init).
const importAddons = () =>
  Promise.all([import('@xterm/addon-fit'), import('@xterm/addon-web-links')])
let addonsPromise = importAddons()

/** 方案 C D8：滚轮接管总开关（行为级切换，无中间态可灰度）。置 '0' 关闭
 *  接管（wheel 交回 xterm 默认路径）；其余值/缺省开启。Phase 3 回归后移除。 */
const VIEWPORT_TAKEOVER_ENABLED = import.meta.env.VITE_TERMINAL_SCROLLBACK_VIEWPORT !== '0'

/**
 * 帧内是否含变化行。30fps 的 tick 帧多数是空 diff 帧（仅光标移动），
 * 该判据决定历史视口是否需要重拉窗口与提示新输出，避免无谓的窗口请求。
 * 全帧 / overlay 帧是整屏重绘，`rows` 非空即视为有变化。
 */
function hasRowChange(f: CellFrame): boolean {
  if (f.overlay || f.full) return f.rows.length > 0
  return (f.row_indices?.length ?? f.rows.length) > 0
}

/** 当前字号下一行的像素高度（viewport 控制器像素 wheel 换算用）。渲染服务
 *  尺寸首帧前不可用，退回字号×行高比估算。 */
function cellHeightPx(term: Terminal): number {
  const core = (
    term as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } }
    }
  )._core
  const h = core?._renderService?.dimensions?.css?.cell?.height
  return h && h > 0 ? h : (term.options.fontSize ?? 14) * 1.35
}

async function loadAddons(): Promise<[typeof FitAddon, typeof import('@xterm/addon-web-links').WebLinksAddon]> {
  let mods: [typeof import('@xterm/addon-fit'), typeof import('@xterm/addon-web-links')]
  try {
    mods = await addonsPromise
  } catch {
    // The cached import rejected (e.g. stale chunk 404 after a redeploy).
    // Re-import so a reconnect click can recover without a page refresh.
    addonsPromise = importAddons()
    mods = await addonsPromise
  }
  const [{ FitAddon }, { WebLinksAddon }] = mods
  return [FitAddon, WebLinksAddon]
}

interface UseTerminalOptions {
  sessionId: string | null
  externalSessionName?: string | null
  /** Session engine: 'pty' 会话不注入 tmux copy-mode/prefix 字节，滚动走
   *  xterm 本地 scrollback；缺省（含 external 会话）按 tmux 处理。 */
  runtimeKind?: 'tmux' | 'pty' | 'acp'
  fontSize?: number
  onTitleChange?: (title: string) => void
  /** Ref tracking the currently-latched modifier key (Ctrl/Shift/Alt) from MobileKeyBar */
  latchModRef?: React.MutableRefObject<string | null>
  /** Called when a latched modifier has been consumed by keyboard input */
  onConsumeLatch?: () => void
  /** 终端就绪 / 切换会话后自动聚焦，使用户可直接键入。移动端须传 false：
   *  聚焦 xterm 隐藏 textarea 会弹起软键盘，遮住刚切过去的终端（见
   *  utils/terminalInputMode.ts）。 */
  autoFocus?: boolean
}

const DARK_TERMINAL_THEME = {
  background: '#12141A',
  foreground: '#D1D5DB',
  cursor: '#58A6FF',
  selectionBackground: 'rgba(88, 166, 255, 0.25)',
  black: '#12141A',
  red: '#FF7B72',
  green: '#7EE787',
  yellow: '#FFA657',
  blue: '#58A6FF',
  magenta: '#F778BA',
  cyan: '#79C0FF',
  white: '#D1D5DB',
  brightBlack: '#484F58',
  brightRed: '#FFA198',
  brightGreen: '#A5D6A7',
  brightYellow: '#FFCB6B',
  brightBlue: '#79C0FF',
  brightMagenta: '#FF9BCE',
  brightCyan: '#A5D8FF',
  brightWhite: '#E6EDF3',
}

/** Translate a typed character through a latched modifier from MobileKeyBar. */
function translateLatch(latch: string, data: string): string {
  switch (latch) {
    case 'ctrl':
      // Standard Ctrl mapping: ASCII charCode & 0x1f gives the control character
      return String.fromCharCode(data.charCodeAt(0) & 0x1f)
    case 'shift':
      return data.toUpperCase()
    case 'alt':
      return '\x1b' + data
    default:
      return data
  }
}

export function useTerminal({ sessionId, externalSessionName, runtimeKind, fontSize = 14, onTitleChange, latchModRef, onConsumeLatch, autoFocus = false }: UseTerminalOptions) {
  const { i18n } = useTranslation()
  const attention = useAttention()  // Agent attention context
  // Blur / idle disconnect timeouts (minutes). Read reactively from the store;
  // each timer reads the value when it is armed and keeps it for that firing.
  const blurDisconnectMin = useAppStore((s) => s.blurDisconnectMin)
  const idleDisconnectMin = useAppStore((s) => s.idleDisconnectMin)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // 前端丢帧后请求后端作废 diff 基线、下一帧发全帧（useCellFrame 超限路径）
  const requestResync = useCallback(() => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resync' }))
    }
  }, [])
  // ── 滚动状态：pty 与 tmux 各持一份，互不共享 ──
  // 两侧语义本就不同（pty = 已滚离 live 底部；tmux = 处于 copy-mode），且
  // pty 后续改造不得波及 tmux 路径，故不复用同一个 state。对外统一出口见
  // 下方 `scrollMode` selector（按 runtimeKind 取源）。
  /** pty：由 ViewportController.onModeChange 驱动（方案 C D3 状态机）。 */
  const [ptyScrollMode, setPtyScrollMode] = useState(false)
  // pty 历史视口模式下是否有未查看的新输出（驱动「回到底部」提示条）
  const [ptyNewOutput, setPtyNewOutput] = useState(false)
  /** tmux：由 copy-mode 进入/退出驱动。UI 渲染用；即时真值见 tmuxScrollModeRef。 */
  const [tmuxScrollMode, setTmuxScrollMode] = useState(false)
  /** 对外统一出口（MobileKeyBar 高亮 / 方向键分流 / inputmode 同步都读它）。
   *  缺省按 tmux，与 runtimeKindRef 的缺省约定一致（external 会话恒为 tmux）。 */
  const scrollMode = runtimeKind === 'pty' ? ptyScrollMode : tmuxScrollMode
  const scrollModeRef = useRef(false)
  useEffect(() => { scrollModeRef.current = scrollMode }, [scrollMode])
  // 方案 C Phase 2：历史视口控制器（lazy ref；实例跨会话/重连复用，状态由
  // reset() 归位）。pty 会话滚轮/翻页经它请求后端历史窗口帧。
  const viewportCtlRef = useRef<ViewportController | null>(null)
  if (viewportCtlRef.current === null) {
    viewportCtlRef.current = new ViewportController({
      sendRequest: (y) => {
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'viewport_request', y }))
        }
      },
      onModeChange: setPtyScrollMode,
      onLiveRestore: requestResync,
      onNewOutput: setPtyNewOutput,
    })
  }
  const { enqueue: enqueueCellFrame } = useCellFrame(termRef, requestResync)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const composingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const externalSessionRef = useRef<string | null>(null)
  const listenerDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const observerRef = useRef<ResizeObserver | null>(null)
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mouseUpHandlerRef = useRef<(() => void) | null>(null)
  const touchScrollCleanupRef = useRef<(() => void) | null>(null)
  const keyHandlerAttachedRef = useRef(false)
  // Track whether tmux is in copy/scroll mode (for touch-scroll fallback).
  // 即时真值（同一手势内多次 touchmove 需立即读到新值，否则会重复发
  // Ctrl+B [ 进 copy-mode）；`tmuxScrollMode` 是它的 UI 渲染副本。
  const tmuxScrollModeRef = useRef(false)
  // Track terminal readiness so WS effects re-run after initTerminal creates the terminal.
  const [terminalReady, setTerminalReady] = useState(false)
  // Timers for delayed disconnect on blur / idle.
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isFocusedRef = useRef(true)
  // lastActivityRef must be initialized lazily (not during render) to satisfy
  // React compiler purity rules. We seed it on mount via a no-op effect.
  const lastActivityRef = useRef<number>(0)
  useEffect(() => {
    lastActivityRef.current = Date.now()
  }, [])
  // AbortController for createTerminal — abort on cleanup to cancel in-flight
  // creation (e.g., React StrictMode double-mount or rapid session switch).
  // A fresh controller is created for each initTerminal call.
  const abortRef = useRef<AbortController | null>(null)
  // Guards against concurrent terminal (re)creation. After a blur/idle
  // disconnect the term ref is nulled, so `initTerminal`'s `termRef.current`
  // guard can't stop a second (rapid) click from also entering
  // createTerminal — that would call term.open() twice on the same container
  // and corrupt the instance (reconnect appears to do nothing). This flag
  // serializes (re)creation regardless of term ref state.
  const initializingRef = useRef(false)
  // Stable ref for the consume-latch callback so connectWs closure is current
  const consumeLatchRef = useRef(onConsumeLatch)
  consumeLatchRef.current = onConsumeLatch

  const connectWs = useCallback(() => {
    const term = termRef.current
    const id = externalSessionName ?? sessionId
    if (!id || !term) return

    // Close existing connection
    const wasConnected = wsRef.current !== null
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      wsRef.current.close()
      wsRef.current = null
    }

    // Reset terminal immediately on session switch so the old session's
    // scrollback / SGR state can't bleed into the new session's first
    // cell_frame.  The onmessage handler also resets on first frame as a
    // safety net, but that fires AFTER the frame is decoded — too late to
    // prevent a flash of stale content.
    if (wasConnected) {
      termRef.current?.reset()
    }
    // 方案 C：会话切换/重连后视口控制器无条件回 live 初态（不发请求）
    viewportCtlRef.current?.reset()

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const path = externalSessionName
      ? `/api/v1/ws/terminal/external/${encodeURIComponent(externalSessionName)}`
      : `/api/v1/ws/terminal/${sessionId}`
    const ws = new WebSocket(
      `${protocol}//${window.location.host}${path}?cols=${term.cols}&rows=${term.rows}`
    )
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      useAppStore.getState().setConnected(true)
      useAppStore.getState().setTerminalDisconnected(false)
      termRef.current?.writeln(`\x1b[32m[${i18n.t('terminal.status.connected')}]\x1b[0m`)
      // Phase 1: 声明 cell_frame 支持（§4.2 hello 握手）。开启后收到的
      // cell_frame 一律是 runs 行编码（`docs/dev/plans/2026-08-28-pty-frame-rle.md`）。
      ws.send(JSON.stringify({ t: 'hello', supports_cell_frame: true }))
    }

    // Every connection spawns a fresh tmux client whose attach starts with a
    // full-screen redraw. Wipe the previous buffer when that redraw lands
    // (first binary frame) instead of at WS open: on session switch/reconnect
    // the old content stays visible until the new content arrives, so the
    // swap is one frame instead of a blank gap while the redraw is in flight
    // (prevents the ~250ms flicker; reset still guarantees a clean slate for
    // the redraw and wipes stale scrollback — see docs/dev/debug-guide.md).
    let sawFirstBinary = false
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        if (!sawFirstBinary) {
          sawFirstBinary = true
          termRef.current?.reset()
        }
        termRef.current?.write(new Uint8Array(e.data))
      } else {
        try {
          const msg = JSON.parse(e.data)
          if (msg.t === 'cell_frame') {
            if (!sawFirstBinary) {
              sawFirstBinary = true
              termRef.current?.reset()
            }
            // 方案 C D3：viewport 模式下实时帧由控制器门控丢弃；alt_screen
            // 标记（D4）也在 acceptFrame 内消费——即使帧被丢弃状态仍同步。
            // 被丢弃的实时帧 = 后端有新输出，通知控制器按绝对锚点重拉窗
            // 口，否则视口会永久停在上翻时刻的快照（新输出完全不可见）。
            const ctl = viewportCtlRef.current
            if (!ctl || ctl.acceptFrame(msg)) enqueueCellFrame(msg)
            else ctl.notifyLiveOutput(hasRowChange(msg))
            return
          }
          if (msg.type === 'attached') {
            termRef.current?.writeln(`\x1b[36m[${i18n.t('terminal.status.attached', { session: msg.session })}]\x1b[0m`)
          } else if (msg.type === 'error') {
            termRef.current?.writeln(`\x1b[31m[${i18n.t('terminal.status.error', { msg: msg.message })}]\x1b[0m`)
          } else if (msg.type === 'exit') {
            termRef.current?.writeln(`\x1b[31m[${i18n.t('terminal.status.exited', { code: msg.code })}]\x1b[0m`)
          } else if (msg.type === 'agent_state') {
            // Fire attention notification on state transitions
            if (!sessionId) return
            const attnReason = msg.attention_reason
            if (attnReason === 'decision' || attnReason === 'done' || attnReason === 'error') {
              attention.fire(sessionId, sessionId, attnReason)
            } else if (msg.state === 'running') {
              attention.clearAlert(sessionId)
            }
          }
        } catch {
          // Non-JSON websocket frames (e.g. binary echo) are not terminal messages — ignore.
        }
      }
    }

    ws.onclose = () => {
      // A superseded socket (replaced by a newer connectWs call) may fire
      // late close/error events — they must not clobber the new connection.
      if (wsRef.current !== ws) return
      useAppStore.getState().setTerminalDisconnected(true)
      tmuxScrollModeRef.current = false
      termRef.current?.writeln(`\x1b[31m[${i18n.t('terminal.status.disconnected')}]\x1b[0m`)
    }

    ws.onerror = () => {
      if (wsRef.current !== ws) return
      useAppStore.getState().setTerminalDisconnected(true)
      termRef.current?.writeln(`\x1b[31m[${i18n.t('terminal.status.connectionError')}]\x1b[0m`)
    }

    // Dispose previous listeners to avoid accumulation on session switch
    listenerDisposablesRef.current.forEach((d) => d?.dispose())
    listenerDisposablesRef.current = []

    // Send terminal input to WS (skip during IME composition).
    // When a modifier key is latched via MobileKeyBar (Ctrl/Shift/Alt),
    // translate the typed character into the corresponding escape sequence
    // before sending.
    listenerDisposablesRef.current.push(
      term.onData((data) => {
        if (ws.readyState !== WebSocket.OPEN) return
        // 真实终端语义：输入时光标必须在活动行，故任何按键都把视口拉回
        // 底部——否则在 TUI 程序（top 等）里滚一下就再也回不去 live。
        viewportCtlRef.current?.scrollToLive()
        // pty 双终端模拟器架构：查询类序列的应答由后端 VT 统一回写 PTY，
        // 前端 xterm 的自动应答是纯重复，tmux 对迟到重复应答会透传回显
        // （症状：会话切换后屏幕冒出 1;2c1;2c，详见 ptyInputFilter.ts 顶部）。
        // tmux/外部会话不过滤 —— 那里前端 xterm 是唯一终端模拟器，应答必需。
        if (runtimeKindRef.current === 'pty' && isTerminalAutoResponse(data)) return
        // During IME composition, xterm emits intermediate (half-finished)
        // text. Always drop it — whether or not a modifier is latched. The
        // final committed text is re-emitted by xterm via onData AFTER
        // compositionend (with composingRef already false), so the latched
        // combo is sent then, not lost.
        if (composingRef.current) return
        const latch = latchModRef?.current
        if (latch) {
          // A modifier is latched (Ctrl/Alt/Shift from MobileKeyBar). Translate
          // the typed character into the corresponding control sequence and
          // send it. On mobile, soft-keyboard typing of a letter (e.g. after
          // locking Ctrl) reaches here once composition ends, so Ctrl+C etc.
          // now reach the terminal instead of being silently dropped.
          const translated = translateLatch(latch, data)
          ws.send(new TextEncoder().encode(translated))
          consumeLatchRef.current?.()
        } else {
          ws.send(new TextEncoder().encode(data))
        }
      })
    )

    // Send resize events
    listenerDisposablesRef.current.push(
      term.onResize(({ cols, rows }) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols, rows }))
        }
      })
    )

    // Modern keybinding interception
    // Guard against duplicate registration (React StrictMode double-invokes effects).
    // attachCustomKeyEventHandler returns void, so we track via ref.
    if (!keyHandlerAttachedRef.current) {
      keyHandlerAttachedRef.current = true
    term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        // Read the current WS from the ref (not closure) so session-switch
        // always targets the live connection.
        const ws = wsRef.current
        if (!ws || ws.readyState !== WebSocket.OPEN) return true

        // Only intercept in modern mode — and only for tmux sessions: the
        // shortcuts inject tmux prefix bytes (\x02...), which a pty session
        // has no concept of (D12 分流).
        const mode = useAppStore.getState().keybindingMode
        if (mode !== 'modern' || runtimeKindRef.current === 'pty') return true

        // Only handle keydown, ignore keyup to prevent double-trigger
        if (ev.type !== 'keydown') return true

        // Debounce: ignore key repeat events
        if (ev.repeat) return true

        const ctrl = ev.ctrlKey
        const shift = ev.shiftKey
        const alt = ev.altKey
        const key = ev.key

        // Ctrl+Shift+Right → horizontal split
        if (ctrl && shift && !alt && key === 'ArrowRight') {
          wsRef.current?.send(new TextEncoder().encode('\x02%'))
          return false
        }
        // Ctrl+Shift+Down → vertical split
        if (ctrl && shift && !alt && key === 'ArrowDown') {
          wsRef.current?.send(new TextEncoder().encode('\x02"'))
          return false
        }
        // Ctrl+Shift+Q → new window
        if (ctrl && shift && !alt && key === 'Q') {
          wsRef.current?.send(new TextEncoder().encode('\x02c'))
          return false
        }
        // Ctrl+Shift+X → close pane (send kill-pane + auto-confirm 'y')
        if (ctrl && shift && !alt && key === 'X') {
          wsRef.current?.send(new TextEncoder().encode('\x02x'))
          // Auto-confirm the tmux kill-pane prompt
          setTimeout(() => {
            wsRef.current?.send(new TextEncoder().encode('y\n'))
          }, 50)
          return false
        }

        return true // not intercepted — let xterm handle normally
      })
    } // end keyHandlerAttachedRef guard

    sessionIdRef.current = sessionId
    externalSessionRef.current = externalSessionName ?? null
  }, [sessionId, externalSessionName])

  /** Send raw data to the terminal's WebSocket if connected */
  const sendData = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(data))
    }
  }, [])

  // Register sendData in the app store so cross-component features (e.g.
  // Settings > Terminal > Mouse Mode toggle) can send tmux commands.
  // Only the most recently mounted terminal will be registered.
  useEffect(() => {
    useAppStore.getState().setTerminalSendData(sendData)
    return () => useAppStore.getState().setTerminalSendData(null)
  }, [sendData])

  /** Enter tmux copy mode (if not already) and scroll one page in the given direction.
   *  Uses the real tmux copy-mode state (tmuxScrollModeRef) as the source of
   *  truth, not the React `scrollMode` flag, so pagging always works after the
   *  user has toggled scroll on via the UI button.
   *
   *  pty 会话分流：pty 无 copy-mode 语义，翻页走 ViewportController.pageScroll
   *  （后端历史窗口帧）；其滚动状态由 ViewportController.onModeChange 驱动，
   *  与 tmux 的 tmuxScrollMode / tmuxScrollModeRef 完全无关。 */
  const sendScrollKeys = useCallback((direction: 'up' | 'down') => {
    if (runtimeKindRef.current === 'pty') {
      const term = termRef.current
      if (!term) return
      const page = Math.max(1, term.rows - 1)
      // 方案 C：WS 可用时翻页走后端历史窗口；离线退回本地 scrollback
      // 滚动（两者在离线态都无内容可见，仅为行为兜底）。
      if (wsRef.current?.readyState === WebSocket.OPEN && viewportCtlRef.current) {
        viewportCtlRef.current.pageScroll(direction === 'up' ? -1 : 1, page)
        return
      }
      term.scrollLines(direction === 'up' ? -page : page)
      return
    }
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!tmuxScrollModeRef.current) {
      // tmux prefix is Ctrl+B (0x02), then [ enters copy mode
      ws.send(new TextEncoder().encode('\x02['))
      tmuxScrollModeRef.current = true
      setTmuxScrollMode(true)
    }
    const key = direction === 'up' ? '\x1b[5~' : '\x1b[6~' // PageUp / PageDown
    ws.send(new TextEncoder().encode(key))
  }, [])

  /** Exit tmux copy mode — only if we believe tmux is actually in copy mode.
   *
   *  Sends Escape instead of `q`: tmux's default copy-mode key table binds
   *  both to cancel, but `q` gets *typed into the shell* if tmux already left
   *  copy mode (the touch-scroll path enters `copy-mode -e`, which auto-exits
   *  when scrolled back to the bottom of history — we cannot detect that), while
   *  a lone Escape is a no-op in a shell command line. */
  const exitScrollMode = useCallback(() => {
    if (runtimeKindRef.current === 'pty') {
      // pty 分流：方案 C，回底 = 恢复 live（控制器触发 resync 全帧重绘）
      viewportCtlRef.current?.scrollToLive()
      return
    }
    if (!tmuxScrollModeRef.current) {
      setTmuxScrollMode(false)
      return
    }
    sendData('\x1b')
    tmuxScrollModeRef.current = false
    setTmuxScrollMode(false)
  }, [sendData])

  /** Dispose the current terminal and all associated resources */
  const disposeTerminal = useCallback(() => {
    // Abort any in-flight createTerminal (e.g., StrictMode double-mount).
    // If createTerminal already completed, this is a no-op (signal was never
    // checked after the await). If it's still in-flight, createTerminal will
    // check the signal after loadAddons() and bail out before term.open().
    abortRef.current?.abort()
    abortRef.current = null
    observerRef.current?.disconnect()
    observerRef.current = null
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = null
    }
    if (mouseUpHandlerRef.current) {
      mouseUpHandlerRef.current()
      mouseUpHandlerRef.current = null
    }
    if (touchScrollCleanupRef.current) {
      touchScrollCleanupRef.current()
      touchScrollCleanupRef.current = null
    }
    keyHandlerAttachedRef.current = false
    listenerDisposablesRef.current.forEach((d) => d?.dispose())
    listenerDisposablesRef.current = []
    tmuxScrollModeRef.current = false
    // Clear any pending disconnect timers so we don't race against cleanup.
    if (blurTimerRef.current) {
      clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      wsRef.current.close()
      wsRef.current = null
    }
    if (termRef.current) {
      termRef.current.dispose()
      termRef.current = null
    }
    fitRef.current = null
    sessionIdRef.current = null
    setTerminalReady(false)
    initializingRef.current = false
  }, [])

  // Ref to supply the current font size to createTerminal without making
  // it a reactive dependency (avoids destroying the terminal on every
  // font-size change — the live-update effect handles that in-place).
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize

  // Mirror runtimeKind for long-lived closures (custom key handler / scroll
  // callbacks / createTerminal) — same pattern as fontSizeRef. 缺省按 tmux：
  // external 会话恒为 tmux（D6 冻结边界）。
  const runtimeKindRef = useRef(runtimeKind)
  runtimeKindRef.current = runtimeKind

  /** Create a terminal on the given container and return a cleanup function.
   *
   * The addon imports are preloaded at module level, so `await loadAddons()`
   * resolves immediately — no yield window for CSS transitions or font swaps
   * to change the container size between `new Terminal` and `term.open`.
   *
   * The AbortController signal guards against React StrictMode double-mount:
   * cleanup aborts the signal, and createTerminal checks it after loadAddons()
   * before doing any DOM/ref work. Without this, StrictMode calls term.open()
   * twice on the same container, corrupting xterm internal state. */
  const createTerminal = useCallback(async (container: HTMLDivElement, signal: AbortSignal) => {
    const [FitAddon, WebLinksAddon] = await loadAddons()

    // StrictMode guard: if cleanup aborted the signal while we were awaiting
    // addons, bail out before touching the DOM or refs.
    if (signal.aborted) {
      return
    }

    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSizeRef.current,
      fontFamily: READER_FONT,
      theme: DARK_TERMINAL_THEME,
      // Match the backend VT scrollback (VT_SCROLLBACK_LINES = 1000 in
      // src/engine/pty/vt.rs) so the xterm scrollback depth equals what
      // the PTY grid can produce.  Without this, xterm defaults to 1000
      // anyway — explicit here for clarity and to catch divergences at
      // review time if the backend constant changes.
      scrollback: 1000,
    })

    const fit = new FitAddon()
    // WebLinksAddon handler 接管链接点击：本机 localhost 链接重写为
    // /proxy/{port}/（端口转发代理），其余走默认新标签打开。
    // 已知限制：addon 内部用 `new URL()` 校验，无法识别无 scheme 的裸
    // `localhost:3000`（只识别 http(s):// 开头的链接），见计划风险表降级。
    const webLinks = new WebLinksAddon((_event, uri) => {
      const rewritten = rewriteLocalUrl(uri)
      window.open(rewritten ?? uri, '_blank', 'noopener')
    })

    term.loadAddon(fit)
    term.loadAddon(webLinks)
    term.open(container)

    // Mobile fit correction. FitAddon measures the container's border-box
    // (padding included, never subtracted) and always reserves the desktop
    // scrollbar width (DEFAULT_SCROLL_BAR_WIDTH = 14px) when scrollback is
    // enabled. On touch devices the scrollbar is overlay (zero-width), so
    // both errors stack up: the rendered cell grid stops ~11px short of the
    // container's right edge and the black .xterm-viewport background shows
    // through as a vertical strip with no content (reported as "right side
    // of the tmux terminal cut off"). Recompute against the container's
    // actual content box on mobile; the desktop path stays untouched.
    const proposeOriginal = fit.proposeDimensions.bind(fit)
    fit.proposeDimensions = () => {
      if (!useAppStore.getState().isMobile) return proposeOriginal()
      const core = (term as unknown as {
        _core: {
          _renderService: { dimensions: { css: { cell: { width: number; height: number } } } }
        }
      })._core
      const cell = core._renderService.dimensions.css.cell
      // Cell metrics are only available after the first render pass.
      if (cell.width === 0 || cell.height === 0) return proposeOriginal()
      const cs = window.getComputedStyle(container)
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      const width = container.clientWidth - padX
      const height = container.clientHeight - padY
      // Reserve a small proportional margin so the rightmost column is never
      // clipped. Font metrics measure a hair narrower than glyphs actually
      // render, and on viewport widths where the cols×cellWidth leftover is
      // ~0 the last character would overflow the panel edge. 0.13 × cellWidth
      // (~1px at the default size) covers that overshoot while scaling with
      // the font size — independent of viewport width, DPR or font metrics.
      const safety = cell.width * 0.13
      return {
        cols: Math.max(2, Math.floor((width - safety) / cell.width)),
        rows: Math.max(1, Math.floor(height / cell.height)),
      }
    }
    fit.fit()

    termRef.current = term
    fitRef.current = fit
    containerRef.current = container

    if (onTitleChange) {
      term.onTitleChange(onTitleChange)
    }

    // IME composition handling for CJK input (mobile & desktop)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null
    if (textarea) {
      textarea.addEventListener('compositionstart', () => {
        composingRef.current = true
      })
      textarea.addEventListener('compositionend', () => {
        composingRef.current = false
      })
      // Initial inputmode reflects the scroll state at mount time.  The
      // [scrollMode] effect below keeps it in sync for later toggles.
      syncTextareaInputMode(container, scrollModeRef.current)
    }

    // pty 历史滚动（方案 C D1）：滚轮接管请求后端历史窗口帧，取代 xterm
    // 本地 scrollback（cell_frame 模式下结构性冻结，见 pty-scroll-handover.md）。
    // 互斥判定顺序：① tmux/external 会话不接管（冻结路径：xterm scrollback
    // + touchScroll→tmux copy-mode）；② 鼠标协议激活（vim/htop 等）不接管
    // ——xterm 6.0.0 中自定义 wheel handler 在鼠标协议路径同样最先执行，
    // 必须显式放行让鼠标上报发出；③ 其余 pty 场景接管（取消 xterm 默认
    // 滚动），alt-screen / 离线由控制器内部拒绝（D4）。
    if (VIEWPORT_TAKEOVER_ENABLED) {
      term.attachCustomWheelEventHandler((ev: WheelEvent) => {
        if (runtimeKindRef.current !== 'pty') return true
        if (term.modes.mouseTrackingMode !== 'none') return true
        const ctl = viewportCtlRef.current
        if (!ctl) return true
        return !ctl.handleWheel(ev, {
          lineHeightPx: cellHeightPx(term),
          rows: term.rows,
          wsOpen: wsRef.current?.readyState === WebSocket.OPEN,
        })
      })
    }

    // Handle resize — debounced so xterm.js and tmux resize together after
    // layout stabilizes. Without debounce, fit.fit() changes xterm dimensions
    // immediately while tmux still has the old size; if tmux redraws its
    // status bar in that window it renders at the old last-row (now beyond
    // the viewport), scrolling content into scrollback.
    const observer = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null
        fit.fit()
      }, 80)
    })
    observer.observe(container)
    observerRef.current = observer

    // Auto-copy selected text to clipboard on mouse select
    // xterm.js creates native selections when Shift is held (bypasses tmux mouse mode).
    // We listen for mouseup and read the selection after xterm.js finishes processing.
    const handleMouseUp = () => {
      // Defer to let xterm.js finish its internal mouseup handling
      requestAnimationFrame(() => {
        if (!useAppStore.getState().autoCopySelect) return
        const sel = term.getSelection()
        if (sel) {
          const copied = i18n.t('terminal.copySuccess')
          // D1：统一走 utils/clipboard.ts（async API + textarea 兜底），
          // 原内联实现收敛到公共 util；失败时同样提示，不静默。
          void copyText(sel).then((ok) => {
            if (ok) useToastStore.getState().addToast('success', copied)
            else useToastStore.getState().addToast('error', copied)
          })
        }
      })
    }

    container.addEventListener('mouseup', handleMouseUp)
    mouseUpHandlerRef.current = () => {
      container.removeEventListener('mouseup', handleMouseUp)
    }

    // Mobile touch scroll: vertical finger drags become wheel events so
    // tmux mouse-mode scrolls history (xterm has no native touch scroll).
    //
    // 物理监听必须唯一（touchmove 只能注册一次）：注册两份会让每个手势派发
    // 两个 wheel 事件，pty 侧表现为双倍滚动量。故 pty/tmux 共用同一个监听器，
    // 但在回调入口立即按 runtime 分派到两条互不干涉的处理路径 —— pty 侧的
    // 滚动逻辑全部在 ViewportController（wheel handler 内接管），这里不维护
    // 任何状态；tmux 侧只需维护 copy-mode 标志。
    touchScrollCleanupRef.current = attachTouchScroll(container, (deltaY) => {
      if (runtimeKindRef.current === 'pty') {
        // pty：合成 wheel 已被 ViewportController 接管，无 copy-mode 语义，
        // 不维护本地状态（滚动状态源在 ViewportController.onModeChange）。
        return
      }
      // tmux：合成 wheel 交回 xterm 默认路径（xterm 本地 scrollback）。
      // 只在这里维护 copy-mode 标志 —— 仅「查看历史」方向（wheel up，
      // deltaY < 0）会让 tmux 进 copy mode，翻转标志使 MobileKeyBar「滚动」
      // 高亮跟随真实 tmux 状态。滚回 live 方向（deltaY > 0）不动：tmux 的
      // `copy-mode -e` 只在滚到历史底部时自动退出，此处无法观测。
      if (deltaY < 0 && !tmuxScrollModeRef.current) {
        tmuxScrollModeRef.current = true
        setTmuxScrollMode(true)
      }
    })

    // Signal terminal is ready — triggers WS effects
    setTerminalReady(true)
  }, [onTitleChange])

  // Initialize terminal once (when container becomes available)
  const initTerminal = useCallback((container: HTMLDivElement) => {
    if (termRef.current) return
    // Already (re)creating — a second concurrent call (rapid click, StrictMode
    // double-invoke, re-render) must not start another createTerminal, or it
    // would open() on the same container twice and corrupt the instance.
    if (initializingRef.current) return
    initializingRef.current = true

    // Create a fresh AbortController for this init cycle. disposeTerminal
    // aborts the previous one (if any) before we get here.
    const ac = new AbortController()
    abortRef.current = ac
    createTerminal(container, ac.signal)
      .catch(() => {
        if (ac.signal.aborted) return
        // Keep the overlay up so the user can retry, and surface the failure
        // instead of silently swallowing it (looks like a dead button).
        useAppStore.getState().setTerminalDisconnected(true)
        useToastStore.getState().addToast('error', i18n.t('terminal.status.initFailed'))
      })
      .finally(() => {
        initializingRef.current = false
      })

    return () => {
      disposeTerminal()
    }
  }, [createTerminal, disposeTerminal])

  // Connect WS when terminal is ready and session changes
  useEffect(() => {
    const idChanged =
      (sessionId && sessionId !== sessionIdRef.current) ||
      (externalSessionName && externalSessionName !== externalSessionRef.current)
    if (!idChanged || !termRef.current) return
    // The Terminal view stays mounted across same-kind session switches
    // (Layout keys on view kind, not session id) — reset the per-session UI
    // state that the old full remount used to clear. tmux copy-mode state is
    // session-local; the new session starts outside copy mode.
    //
    // 只归位 tmux 侧：pty 侧的视口状态由下方 connectWs() 里的
    // ViewportController.reset() 归位（它会回调 onModeChange(false)）。
    // 在两侧状态分离后，此处不得写 ptyScrollMode —— 那是控制器的真值。
    tmuxScrollModeRef.current = false
    setTmuxScrollMode(false)
    connectWs()
  }, [sessionId, externalSessionName, connectWs])

  // Auto-connect after init (first session)
  useEffect(() => {
    const hasId = !!(sessionId || externalSessionName)
    if (termRef.current && hasId && !wsRef.current) {
      connectWs()
    }
  }, [terminalReady, sessionId, externalSessionName, connectWs])

  // Auto-focus on session selection: clicking a sidebar row leaves DOM focus on
  // that row, so the user has to click the terminal before typing. Runs on the
  // first init too (`terminalReady` false→true) and repeats after a remount —
  // `disposeTerminal` resets the flag, so StrictMode's double-mount still ends
  // with the live instance focused. Same-kind switches (tmux→tmux) keep the
  // view mounted, hence the `sessionId` dep rather than a mount-only effect.
  useEffect(() => {
    if (!autoFocus || !terminalReady) return
    // No session (empty state) or torn down (blur/idle disconnect) → nothing to focus.
    if (!(externalSessionName ?? sessionId)) return
    termRef.current?.focus()
  }, [autoFocus, terminalReady, sessionId, externalSessionName])

  // Live-update font size when store changes
  useEffect(() => {
    const term = termRef.current
    if (term && term.options.fontSize !== fontSize) {
      term.options.fontSize = fontSize
      fitRef.current?.fit()
      // Notify backend of new terminal dimensions.
      // The ResizeObserver only fires when the container's pixel
      // size changes, not when the character grid changes from a
      // font-size adjustment alone — so we explicitly send the
      // new cols/rows so tmux can redraw correctly.
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })
        )
      }
    }
  }, [fontSize])

  // Keep the xterm textarea's `inputmode` in sync with scroll mode so the
  // soft keyboard doesn't pop up when the user pages through history with
  // ↑/↓ taps in tmux copy mode.  See utils/terminalInputMode.ts for the
  // full rationale.  `terminalReady` is a dep so the effect re-runs once
  // xterm has finished creating the textarea asynchronously.
  useEffect(() => {
    syncTextareaInputMode(containerRef.current, scrollMode)
  }, [scrollMode, terminalReady])

  // Track tab visibility and window focus to disconnect after a grace period
  // when the user leaves the tab.  We listen to both `visibilitychange` and
  // `focus`/`blur` so we catch:
  //   - switching browser tabs (`visibilitychange`)
  //   - switching to another app/window (`window.blur`)
  //   - returning to the tab (`visibilitychange` / `window.focus`)
  // NOTE: `blurDisconnectMin` / `idleDisconnectMin` are intentionally NOT in
  // the deps array — each timer reads the value when it is armed and keeps it
  // for that firing. Adding them would re-run this effect (and reset armed
  // timers) on a settings change, changing the disconnect/reset semantics.
  useEffect(() => {
    const clearBlurTimer = () => {
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current)
        blurTimerRef.current = null
      }
    }

    const resetIdleTimer = () => {
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current)
      }
      idleTimerRef.current = setTimeout(() => {
        // Only disconnect if the tab is currently focused and we have an
        // active session.  If the tab is hidden, the blur timer handles it.
        if (isFocusedRef.current && document.hasFocus() && (sessionId || externalSessionName)) {
          useAppStore.getState().setTerminalDisconnected(true)
          disposeTerminal()
        }
      }, idleDisconnectMin * 60_000)
    }

    const handleVisibility = () => {
      if (document.hidden) {
        // Tab became hidden — start the blur timer.
        clearBlurTimer()
        blurTimerRef.current = setTimeout(() => {
          if (sessionId || externalSessionName) {
            useAppStore.getState().setTerminalDisconnected(true)
            disposeTerminal()
          }
        }, blurDisconnectMin * 60_000)
        // Stop the idle timer while hidden; it will be restarted on focus.
        if (idleTimerRef.current) {
          clearTimeout(idleTimerRef.current)
          idleTimerRef.current = null
        }
      } else {
        // Tab became visible again — cancel the blur timer and restart idle.
        clearBlurTimer()
        isFocusedRef.current = true
        resetIdleTimer()
      }
    }

    const handleFocus = () => {
      if (document.hasFocus()) {
        clearBlurTimer()
        isFocusedRef.current = true
        resetIdleTimer()
      }
    }

    const handleBlur = () => {
      if (!document.hidden) {
        // Window lost focus but tab is still visible — start blur timer.
        clearBlurTimer()
        blurTimerRef.current = setTimeout(() => {
          if (sessionId || externalSessionName) {
            useAppStore.getState().setTerminalDisconnected(true)
            disposeTerminal()
          }
        }, blurDisconnectMin * 60_000)
        if (idleTimerRef.current) {
          clearTimeout(idleTimerRef.current)
          idleTimerRef.current = null
        }
      }
    }

    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)

    // Initialize state based on current visibility/focus.
    if (document.hidden || !document.hasFocus()) {
      isFocusedRef.current = false
    } else {
      resetIdleTimer()
    }

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      clearBlurTimer()
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current)
        idleTimerRef.current = null
      }
    }
  }, [sessionId, externalSessionName, disposeTerminal])

  // Track user activity to reset the idle disconnect timer.  Any meaningful
  // interaction (mouse move, key press, scroll, touch, click) resets the
  // idle countdown (idleDisconnectMin), so long-running sessions aren't
  // killed while the tab is focused.
  // NOTE: `idleDisconnectMin` is intentionally NOT in the deps array — the
  // re-armed timer reads the value at arm time (see the visibility/focus
  // effect above for the rationale).
  useEffect(() => {
    const ACTIVITY_EVENTS: (keyof DocumentEventMap)[] = [
      'mousemove', 'keydown', 'scroll', 'touchstart', 'click',
    ]

    const onActivity = () => {
      lastActivityRef.current = Date.now()
      // If the tab is focused and we have an idle timer, reset it so the
      // idle countdown starts from now.
      if (isFocusedRef.current && document.hasFocus() && idleTimerRef.current) {
        clearTimeout(idleTimerRef.current)
        idleTimerRef.current = setTimeout(() => {
          if (sessionId || externalSessionName) {
            useAppStore.getState().setTerminalDisconnected(true)
            disposeTerminal()
          }
        }, idleDisconnectMin * 60_000)
      }
    }

    ACTIVITY_EVENTS.forEach((event) => {
      document.addEventListener(event, onActivity, { passive: true })
    })

    return () => {
      ACTIVITY_EVENTS.forEach((event) => {
        document.removeEventListener(event, onActivity)
      })
    }
  }, [sessionId, externalSessionName, disposeTerminal])

  const reconnect = useCallback((container?: HTMLDivElement | null) => {
    const id = externalSessionName ?? sessionId
    if (!id) return

    if (termRef.current) {
      connectWs()
      return
    }
    // containerRef is only set once createTerminal succeeds — fall back to
    // the caller-provided live container so reconnect still works when the
    // very first init failed (e.g. addon chunk 404).
    const target = container ?? containerRef.current
    if (target) {
      initTerminal(target)
    }
  }, [sessionId, externalSessionName, connectWs, initTerminal])

  /** Refocus the xterm textarea so the soft keyboard stays open.
   *  Used after a modifier latch in MobileKeyBar — the user tapped Ctrl/Shift/Alt
   *  and then needs the keyboard to remain active for the next character (e.g.
   *  Ctrl+C via IME). The setTimeout defers past the button's default focus
   *  acquisition so the programmatic focus takes effect. */
  const refocusTextarea = useCallback(() => {
    setTimeout(() => {
      containerRef.current?.querySelector('textarea')?.focus()
    }, 0)
  }, [])

  return {
    connectWs,
    initTerminal,
    sendData,
    scrollMode,
    hasNewOutput: runtimeKind === 'pty' ? ptyNewOutput : false,
    sendScrollKeys,
    exitScrollMode,
    reconnect,
    refocusTextarea,
  }
}
