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
// [TERMDBG] 临时诊断埋点（打字延迟排查用，排查完删除）
import { termDebug } from '../utils/termDebug'

/** [TERMDBG] 是否开启临时埋点（仅 DEV）。 */
const TERMDBG = import.meta.env.DEV

// Eagerly preload xterm addons at module level. The dynamic imports start
// fetching immediately when this module is evaluated, so by the time
// createTerminal runs the addons are already resolved — no async gap.
// This keeps the code-splitting benefit (addons in separate chunks)
// while keeping createTerminal synchronous (no yield window for CSS
// transitions / font swaps to change the container size mid-init).
const importAddons = () =>
  Promise.all([
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
    import('@xterm/addon-unicode11'),
  ])
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

async function loadAddons(): Promise<
  [typeof FitAddon, typeof import('@xterm/addon-web-links').WebLinksAddon, typeof import('@xterm/addon-unicode11').Unicode11Addon]
> {
  let mods: [
    typeof import('@xterm/addon-fit'),
    typeof import('@xterm/addon-web-links'),
    typeof import('@xterm/addon-unicode11'),
  ]
  try {
    mods = await addonsPromise
  } catch {
    // The cached import rejected (e.g. stale chunk 404 after a redeploy).
    // Re-import so a reconnect click can recover without a page refresh.
    addonsPromise = importAddons()
    mods = await addonsPromise
  }
  const [{ FitAddon }, { WebLinksAddon }, { Unicode11Addon }] = mods
  return [FitAddon, WebLinksAddon, Unicode11Addon]
}

/** reconnect 的可选行为开关（引擎自动重试路径与用户手动点击共用入口）。 */
interface ReconnectOptions {
  /** false = 引擎自动重试：失败不弹 toast（退避循环会反复失败，弹了是噪声）。
   *  缺省 true = 用户手动触发或首次挂载，失败要给出可见反馈。 */
  announceFailure?: boolean
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
      sendRequest: (y, refresh) => {
        const ws = wsRef.current
        if (ws?.readyState === WebSocket.OPEN) {
          // refresh = true 是输出触发的保锚重拉：后端按存储锚出窗、忽略 y
          // （有状态锚 2026-09-12 D1/D2）
          ws.send(JSON.stringify({ type: 'viewport_request', y, refresh }))
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
  // ── 自动重连引擎状态（「聚焦页面才重连」）──
  // 退避定时器与计数：计数在 ws.onopen 成功或用户回来（kick）时归零，每次
  // 调度 +1，封顶 30s；页面隐藏期间不调度也不消耗（回可见重新起一轮）。
  const autoRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoRetryCountRef = useRef(0)
  // 引擎函数定义在 reconnect 之前（connectWs 的 onclose 要调用），经 ref 晚
  // 绑定 reconnect 的最新身份——定时器/事件触发时才读，render 期赋值与
  // consumeLatchRef 同款模式。
  const reconnectRef = useRef<((container?: HTMLDivElement | null, opts?: ReconnectOptions) => void) | null>(null)
  // 引擎触发的整端重建（teardown 回归，termRef 为空）跳过一次自动聚焦：
  // 用户常在聊天面板等其他区域操作时被 kick 回来，焦点被终端抢走会打断输入。
  const skipAutoFocusRef = useRef(false)
  // true = 引擎正在管理重试（遮罩显示「正在自动重连」而非纯手动按钮）
  const [autoReconnecting, setAutoReconnecting] = useState(false)
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

  // ── 自动重连引擎 ──
  // 「聚焦页面才重连」：页面隐藏时不发任何重连尝试（含已到期的退避定时器，
  // 到期时发现隐藏直接跳过），页面回来（visibilitychange→visible / window
  // focus / 任意用户活动事件）立即尝试一次并重置退避。既有 blur/idle 主动
  // 拆除逻辑不变——省资源窗口照常生效，拆除后由本引擎在用户回来时自愈，
  // 遮罩按钮保留为手动兜底。意外断开（ws onclose / init 失败）在页面可见时
  // 按指数退避自动重试（1→2→4→…→cap 30s，同 useAcpChat 节奏）。
  //
  // 引擎函数全部经 ref / store 取值、无响应式依赖，保持稳定身份——它们被
  // 高频事件（mousemove 等）和长寿命 WS 闭包引用，身份抖动会让 effect 反复
  // 重挂、旧连接闭包持有过期调度器。

  /** 立即发起一次引擎重连（退避定时器到期 / 用户回来共用）。teardown 态
   *  （termRef 为空）走整端重建并跳过一次自动聚焦。 */
  const autoReconnectNow = useCallback(() => {
    if (!termRef.current) skipAutoFocusRef.current = true
    reconnectRef.current?.(undefined, { announceFailure: false })
  }, [])

  const cancelAutoRetry = useCallback(() => {
    if (autoRetryTimerRef.current) {
      clearTimeout(autoRetryTimerRef.current)
      autoRetryTimerRef.current = null
    }
  }, [])

  /** 退避重试调度（ws onclose / createTerminal 失败路径）。已有重试排队或
   *  页面隐藏时不调度（隐藏期间的断连由用户回来时的 kick 接管）。 */
  const scheduleAutoRetry = useCallback(() => {
    if (autoRetryTimerRef.current) return
    if (document.hidden) return
    const store = useAppStore.getState()
    if (!(store.activeExternalSession ?? store.activeSessionId)) return
    const delay = Math.min(1000 * 2 ** autoRetryCountRef.current, 30_000)
    autoRetryCountRef.current += 1
    setAutoReconnecting(true)
    autoRetryTimerRef.current = setTimeout(() => {
      autoRetryTimerRef.current = null
      if (document.hidden) return
      autoReconnectNow()
    }, delay)
  }, [autoReconnectNow])

  /** 用户回来（页面变可见 / 窗口聚焦 / 任意活动事件）时的重连尝试。挂在
   *  mousemove 等高频事件上：连接健康或已有尝试在途时必须廉价 no-op，
   *  绝不能扰动健康连接（reconnect 会拆掉现存连接重建）。 */
  const attemptAutoReconnect = useCallback(() => {
    const store = useAppStore.getState()
    if (!store.terminalDisconnected) return
    if (!(store.activeExternalSession ?? store.activeSessionId)) return
    if (document.hidden) return
    if (autoRetryTimerRef.current) return
    if (initializingRef.current) return
    const ws = wsRef.current
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return
    // 用户回来 = 新一轮退避（隐藏/离开期间积累的计数不作数）
    autoRetryCountRef.current = 0
    setAutoReconnecting(true)
    autoReconnectNow()
  }, [autoReconnectNow])

  const connectWs = useCallback(() => {
    const term = termRef.current
    const id = externalSessionName ?? sessionId
    if (!id || !term) return

    // 新连接使一切排队的自动重试作废（会话切换 / 手动重连 / 引擎自身发起）。
    cancelAutoRetry()

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
      // 连上了：退避循环结束，计数归零（下次断开从 1s 重新爬）。
      autoRetryCountRef.current = 0
      setAutoReconnecting(false)
      termRef.current?.writeln(`\x1b[32m[${i18n.t('terminal.status.connected')}]\x1b[0m`)
      // Phase 1: 声明 cell_frame 支持（§4.2 hello 握手）。开启后收到的
      // cell_frame 一律是 runs 行编码（`docs/dev/plans/archive/2026-08-28-pty-frame-rle.md`）。
      ws.send(JSON.stringify({ t: 'hello', supports_cell_frame: true }))
      // 连接建立即补发当前尺寸：连接初期容器布局未稳时，onResize 的 resize
      // 消息可能落在 WS open 之前被 readyState 门禁静默丢弃（pty 下 xterm 与
      // 后端 grid 行数就此永久分叉——cell_frame 只覆盖顶部 height 行，xterm
      // 底部多余的行停留旧内容，症状为 TUI 画在输入行上方、底部垫陈旧画面）。
      // 后端对同尺寸 resize 幂等，重连/会话切换路径同样由此对齐。
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
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
            // [TERMDBG] 临时埋点：帧到达 + 按键→含变化帧的回显延迟（排查完删除）
            if (TERMDBG)
              termDebug.noteFrame(
                e.data.length,
                !!msg.full || !!msg.overlay || (msg.row_indices?.length ?? 0) > 0,
              )
            if (!sawFirstBinary) {
              sawFirstBinary = true
              termRef.current?.reset()
            }
            // 帧尺寸自愈：帧携带的 grid 高宽与本端 xterm 不一致（resize 消息
            // 丢失或竞态）时补发当前尺寸，后端 resize 会作废 diff 基线改发
            // 全帧，双端就此收敛。不补发则帧只覆盖顶部 height 行，xterm 底部
            // 多余的行永久停留旧内容。同尺寸时后端幂等，误发无副作用。
            const live = termRef.current
            if (
              live &&
              msg.height != null &&
              msg.width != null &&
              (msg.height !== live.rows || msg.width !== live.cols)
            ) {
              ws.send(JSON.stringify({ type: 'resize', cols: live.cols, rows: live.rows }))
            }
            // bracketed paste 模式中继（2026-09-06 D3）：与 xterm 实际值不一致
            // 才写模式序列（幂等 no-op，不产生写放大）。必须在 acceptFrame 门控
            // 之前消费——被 viewport 丢弃的实时帧同样携带最新模式真值；会话
            // 切换 term.reset() 清掉 xterm 模式后首帧即在此自愈。
            // 注：xterm 6.0 无顶层 bracketedPasteMode，读取走
            // term.modes.bracketedPasteMode（IModes，DECSET 解析态）。
            if (
              live &&
              msg.bracketed_paste != null &&
              live.modes.bracketedPasteMode !== msg.bracketed_paste
            ) {
              live.write(msg.bracketed_paste ? '\x1b[?2004h' : '\x1b[?2004l')
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
            // C1（2026-09-08 pty-incremental-sync-hardening）：mid-stream 直写
            // 状态行可能触发换行滚动，而 diff 帧不会重画未变化行 → 永久错位。
            // 一次全帧重同步抵消滚动副作用（requestResync 自带 readyState 守卫）。
            requestResync()
          } else if (msg.type === 'exit') {
            termRef.current?.writeln(`\x1b[31m[${i18n.t('terminal.status.exited', { code: msg.code })}]\x1b[0m`)
            requestResync()
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
      // 非主动拆除（onclose 引用还在才会走到）→ 页面可见时按退避自动重试。
      scheduleAutoRetry()
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
        if (TERMDBG) termDebug.noteKey()
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
  }, [sessionId, externalSessionName, cancelAutoRetry, scheduleAutoRetry])

  /** Send raw data to the terminal's WebSocket if connected */
  const sendData = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(data))
    }
  }, [])

  /** Paste text through xterm（2026-09-06 D4）：xterm 内部自带
   *  `\r?\n→\r` 换行转换，并按自身 `bracketedPasteMode` 包装 `200~/201~`
   *  （模式真值由 cell_frame 的 bracketed_paste 字段同步，见上方 onmessage）。
   *  移动端长按粘贴必须走它而非裸 sendData——裸发既丢换行转换也丢包装，
   *  多行文本会被 TUI 逐行当 Enter 提交（tmux 会话的 shell 同样受益）。 */
  const pasteText = useCallback((text: string) => {
    termRef.current?.paste(text)
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
    // 主动拆除（blur/idle 断连、卸载、会话切换）不是自动重连的场景：清掉
    // 排队中的重试与「正在重连」指示，用户回来后由 kick 重新评估。
    cancelAutoRetry()
    setAutoReconnecting(false)
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
  }, [cancelAutoRetry])

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
    const [FitAddon, WebLinksAddon, Unicode11Addon] = await loadAddons()

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
      // Unicode11Addon 注册宽表走的是 proposed API（unicode.register），
      // 必须开启否则 loadAddon 直接抛错、终端初始化失败。
      allowProposedApi: true,
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
    // Unicode 11 宽表（2026-09-09）：xterm 默认宽表停留在 Unicode 6，
    // ⬛⬜🟥🟩 等方块 emoji 按 1 列渲染，而后端 alacritty 的 unicode-width
    // 按 2 列布局 grid —— cell_frame 编码跳过宽字符占位 cell 后，前端每
    // 个方块少占 1 列，「像素方格」logo 从第一个方块起整体压扁错位。激活
    // '11' 宽表使前端列宽与后端对齐。须在首帧写入前生效，此处即 open 前。
    const unicode11 = new Unicode11Addon()
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'
    term.open(container)
    // [TERMDBG] 临时埋点：挂在 xterm 写入队列上（排查完删除）
    if (TERMDBG) termDebug.attachTerm(term)

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
  const initTerminal = useCallback((container: HTMLDivElement, opts?: ReconnectOptions) => {
    if (termRef.current) return
    // Already (re)creating — a second concurrent call (rapid click, StrictMode
    // double-invoke, re-render) must not start another createTerminal, or it
    // would open() on the same container twice and corrupt the instance.
    if (initializingRef.current) return
    initializingRef.current = true
    // 记下容器：引擎自动重连路径不带 container 参数，首次 init 失败后
    // containerRef 里必须有活容器可用（此前只在 createTerminal 成功时落值）。
    containerRef.current = container

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
        skipAutoFocusRef.current = false
        if (opts?.announceFailure !== false) {
          useToastStore.getState().addToast('error', i18n.t('terminal.status.initFailed'))
        }
        // 页面可见时按退避自动重试（引擎路径）；手动重连失败同样受益。
        scheduleAutoRetry()
      })
      .finally(() => {
        initializingRef.current = false
      })

    return () => {
      disposeTerminal()
    }
  }, [createTerminal, disposeTerminal, scheduleAutoRetry])

  /** 手动重连（遮罩按钮）与引擎自动重连共用入口。termRef 还活着（意外断开，
   *  xterm 未拆）走廉价 WS 重连；teardown 态（blur/idle 拆除）走整端重建。
   *  引擎路径经 opts 关闭失败 toast，并依赖 containerRef 回退取容器。 */
  const reconnect = useCallback((container?: HTMLDivElement | null, opts?: ReconnectOptions) => {
    const id = externalSessionName ?? sessionId
    if (!id) return

    if (termRef.current) {
      connectWs()
      return
    }
    // containerRef is set at initTerminal entry (before createTerminal), so it
    // still points at the live panel div even when the first init failed.
    const target = container ?? containerRef.current
    if (target) {
      initTerminal(target, opts)
    }
  }, [sessionId, externalSessionName, connectWs, initTerminal])
  // 引擎晚绑定（见 reconnectRef 声明处注释）
  reconnectRef.current = reconnect

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
    // 引擎触发的整端重建消费掉跳过标记：用户在其他区域（如聊天面板）操作时
    // 被自动重连拉起，焦点不得被终端抢走。手动按钮路径不置位，照常聚焦。
    if (skipAutoFocusRef.current) {
      skipAutoFocusRef.current = false
      return
    }
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
        // 页面回来：teardown 态 / 隐藏期间掉线的终端在此自愈。
        attemptAutoReconnect()
      }
    }

    const handleFocus = () => {
      if (document.hasFocus()) {
        clearBlurTimer()
        isFocusedRef.current = true
        resetIdleTimer()
        // 双屏场景：标签一直可见但焦点在别的窗口，blur 计时到点拆了终端；
        // 焦点切回来即视为「用户回来了」。
        attemptAutoReconnect()
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
      // 卸载 / 会话切换：取消排队中的自动重试并熄掉「正在重连」指示
      //（新会话由自己的连接生命周期接管）。
      cancelAutoRetry()
      setAutoReconnecting(false)
    }
  }, [sessionId, externalSessionName, disposeTerminal, attemptAutoReconnect, cancelAutoRetry])

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
      // 空闲拆除（页面全程可见、无 visibility/focus 变化）后的自愈入口：
      // 用户回来了（任何输入活动）即重连。连接健康时是廉价 no-op。
      attemptAutoReconnect()
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
  }, [sessionId, externalSessionName, disposeTerminal, attemptAutoReconnect])

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
    pasteText,
    scrollMode,
    hasNewOutput: runtimeKind === 'pty' ? ptyNewOutput : false,
    sendScrollKeys,
    exitScrollMode,
    reconnect,
    refocusTextarea,
    /** 引擎正在管理自动重试（遮罩显示「正在自动重连」而非纯手动按钮） */
    autoReconnecting,
  }
}
