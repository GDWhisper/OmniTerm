import { create } from 'zustand'
import type { AcpConnectionState } from '../hooks/useAcpChat'

interface AcpConnectionEntry {
  connectionState: AcpConnectionState
  sendPrompt: (text: string) => void
  cancel: () => void
  restore: () => void
  respondPermission: (id: string, optionId: string) => void
}

interface AcpConnectionStore {
  connections: Record<string, AcpConnectionEntry>
  register: (sessionId: string, entry: AcpConnectionEntry) => void
  unregister: (sessionId: string) => void
  updateState: (sessionId: string, state: AcpConnectionState) => void
}

export const useAcpConnectionStore = create<AcpConnectionStore>((set) => ({
  connections: {},

  register: (sessionId, entry) =>
    set((s) => ({ connections: { ...s.connections, [sessionId]: entry } })),

  unregister: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.connections)) return s
      const next = { ...s.connections }
      delete next[sessionId]
      return { connections: next }
    }),

  updateState: (sessionId, state) =>
    set((s) => {
      const existing = s.connections[sessionId]
      if (!existing) return s
      return {
        connections: {
          ...s.connections,
          [sessionId]: { ...existing, connectionState: state },
        },
      }
    }),
}))
