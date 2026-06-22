import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

interface UseTerminalOptions {
  sessionId: string | null
  fontSize?: number
  onTitleChange?: (title: string) => void
}

export function useTerminal({ sessionId, fontSize = 14, onTitleChange }: UseTerminalOptions) {
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const composingRef = useRef(false)
  const sessionIdRef = useRef<string | null>(null)
  const listenerDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  // Track terminal readiness so WS effects re-run after initTerminal creates the terminal.
  // Without this, on a fresh mount (key change) all WS effects run BEFORE initTerminal,
  // find termRef.current=null, skip, and never re-run.
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

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/v1/ws/terminal/${sessionId}`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      termRef.current?.writeln('\x1b[32m[connected]\x1b[0m')
      // Send current terminal size so backend PTY matches our viewport
      // (critical: backend creates PTY at a default size, resize must follow immediately)
      if (termRef.current && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }))
      }
    }

    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        termRef.current?.write(new Uint8Array(e.data))
      } else {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'attached') {
            termRef.current?.writeln(`\x1b[36m[attached to ${msg.session}]\x1b[0m`)
          } else if (msg.type === 'error') {
            termRef.current?.writeln(`\x1b[31m[error: ${msg.message}]\x1b[0m`)
          } else if (msg.type === 'exit') {
            termRef.current?.writeln(`\x1b[31m[process exited: ${msg.code}]\x1b[0m`)
          }
        } catch {}
      }
    }

    ws.onclose = () => {
      // Only write if this WS is still the active one
      if (wsRef.current === ws) {
        termRef.current?.writeln('\x1b[31m[disconnected]\x1b[0m')
      }
    }

    ws.onerror = () => {
      if (wsRef.current === ws) {
        termRef.current?.writeln('\x1b[31m[connection error]\x1b[0m')
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

    sessionIdRef.current = sessionId
  }, [sessionId])

  // Initialize terminal once (when container becomes available)
  const initTerminal = useCallback((container: HTMLDivElement) => {
    if (termRef.current) return

    containerRef.current = container

    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: 'ui-monospace, Consolas, monospace',
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
      },
    })

    const fit = new FitAddon()
    const webLinks = new WebLinksAddon()

    term.loadAddon(fit)
    term.loadAddon(webLinks)
    term.open(container)
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

    // Signal terminal is ready — triggers WS effects that ran before initTerminal
    setTerminalReady(true)

    return () => {
      observer.disconnect()
      listenerDisposablesRef.current.forEach((d) => d.dispose())
      listenerDisposablesRef.current = []
      if (wsRef.current) {
        wsRef.current.onclose = null
        wsRef.current.close()
        wsRef.current = null
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
      sessionIdRef.current = null
      setTerminalReady(false)
    }
  }, [fontSize, onTitleChange])

  // Connect WS when terminal is ready and session changes
  useEffect(() => {
    if (termRef.current && sessionId && sessionId !== sessionIdRef.current) {
      connectWs()
    }
  }, [sessionId, connectWs])

  // Auto-connect after init (first session)
  // terminalReady triggers re-render after initTerminal, causing this effect to re-run
  // with termRef.current now set. Without it, on key-change remount the effect runs
  // before initTerminal, finds termRef.current=null, and never re-runs.
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
