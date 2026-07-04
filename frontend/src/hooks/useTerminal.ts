import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
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
        } catch {}
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

  /** Enter tmux copy mode and scroll one page in the given direction */
  const sendScrollKeys = useCallback((direction: 'up' | 'down') => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (!scrollMode) {
      // tmux prefix is Ctrl+B (0x02), then [ enters copy mode
      ws.send(new TextEncoder().encode('\x02['))
      setScrollMode(true)
    }
    const key = direction === 'up' ? '\x1b[5~' : '\x1b[6~' // PageUp / PageDown
    ws.send(new TextEncoder().encode(key))
  }, [scrollMode])

  /** Exit tmux copy mode by sending 'q' — only if actually in copy mode */
  const exitScrollMode = useCallback(() => {
    if (!scrollMode) return
    if (tmuxScrollModeRef.current) {
      sendData('q')
      tmuxScrollModeRef.current = false
    }
    setScrollMode(false)
  }, [scrollMode, sendData])

  /** Dispose the current terminal and all associated resources */
  const disposeTerminal = useCallback(() => {
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
  const createTerminal = useCallback((container: HTMLDivElement) => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSizeRef.current,
      fontFamily: READER_FONT,
      theme: DARK_TERMINAL_THEME,
    })

    const fit = new FitAddon()
    const webLinks = new WebLinksAddon()

    term.loadAddon(fit)
    term.loadAddon(webLinks)
    term.open(container)
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
    }

    // Handle resize
    const observer = new ResizeObserver(() => {
      fit.fit()
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })
        )
      }
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
    if (termRef.current) return

    createTerminal(container)

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
    terminal: termRef.current,
    sendData,
    scrollMode,
    setScrollMode,
    sendScrollKeys,
    exitScrollMode,
  }
}
