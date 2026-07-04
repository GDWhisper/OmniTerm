import { create } from 'zustand'
import type { Project, Workspace, Session } from '../api/client'

// Re-export for convenience
export type { Project, Workspace, Session }

interface FmSessionState {
  mode: 'following' | 'manual'
  manualPath: string | null // absolute path when in manual mode
  drawerPath: string | null // file path open in drawer (null = closed)
  drawerMode: 'view' | 'edit' // drawer view/edit mode
}

export interface AppState {
  // Layout
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  fileManagerOpen: boolean
  fileManagerCollapsed: boolean
  sidebarWidth: number
  fileManagerWidth: number

  // Terminal
  fontSize: number

  // Keybinding
  keybindingMode: 'tmux' | 'modern'

  // Terminal behavior
  autoCopySelect: boolean

  // Data
  projects: Project[]
  worktrees: Record<string, Workspace[]> // keyed by project_id
  sessions: Record<string, Session[]> // keyed by project_id
  activeProjectId: string | null
  activeWorkspaceId: string | null // worktree id
  activeSessionId: string | null
  activeExternalSession: string | null // tmux session name (not in DB yet)

  // Per-workspace terminal memory: workspaceId → last active sessionId
  workspaceSessionMemory: Record<string, string>

  // FM session states
  fmSessionStates: Record<string, FmSessionState>

  // Connection
  connected: boolean

  // Mobile
  isMobile: boolean
  activeTab: 'terminal' | 'files' | 'sessions'
  mobileGestureEnabled: boolean
  mobileFontSize: number
  mobileLastTab: string

  // Settings panel
  settingsOpen: boolean
  tmuxCheatsheetOpen: boolean
  immersiveMode: boolean
  pixelAnimationsEnabled: boolean
  soundEnabled: boolean
  crtScanlines: boolean
  parchmentTextureEnabled: boolean
  transitionsEnabled: boolean

  // Actions
  toggleSidebar: () => void
  toggleSidebarCollapsed: () => void
  toggleFileManager: () => void
  toggleFileManagerCollapsed: () => void
  toggleSettings: () => void
  toggleTmuxCheatsheet: () => void
  setSidebarWidth: (w: number) => void
  setFileManagerWidth: (w: number) => void
  setFontSize: (s: number) => void
  setKeybindingMode: (mode: 'tmux' | 'modern') => void
  setAutoCopySelect: (v: boolean) => void
  setProjects: (p: Project[]) => void
  setWorktrees: (projectId: string, ws: Workspace[]) => void
  setSessions: (projectId: string, sessions: Session[]) => void
  setActiveProject: (id: string | null) => void
  setActiveWorkspace: (id: string | null) => void
  setActiveSession: (id: string | null) => void
  setActiveExternalSession: (name: string | null) => void
  setConnected: (v: boolean) => void
  setIsMobile: (v: boolean) => void
  setActiveTab: (tab: AppState['activeTab']) => void
  setMobileGestureEnabled: (v: boolean) => void
  setMobileFontSize: (s: number) => void
  setImmersiveMode: (v: boolean) => void
  setPixelAnimationsEnabled: (v: boolean) => void
  setSoundEnabled: (v: boolean) => void
  setCrtScanlines: (v: boolean) => void
  setParchmentTextureEnabled: (v: boolean) => void
  setTransitionsEnabled: (v: boolean) => void

  // Workspace switching (batched update, replaces 3-4 separate set* calls)
  switchWorkspace: (project: Project, workspace: Workspace) => void

  // Workspace session memory
  setWorkspaceSession: (workspaceId: string, sessionId: string) => void
  clearWorkspaceSession: (workspaceId: string) => void

  // FM session actions
  setFmSessionMode: (sessionId: string, mode: 'following' | 'manual') => void
  setFmManualPath: (sessionId: string, path: string | null) => void
  resetFmToFollowing: (sessionId: string) => void
  setFmDrawerPath: (sessionId: string, path: string | null, mode?: 'view' | 'edit') => void
  closeFmDrawer: (sessionId: string) => void
}

export const useAppStore = create<AppState>((set, get) => ({
  sidebarOpen: true,
  sidebarCollapsed: false,
  fileManagerOpen: true,
  fileManagerCollapsed: false,
  sidebarWidth: parseInt(localStorage.getItem('omniterm_sidebar_width') || '200'),
  fileManagerWidth: parseInt(localStorage.getItem('omniterm_fm_width') || String(Math.max(240, Math.floor((typeof window !== 'undefined' ? window.innerWidth : 1920) * 7 / 24)))),
  fontSize: parseInt(localStorage.getItem('omniterm_font_size') || '14'),
  keybindingMode: (localStorage.getItem('omniterm_keybinding_mode') as 'tmux' | 'modern') || 'tmux',
  autoCopySelect: localStorage.getItem('omniterm_auto_copy_select') !== 'false',

  projects: [],
  worktrees: {},
  sessions: {},
  activeProjectId: localStorage.getItem('omniterm_active_project') || null,
  activeWorkspaceId: localStorage.getItem('omniterm_active_workspace') || null,
  activeSessionId: localStorage.getItem('omniterm_active_session') || null,
  activeExternalSession: null,

  workspaceSessionMemory: (() => {
    try {
      return JSON.parse(localStorage.getItem('omniterm_ws_session_memory') || '{}')
    } catch {
      return {}
    }
  })(),

  fmSessionStates: {},

  connected: false,
  isMobile: typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false,
  activeTab: (localStorage.getItem('omniterm_mobile_last_tab') as AppState['activeTab']) || 'terminal',
  mobileGestureEnabled: localStorage.getItem('omniterm_mobile_gesture_enabled') !== 'false',
  mobileFontSize: parseInt(localStorage.getItem('omniterm_mobile_font_size') || '13'),
  mobileLastTab: localStorage.getItem('omniterm_mobile_last_tab') || 'terminal',
  settingsOpen: false,
  tmuxCheatsheetOpen: false,
  immersiveMode: false,  // Disabled by default - feature not yet verified
  pixelAnimationsEnabled: localStorage.getItem('omniterm_pixel_animations') === 'true',
  soundEnabled: localStorage.getItem('omniterm_sound_enabled') === 'true',
  crtScanlines: localStorage.getItem('omniterm_crt_scanlines') === 'true',
  parchmentTextureEnabled: localStorage.getItem('omniterm_parchment_texture') !== 'false',
  transitionsEnabled: localStorage.getItem('omniterm_transitions') !== 'false',

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleFileManager: () => set((s) => ({ fileManagerOpen: !s.fileManagerOpen })),
  toggleFileManagerCollapsed: () => set((s) => ({ fileManagerCollapsed: !s.fileManagerCollapsed })),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen, tmuxCheatsheetOpen: false })),
  toggleTmuxCheatsheet: () => set((s) => ({ tmuxCheatsheetOpen: !s.tmuxCheatsheetOpen, settingsOpen: false })),

  setSidebarWidth: (w) => set({ sidebarWidth: w }),

  setFileManagerWidth: (w) => set({ fileManagerWidth: w }),

  setFontSize: (s) => {
    const clamped = Math.max(10, Math.min(24, s))
    localStorage.setItem('omniterm_font_size', String(clamped))
    set({ fontSize: clamped })
  },

  setKeybindingMode: (mode) => {
    localStorage.setItem('omniterm_keybinding_mode', mode)
    set({ keybindingMode: mode })
  },

  setAutoCopySelect: (v) => {
    localStorage.setItem('omniterm_auto_copy_select', String(v))
    set({ autoCopySelect: v })
  },

  setProjects: (projects) => set({ projects }),
  setWorktrees: (projectId, ws) =>
    set((s) => ({ worktrees: { ...s.worktrees, [projectId]: ws } })),
  setSessions: (projectId, sessions) =>
    set((s) => ({ sessions: { ...s.sessions, [projectId]: sessions } })),
  setActiveProject: (id) => {
    if (id) localStorage.setItem('omniterm_active_project', id)
    else localStorage.removeItem('omniterm_active_project')
    set({ activeProjectId: id })
  },
  setActiveWorkspace: (id) => {
    if (id) localStorage.setItem('omniterm_active_workspace', id)
    else localStorage.removeItem('omniterm_active_workspace')
    set({ activeWorkspaceId: id })
  },
  setActiveSession: (id) => {
    if (id) localStorage.setItem('omniterm_active_session', id)
    else localStorage.removeItem('omniterm_active_session')
    set({ activeSessionId: id })
  },
  setActiveExternalSession: (name) => set({ activeExternalSession: name }),
  setConnected: (v) => set({ connected: v }),
  setIsMobile: (v) => set({ isMobile: v }),
  setActiveTab: (tab) => {
    localStorage.setItem('omniterm_mobile_last_tab', tab)
    set({ activeTab: tab, mobileLastTab: tab })
  },
  setMobileGestureEnabled: (v) => {
    localStorage.setItem('omniterm_mobile_gesture_enabled', String(v))
    set({ mobileGestureEnabled: v })
  },
  setMobileFontSize: (s) => {
    const clamped = Math.max(12, Math.min(20, s))
    localStorage.setItem('omniterm_mobile_font_size', String(clamped))
    set({ mobileFontSize: clamped })
  },
  setImmersiveMode: (v) => {
    localStorage.setItem('omniterm_immersive_mode', String(v))
    set({ immersiveMode: v })
  },
  setPixelAnimationsEnabled: (v) => {
    localStorage.setItem('omniterm_pixel_animations', String(v))
    set({ pixelAnimationsEnabled: v })
  },
  setSoundEnabled: (v) => {
    localStorage.setItem('omniterm_sound_enabled', String(v))
    set({ soundEnabled: v })
  },
  setCrtScanlines: (v) => {
    localStorage.setItem('omniterm_crt_scanlines', String(v))
    set({ crtScanlines: v })
  },
  setParchmentTextureEnabled: (v) => {
    localStorage.setItem('omniterm_parchment_texture', String(v))
    set({ parchmentTextureEnabled: v })
  },
  setTransitionsEnabled: (v) => {
    localStorage.setItem('omniterm_transitions', String(v))
    set({ transitionsEnabled: v })
  },

  /** Batch all workspace-switch state into one set() to avoid cascading re-renders. */
  switchWorkspace: (project, workspace) => {
    const state = get()
    const isSameWorkspace = workspace.id === state.activeWorkspaceId
    const newWorkspaceId = isSameWorkspace ? null : workspace.id

    let newSessionId: string | null = null
    if (!isSameWorkspace) {
      const rememberedId = state.workspaceSessionMemory[workspace.id]
      const wtSessions = (state.sessions[project.id] || []).filter(
        (s) => s.workspace_path === workspace.path,
      )
      if (rememberedId && wtSessions.some((s) => s.id === rememberedId)) {
        newSessionId = rememberedId
      }
    }

    // localStorage — mirrors the individual set*() helpers but all at once
    localStorage.setItem('omniterm_active_project', project.id)
    if (newWorkspaceId) {
      localStorage.setItem('omniterm_active_workspace', newWorkspaceId)
    } else {
      localStorage.removeItem('omniterm_active_workspace')
    }
    if (newSessionId) {
      localStorage.setItem('omniterm_active_session', newSessionId)
    } else {
      localStorage.removeItem('omniterm_active_session')
    }

    set({
      activeProjectId: project.id,
      activeWorkspaceId: newWorkspaceId,
      activeSessionId: newSessionId,
      activeExternalSession: null,
    })
  },

  setWorkspaceSession: (workspaceId, sessionId) =>
    set((s) => {
      const next = { ...s.workspaceSessionMemory, [workspaceId]: sessionId }
      localStorage.setItem('omniterm_ws_session_memory', JSON.stringify(next))
      return { workspaceSessionMemory: next }
    }),

  clearWorkspaceSession: (workspaceId) =>
    set((s) => {
      const next = { ...s.workspaceSessionMemory }
      delete next[workspaceId]
      localStorage.setItem('omniterm_ws_session_memory', JSON.stringify(next))
      return { workspaceSessionMemory: next }
    }),

  setFmSessionMode: (sessionId, mode) =>
    set((s) => ({
      fmSessionStates: {
        ...s.fmSessionStates,
        [sessionId]: {
          ...s.fmSessionStates[sessionId],
          mode,
          ...(mode === 'following' ? { manualPath: null } : {}),
        },
      },
    })),

  setFmManualPath: (sessionId, path) =>
    set((s) => ({
      fmSessionStates: {
        ...s.fmSessionStates,
        [sessionId]: { ...s.fmSessionStates[sessionId], mode: 'manual', manualPath: path },
      },
    })),

  resetFmToFollowing: (sessionId) =>
    set((s) => ({
      fmSessionStates: {
        ...s.fmSessionStates,
        [sessionId]: {
          ...s.fmSessionStates[sessionId],
          mode: 'following',
          manualPath: null,
        },
      },
    })),

  setFmDrawerPath: (sessionId, path, mode = 'view') =>
    set((s) => ({
      fmSessionStates: {
        ...s.fmSessionStates,
        [sessionId]: {
          ...s.fmSessionStates[sessionId],
          drawerPath: path,
          drawerMode: mode,
        },
      },
    })),

  closeFmDrawer: (sessionId) =>
    set((s) => ({
      fmSessionStates: {
        ...s.fmSessionStates,
        [sessionId]: {
          ...s.fmSessionStates[sessionId],
          drawerPath: null,
        },
      },
    })),
}))
