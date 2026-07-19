import { useEffect, useRef } from 'react'
import { useAppStore } from '../stores/appStore'
import { useAcpChat } from '../hooks/useAcpChat'
import { useAcpConnectionStore } from '../stores/acpConnectionStore'

/**
 * Persistent connection layer for ACP sessions. Rendered once at the
 * Layout level (outside the keyed SessionView) so WebSocket connections
 * survive session switches. Each activated ACP session gets a dedicated
 * slot that owns its WS lifecycle and registers handles in
 * `acpConnectionStore` for ChatView to consume.
 */

function AcpSlot({ sessionId }: { sessionId: string }) {
  const { connectionState, sendPrompt, cancel, restore } = useAcpChat({ sessionId })
  const register = useAcpConnectionStore((s) => s.register)
  const unregister = useAcpConnectionStore((s) => s.unregister)
  const updateState = useAcpConnectionStore((s) => s.updateState)

  const sendRef = useRef(sendPrompt)
  sendRef.current = sendPrompt
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  const restoreRef = useRef(restore)
  restoreRef.current = restore

  useEffect(() => {
    register(sessionId, {
      connectionState,
      sendPrompt: (t) => sendRef.current(t),
      cancel: () => cancelRef.current(),
      restore: () => restoreRef.current(),
    })
    return () => unregister(sessionId)
  }, [sessionId, register, unregister])

  useEffect(() => {
    updateState(sessionId, connectionState)
  }, [sessionId, connectionState, updateState])

  return null
}

export function AcpConnectionManager() {
  const activeSessionId = useAppStore((s) => s.activeSessionId)
  const sessions = useAppStore((s) => s.sessions)
  const activatedRef = useRef<Set<string>>(new Set())

  const activeSession = activeSessionId
    ? Object.values(sessions).flat().find((s) => s.id === activeSessionId)
    : null

  if (activeSession?.runtime_kind === 'acp' && activeSessionId) {
    activatedRef.current.add(activeSessionId)
  }

  return (
    <>
      {[...activatedRef.current].map((id) => (
        <AcpSlot key={id} sessionId={id} />
      ))}
    </>
  )
}
