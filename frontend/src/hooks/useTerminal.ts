import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import { useAttention } from './useAttention'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../stores/appStore'
import { useToastStore } from '../stores/toastStore'
import { READER_FONT } from '../utils/fonts'

interface UseTerminalOptions {
  sessionId: string | null
  externalSessionName?: string | null
  fontSize?: number
  onTitleChange?: (title: string) => void
  /** Ref tracking the currently-latched modifier key (Ctrl/Shift/Alt) from MobileKeyBar */
  latchModRef?: React.MutableRefObject<string | null>
  /** Called when a latched modifier has been consumed by keyboard input */
  onConsumeLatch?: () => void
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

export function useTerminal({ sessionId, externalSessionName, fontSize = 14, onTitleChange, latchModRef, onConsumeLatch }: UseTerminalOptions) {
  const { i18n } = useTranslation()
  const attention = useAttention()  // Agent attention context
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const composingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const externalSessionRef = useRef<string | null>(null)
  const listenerDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const observerRef = useRef<ResizeObserver | null>(null)
  const mouseUpHandlerRef = useRef<(() => void) | null>(null)
  const keyHandlerAttachedRef = useRef(false)
  // Track whether tmux is in copy/scroll mode (for touch-scroll fallback)
  const tmuxScrollModeRef = useRef(false)
  // `isCreatingRef` guards against concurrent createTerminal calls
  // (React StrictMode runs effects twice; createTerminal is async so the
  // termRef.current check at the top of initTerminal isn't enough).
  const isCreatingRef = useRef(false)
  // `isCancelledRef` lets an in-flight createTerminal bail out if dispose
  // is called before it finishes (e.g., session switch while addons load).
  const isCancelledRef = useRef(false)
  // Track terminal readiness so WS effects re-run after initTerminal creates the terminal.
  const [terminalReady, setTerminalReady] = useState(false)
  // Mobile scroll mode: when true, arrow keys scroll tmux history instead of sending cursor keys
  const [scrollMode, setScrollMode] = useState(false)
  // Stable ref for the consume-latch callback so connectWs closure is current
  const consumeLatchRef = useRef(onConsumeLatch)
  consumeLatchRef.current = onConsumeLatch

  const connectWs = useCallback(() => {
    const term = termRef.current
    const id = externalSessionName ?? sessionId
    if (!id || !term) return

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
      wsRef.current = null
    }

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
      termRef.current?.writeln(`\x1b[32m[${i18n.t('terminal.status.connected')}]\x1b[0m`)
    }

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        termRef.current?.write(new Uint8Array(e.data))
      } else {
        try {
          const msg = JSON.parse(e.data)
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
      useAppStore.getState().setConnected(false)
      tmuxScrollModeRef.current = false
      // Only write if this WS is still the active one
      if (wsRef.current === ws) {
        termRef.current?.writeln(`\x1b[31m[${i18n.t('terminal.status.disconnected')}]\x1b[0m`)
      }
    }

    ws.onerror = () => {
      useAppStore.getState().setConnected(false)
      if (wsRef.current === ws) {
        termRef.current?.writeln(`\x1b[31m[${i18n.t('terminal.status.connectionError')}]\x1b[0m`)
      }
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
        if (composingRef.current) return
        if (ws.readyState !== WebSocket.OPEN) return
        const latch = latchModRef?.current
        if (latch) {
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
        // Only intercept in modern mode
        const mode = useAppStore.getState().keybindingMode
        if (mode !== 'modern') return true

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
          ws.send(new TextEncoder().encode('\x02%'))
          return false
        }
        // Ctrl+Shift+Down → vertical split
        if (ctrl && shift && !alt && key === 'ArrowDown') {
          ws.send(new TextEncoder().encode('\x02"'))
          return false
        }
        // Ctrl+Shift+Q → new window
        if (ctrl && shift && !alt && key === 'Q') {
          ws.send(new TextEncoder().encode('\x02c'))
          return false
        }
        // Ctrl+Shift+X → close pane (send kill-pane + auto-confirm 'y')
        if (ctrl && shift && !alt && key === 'X') {
          ws.send(new TextEncoder().encode('\x02x'))
          // Auto-confirm the tmux kill-pane prompt
          setTimeout(() => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(new TextEncoder().encode('y\n'))
            }
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

  /** Enter tmux copy mode (if not already) and scroll one page in the given direction.
   *  Uses the real tmux copy-mode state (tmuxScrollModeRef) as the source of
   *  truth, not the React `scrollMode` flag, so pagging always works after the
   *  user has toggled scroll on via the UI button. */
  const sendScrollKeys = useCallback((direction: 'up' | 'down') => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!tmuxScrollModeRef.current) {
      // tmux prefix is Ctrl+B (0x02), then [ enters copy mode
      ws.send(new TextEncoder().encode('\x02['))
      tmuxScrollModeRef.current = true
      setScrollMode(true)
    }
    const key = direction === 'up' ? '\x1b[5~' : '\x1b[6~' // PageUp / PageDown
    ws.send(new TextEncoder().encode(key))
  }, [])

  /** Exit tmux copy mode by sending 'q' — only if actually in copy mode */
  const exitScrollMode = useCallback(() => {
    if (!tmuxScrollModeRef.current) {
      setScrollMode(false)
      return
    }
    sendData('q')
    tmuxScrollModeRef.current = false
    setScrollMode(false)
  }, [sendData])

  /** Dispose the current terminal and all associated resources */
  const disposeTerminal = useCallback(() => {
    // Signal any in-flight createTerminal to bail out (e.g., when a
    // session switch kicks off dispose before addons have loaded).
    isCancelledRef.current = true
    isCreatingRef.current = false
    observerRef.current?.disconnect()
    observerRef.current = null
    if (mouseUpHandlerRef.current) {
      mouseUpHandlerRef.current()
      mouseUpHandlerRef.current = null
    }
    keyHandlerAttachedRef.current = false
    listenerDisposablesRef.current.forEach((d) => d?.dispose())
    listenerDisposablesRef.current = []
    tmuxScrollModeRef.current = false
    if (wsRef.current) {
      wsRef.current.onclose = null
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
  }, [])

  // Ref to supply the current font size to createTerminal without making
  // it a reactive dependency (avoids destroying the terminal on every
  // font-size change — the live-update effect handles that in-place).
  const fontSizeRef = useRef(fontSize)
  fontSizeRef.current = fontSize

  /** Create a terminal on the given container and return a cleanup function */
  const createTerminal = useCallback(async (container: HTMLDivElement) => {
    // Reset the cancellation flag in case a previous dispose set it.
    // (We don't touch isCreatingRef here — initTerminal owns that gate.)
    isCancelledRef.current = false

    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSizeRef.current,
      fontFamily: READER_FONT,
      theme: DARK_TERMINAL_THEME,
    })
    // Load addons dynamically to keep them out of the main chunk
    const [{ FitAddon }, { WebLinksAddon }] = await Promise.all([
      import('@xterm/addon-fit'),
      import('@xterm/addon-web-links'),
    ])

    // If dispose was called during the await (e.g., session switch before
    // addons finished loading), abandon this term. Without this guard we
    // would leak a Term whose DOM is never attached to the container.
    if (isCancelledRef.current) {
      term.dispose()
      return
    }

    const fit = new FitAddon()
    const webLinks = new WebLinksAddon()

    term.loadAddon(fit)
    term.loadAddon(webLinks)

    // Install the ResizeObserver BEFORE term.open so it captures every
    // size change from this point on. Setting it up after term.open +
    // fit.fit() (the previous order) missed any resize that happened in
    // the await window above, leaving xterm fitted to a stale size —
    // manifested as "input line at the bottom, big black area above,
    // cursor at the top, can't type" on slow devices / network-throttled
    // production builds. The first observation is redundant with the
    // rAF-triggered fit below, so we skip it.
    let isFirstFire = true
    const observer = new ResizeObserver(() => {
      if (isFirstFire) {
        isFirstFire = false
        return
      }
      fit.fit()
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })
        )
      }
    })
    observer.observe(container)
    observerRef.current = observer

    term.open(container)
    termRef.current = term
    fitRef.current = fit
    containerRef.current = container

    // Defer the initial fit to the next animation frame. The async addon
    // import above yields, during which the browser may have started a
    // layout (CSS transition opening the sidebar, font swap completing,
    // late style recalc). Calling fit here would read a transitional
    // container size. rAF runs after the next style/layout flush, so
    // the container's final, stable size is what we measure.
    requestAnimationFrame(() => {
      if (isCancelledRef.current) return
      fit.fit()
    })

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
    }

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
          if (navigator.clipboard) {
            navigator.clipboard.writeText(sel).then(
              () => useToastStore.getState().addToast('success', copied),
              () => {},
            )
          } else {
            // Fallback for insecure contexts (non-HTTPS)
            const ta = document.createElement('textarea')
            ta.value = sel
            ta.style.position = 'fixed'
            ta.style.opacity = '0'
            document.body.appendChild(ta)
            ta.select()
            document.execCommand('copy')
            document.body.removeChild(ta)
            useToastStore.getState().addToast('success', copied)
          }
        }
      })
    }

    container.addEventListener('mouseup', handleMouseUp)
    mouseUpHandlerRef.current = () => {
      container.removeEventListener('mouseup', handleMouseUp)
    }

    // Signal terminal is ready — triggers WS effects
    setTerminalReady(true)
  }, [onTitleChange])

  // Initialize terminal once (when container becomes available)
  const initTerminal = useCallback((container: HTMLDivElement) => {
    // termRef.current alone isn't sufficient: createTerminal is async
    // (dynamic addon import), so the ref stays null for several ticks
    // after this call. Without isCreatingRef, a second effect run
    // (React StrictMode, or a rapid session toggle) would slip past the
    // guard and start a parallel createTerminal that races the first.
    if (termRef.current || isCreatingRef.current) return
    isCreatingRef.current = true
    createTerminal(container).finally(() => {
      isCreatingRef.current = false
    })

    return () => {
      disposeTerminal()
    }
  }, [createTerminal, disposeTerminal])

  // Connect WS when terminal is ready and session changes

  useEffect(() => {
    if (termRef.current && sessionId && sessionId !== sessionIdRef.current) {
      connectWs()
      return
    }
    if (termRef.current && externalSessionName && externalSessionName !== externalSessionRef.current) {
      connectWs()
    }
  }, [sessionId, externalSessionName, connectWs])

  // Auto-connect after init (first session)
  useEffect(() => {
    const hasId = !!(sessionId || externalSessionName)
    if (termRef.current && hasId && !wsRef.current) {
      connectWs()
    }
  }, [terminalReady, sessionId, externalSessionName, connectWs])

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

  return {
    initTerminal,
    sendData,
    scrollMode,
    sendScrollKeys,
    exitScrollMode,
  }
}
