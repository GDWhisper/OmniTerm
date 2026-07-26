import { create } from 'zustand'
import { api, type GitBind, type GitStatus, type GitBranch } from '../api/client'

/** Serial refresh interval: next poll is scheduled this long AFTER the previous completes. */
export const GIT_POLL_INTERVAL_MS = 5000

interface GitState {
  /** Latest status for the currently bound repo (null = not loaded yet). */
  status: GitStatus | null
  branches: GitBranch[]
  statusLoading: boolean
  /** True while a mutation (stage/commit/push/…) is in flight — serializes
   *  index mutations to avoid racing git's index.lock. */
  mutating: boolean
  /** Bumped by external change hints (ACP edit tool_call completed) so the
   *  visible panel refreshes immediately instead of waiting for the poll. */
  refreshHint: number

  fetchStatus: (bind: GitBind) => Promise<void>
  fetchBranches: (bind: GitBind) => Promise<void>
  /** Run a git mutation serially; refreshes status afterwards. Throws on error. */
  mutate: (bind: GitBind, op: () => Promise<unknown>) => Promise<void>
  notifyExternalChange: () => void
  reset: () => void
}

export const useGitStore = create<GitState>((set, get) => ({
  status: null,
  branches: [],
  statusLoading: false,
  mutating: false,
  refreshHint: 0,

  fetchStatus: async (bind) => {
    set({ statusLoading: true })
    try {
      const status = await api.gitStatus(bind)
      set({ status })
    } catch {
      // Poll errors are transient (session switching, backend restart);
      // keep the last known status instead of flashing an error state.
    } finally {
      set({ statusLoading: false })
    }
  },

  fetchBranches: async (bind) => {
    try {
      const data = await api.gitBranches(bind)
      set({ branches: 'branches' in data ? data.branches : [] })
    } catch {
      set({ branches: [] })
    }
  },

  mutate: async (bind, op) => {
    if (get().mutating) return
    set({ mutating: true })
    try {
      await op()
      await get().fetchStatus(bind)
    } finally {
      set({ mutating: false })
    }
  },

  notifyExternalChange: () => set((s) => ({ refreshHint: s.refreshHint + 1 })),

  reset: () => set({ status: null, branches: [] }),
}))
