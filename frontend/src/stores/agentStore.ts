import { create } from 'zustand'
import type { Agent, CreateAgent, UpdateAgent } from '../api/client'
import { api } from '../api/client'

export type { Agent }

/**
 * Minimal store for Agent configurations (the `agents` table). Used by:
 *   - AgentPicker (create-session flow): reads `agents`
 *   - AgentSettings (CRUD panel): calls the actions
 *
 * Session-bound ACP state (the live connection to a spawned agent) lives in
 * the terminal WS, not here — this store is the static config catalog only.
 */
interface AgentState {
  agents: Agent[]
  loaded: boolean
  loading: boolean

  loadAgents: () => Promise<void>
  createAgent: (data: CreateAgent) => Promise<Agent>
  updateAgent: (id: string, data: UpdateAgent) => Promise<Agent>
  deleteAgent: (id: string) => Promise<void>
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  loaded: false,
  loading: false,

  loadAgents: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      const agents = await api.listAgents()
      set({ agents, loaded: true })
    } catch {
      // api client already toasts the error
    } finally {
      set({ loading: false })
    }
  },

  createAgent: async (data) => {
    const created = await api.createAgent(data)
    set((s) => ({ agents: [created, ...s.agents] }))
    return created
  },

  updateAgent: async (id, data) => {
    const updated = await api.updateAgent(id, data)
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? updated : a)),
    }))
    return updated
  },

  deleteAgent: async (id) => {
    await api.deleteAgent(id)
    set((s) => ({ agents: s.agents.filter((a) => a.id !== id) }))
  },
}))
