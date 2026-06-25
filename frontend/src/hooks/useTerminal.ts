import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '../stores/appStore'
import { useThemeStore } from '../stores/themeStore'

interface UseTerminalOptions {
  sessionId: string | null
  fontSize?: number
  onTitleChange?: (title: string) => void
}

const DARK_TERMINAL_THEME = {
  background: '#1a1b26',
  foreground: '#c0caf5',
  cursor: '#c0caf5',
  selectionBackground: '#33467c',
}

const LIGHT_TERMINAL_THEME = {
  background: '#f8fafc',
  foreground: '#0f172a',
  cursor: '#7c3aed',
  cursorAccent: '#f8fafc',
  selectionBackground: 'rgba(124,58,237,0.2)',
  black: '#0f172a',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#7c3aed',
  cyan: '#0891b2',
  white: '#334155',
  brightBlack: '#64748b',
  brightRed: '#ef4444',
  brightGreen: '#22c55e',
  brightYellow: '#eab308',
  brightBlue: '#3b82f6',
  brightMagenta: '#8b5cf6',
  brightCyan: '#06b6d4',
  brightWhite: '#0f172a',
}

export function useTerminal({ sessionId, fontSize = 14, onTitleChange }: UseTerminalOptions) {
  const { i18n } = useTranslation()
  const resolved = useThemeStore((s) => s.resolved)
  const keybindingMode = useAppStore((s) => s.keybindingMode)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const composingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const listenerDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const observerRef = useRef<ResizeObserver | null>(null)
  const mouseUpHandlerRef = useRef<(() => void) | null>(null)
  // Track terminal readiness so WS effects re-run after initTerminal creates the terminal.
  const [terminalReady, setTerminalReady] = useState(false)

  const connectWs = useCallback(() => {
    const term = termRef.current
    if (!sessionId || !term) return

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null // prevent stale handler from writing to new terminal
      wsRef.current.close()
      wsRef.current = null
    }

    // Pass current terminal size as URL params so backend creates PTY at the
    // correct viewport size from the start (like tmuxes does).
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/v1/ws/terminal/${sessionId}?cols=${term.cols}&rows=${term.rows}`
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
          }
        } catch {}
      }
    }

    ws.onclose = () => {
      useAppStore.getState().setConnected(false)
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
    listenerDisposablesRef.current.forEach((d) => d.dispose())
    listenerDisposablesRef.current = []

    // Send terminal input to WS (skip during IME composition)
    listenerDisposablesRef.current.push(
      term.onData((data) => {
        if (composingRef.current) return
        if (ws.readyState === WebSocket.OPEN) {
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
    listenerDisposablesRef.current.push(
      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        // Only intercept in modern mode
        const mode = useAppStore.getState().keybindingMode
        if (mode !== 'modern') return true

        const ctrl = ev.ctrlKey
        const shift = ev.shiftKey
        const alt = ev.altKey
        const key = ev.key

        // Ctrl+Shift+D → horizontal split
        if (ctrl && shift && !alt && key === 'D') {
          ws.send(new TextEncoder().encode('\x02%'))
          return false
        }
        // Ctrl+Shift+S → vertical split
        if (ctrl && shift && !alt && key === 'S') {
          ws.send(new TextEncoder().encode('\x02"'))
          return false
        }
        // Ctrl+Shift+Q → new window
        if (ctrl && shift && !alt && key === 'Q') {
          ws.send(new TextEncoder().encode('\x02c'))
          return false
        }
        // Ctrl+Shift+X → close pane
        if (ctrl && shift && !alt && key === 'X') {
          ws.send(new TextEncoder().encode('\x02x'))
          return false
        }
        // Ctrl+Shift+1-9 → switch window
        if (ctrl && shift && !alt && key >= '1' && key <= '9') {
          ws.send(new TextEncoder().encode('\x02' + key))
          return false
        }
        // Ctrl+Alt+Arrow → switch pane
        if (ctrl && !shift && alt && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
          const arrowMap: Record<string, string> = {
            ArrowUp: '\x02\x1b[A',
            ArrowDown: '\x02\x1b[B',
            ArrowRight: '\x02\x1b[C',
            ArrowLeft: '\x02\x1b[D',
          }
          ws.send(new TextEncoder().encode(arrowMap[key]))
          return false
        }

        return true // not intercepted — let xterm handle normally
      })
    )

    sessionIdRef.current = sessionId
  }, [sessionId])

  /** Dispose the current terminal and all associated resources */
  const disposeTerminal = useCallback(() => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (mouseUpHandlerRef.current && containerRef.current) {
      containerRef.current.removeEventListener('mouseup', mouseUpHandlerRef.current)
      mouseUpHandlerRef.current = null
    }
    listenerDisposablesRef.current.forEach((d) => d.dispose())
    listenerDisposablesRef.current = []
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

  /** Create a terminal on the given container and return a cleanup function */
  const createTerminal = useCallback((container: HTMLDivElement) => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: 'ui-monospace, Consolas, monospace',
      theme: resolved === 'light' ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME,
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
    const handleMouseUp = () => {
      const selection = term.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection).catch(() => {
          // Clipboard API may fail without user gesture or in insecure contexts
        })
      }
    }
    container.addEventListener('mouseup', handleMouseUp)
    mouseUpHandlerRef.current = handleMouseUp

    // Signal terminal is ready — triggers WS effects
    setTerminalReady(true)
  }, [fontSize, onTitleChange, resolved])

  // Initialize terminal once (when container becomes available)
  const initTerminal = useCallback((container: HTMLDivElement) => {
    if (termRef.current) return

    createTerminal(container)

    return () => {
      disposeTerminal()
    }
  }, [createTerminal, disposeTerminal])

  // Recreate terminal when theme changes (if terminal already exists)
  useEffect(() => {
    // Only act if terminal is already initialized
    if (!termRef.current || !containerRef.current) return

    const container = containerRef.current

    // Dispose old terminal — WS will reconnect via terminalReady effect
    observerRef.current?.disconnect()
    observerRef.current = null
    listenerDisposablesRef.current.forEach((d) => d.dispose())
    listenerDisposablesRef.current = []
    if (wsRef.current) {
      wsRef.current.onclose = null
      wsRef.current.close()
    }
    wsRef.current = null
    termRef.current.dispose()
    termRef.current = null
    fitRef.current = null
    setTerminalReady(false)

    // Create new terminal with updated theme
    createTerminal(container)
  }, [resolved, createTerminal])

  // Connect WS when terminal is ready and session changes
  useEffect(() => {
    if (termRef.current && sessionId && sessionId !== sessionIdRef.current) {
      connectWs()
    }
  }, [sessionId, connectWs])

  // Auto-connect after init (first session)
  useEffect(() => {
    if (termRef.current && sessionId && !wsRef.current) {
      connectWs()
    }
  }, [terminalReady, sessionId, connectWs])

  // Live-update font size when store changes
  useEffect(() => {
    if (termRef.current && termRef.current.options.fontSize !== fontSize) {
      termRef.current.options.fontSize = fontSize
      fitRef.current?.fit()
    }
  }, [fontSize])

  return { initTerminal, terminal: termRef.current }
}
