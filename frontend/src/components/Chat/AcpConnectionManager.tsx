import { useEffect, useRef } from 'react'
import type { Session } from '../../api/client'
import { useAppStore } from '../../stores/appStore'
import { useAcpChat } from '../../hooks/useAcpChat'
import { useAcpConnectionStore } from '../../stores/acpConnectionStore'

/**
 * Persistent connection layer for ACP sessions. Rendered once at the
 * Layout level (outside the keyed SessionView) so WebSocket connections
 * survive session switches. Each activated ACP session gets a dedicated
 * slot that owns its WS lifecycle and registers handles in
 * `acpConnectionStore` for ChatView to consume.
 *
 * Slot 生命周期（X15）：会话删除/归档（从 sessions 列表消失）或被释放
 * （`acp_process_alive === false`）后即出清 slot，不再保留其 WS 与退避重连
 * 循环；之前只增不减，每访问过一个 ACP 会话就永久多一条长连接 + 一条独立
 * 重连循环，数量无上限（2026-09-21 CPU 诊断中「单浏览器 WS 重连 ~20 次/分
 * 持续一天多」的机制解释）。
 */

function AcpSlot({ sessionId }: { sessionId: string }) {
  const { connectionState, sendPrompt, cancel, restore, respondPermission, setConfigOption } = useAcpChat({ sessionId })
  const register = useAcpConnectionStore((s) => s.register)
  const unregister = useAcpConnectionStore((s) => s.unregister)
  const updateState = useAcpConnectionStore((s) => s.updateState)

  const sendRef = useRef(sendPrompt)
  sendRef.current = sendPrompt
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  const restoreRef = useRef(restore)
  restoreRef.current = restore
  const permRef = useRef(respondPermission)
  permRef.current = respondPermission
  const configRef = useRef(setConfigOption)
  configRef.current = setConfigOption

  useEffect(() => {
    register(sessionId, {
      connectionState,
      sendPrompt: (t, images, files) => sendRef.current(t, images, files),
      cancel: () => cancelRef.current(),
      restore: () => restoreRef.current(),
      respondPermission: (id, optionId) => permRef.current(id, optionId),
      setConfigOption: (configId, value) => configRef.current(configId, value),
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

  const liveById = new Map<string, Session>()
  for (const list of Object.values(sessions)) {
    for (const s of list) liveById.set(s.id, s)
  }
  const activeSession = activeSessionId ? liveById.get(activeSessionId) : undefined
  // 当前查看的 ACP 会话必须持有 slot——即使已释放（release）：ChatView 的
  // 「恢复会话」按钮经该连接发 load_session，清掉 slot 会连带清掉 conn。
  const activeHoldsSlot = activeSession?.runtime_kind === 'acp'
  if (activeHoldsSlot && activeSessionId) {
    activatedRef.current.add(activeSessionId)
  }

  // 失效 slot 出清（见组件头注释）：删除/归档 = 已不在默认列表；释放 =
  // acp_process_alive 为 false。活跃会话的 slot 一律保留。
  for (const id of activatedRef.current) {
    if (id === activeSessionId && activeHoldsSlot) continue
    const s = liveById.get(id)
    if (!s || s.acp_process_alive === false) {
      activatedRef.current.delete(id)
    }
  }

  return (
    <>
      {[...activatedRef.current].map((id) => (
        <AcpSlot key={id} sessionId={id} />
      ))}
    </>
  )
}
