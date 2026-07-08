import { useEffect, useRef, useState, useCallback } from 'react'

export interface FileChangeEvent {
  kind: 'create' | 'modify' | 'delete' | 'rename'
  path: string
  newPath?: string
}

interface UseFileWatcherOptions {
  /** Session ID to watch */
  sessionId: string | null
  /** Whether the watcher is enabled */
  enabled?: boolean
}

interface UseFileWatcherReturn {
  /** Latest file change event (null if no recent event) */
  lastEvent: FileChangeEvent | null
  /** Whether the SSE connection is active */
  connected: boolean
  /** Manually reconnect */
  reconnect: () => void
}

const RECONNECT_DELAY = 3000

/**
 * SSE-based file watcher hook.
 * Connects to /api/v1/files/watch and provides real-time file change events.
 * Replaces the previous 3-second polling mechanism.
 */
export function useFileWatcher({ sessionId, enabled = true }: UseFileWatcherOptions): UseFileWatcherReturn {
  const [lastEvent, setLastEvent] = useState<FileChangeEvent | null>(null)
  const [connected, setConnected] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const connectRef = useRef<(() => void) | null>(null)

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    setConnected(false)
  }, [])

  const connect = useCallback(() => {
    cleanup()
    if (!sessionId || !enabled || !mountedRef.current) return

    const url = `/api/v1/files/watch?session=${sessionId}`
    const es = new EventSource(url)
    eventSourceRef.current = es

    es.onopen = () => {
      if (mountedRef.current) setConnected(true)
    }

    es.addEventListener('change', (e: MessageEvent) => {
      if (!mountedRef.current) return
      try {
        const data = JSON.parse(e.data) as FileChangeEvent
        setLastEvent(data)
      } catch {
        // ignore malformed events
      }
    })

    es.onerror = () => {
      if (!mountedRef.current) return
      setConnected(false)
      es.close()
      eventSourceRef.current = null
      // Auto-reconnect after delay
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) connectRef.current?.()
      }, RECONNECT_DELAY)
    }
  }, [sessionId, enabled, cleanup])

  connectRef.current = connect

  // Connect on mount / session change
  useEffect(() => {
    mountedRef.current = true
    connect()
    return () => {
      mountedRef.current = false
      cleanup()
    }
  }, [connect])

  const reconnect = useCallback(() => {
    connect()
  }, [connect])

  return { lastEvent, connected, reconnect }
}
