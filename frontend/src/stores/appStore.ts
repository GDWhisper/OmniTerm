import { create } from 'zustand'

interface Workspace {
  id: string
  name: string
  root_path: string
  target_id?: string
  created_at: string
}

interface Session {
  id: string
  workspace_id: string
  name?: string
  tmux_session_name?: string
  hook_enabled: boolean
  hook_status?: string
  created_at: string
}

interface FmSessionState {
  mode: 'following' | 'manual'
  manualPath: string | null // absolute path when in manual mode
  drawerPath: string | null // file path open in drawer (null = closed)
  drawerMode: 'view' | 'edit' // drawer view/edit mode
}

interface AppState {
  // Layout
  sidebarOpen: boolean
  sidebarCollapsed: boolean
  fileManagerOpen: boolean
  fileManagerCollapsed: boolean
  sidebarWidth: number
  fileManagerWidth: number

  // Terminal
  fontSize: number

  // Data
  workspaces: Workspace[]
  sessions: Session[]
  activeWorkspaceId: string | null
  activeSessionId: string | null

  // FM session states
  fmSessionStates: Record<string, FmSessionState>

  // Connection
  connected: boolean

  // Mobile
  isMobile: boolean
  activeTab: 'terminal' | 'files' | 'sessions' | 'settings'

  // Settings panel
  settingsOpen: boolean

  // Actions
  toggleSidebar: () => void
  toggleSidebarCollapsed: () => void
  toggleFileManager: () => void
  toggleFileManagerCollapsed: () => void
  toggleSettings: () => void
  setSidebarWidth: (w: number) => void
  setFileManagerWidth: (w: number) => void
  setFontSize: (s: number) => void
  setWorkspaces: (ws: Workspace[]) => void
  setSessions: (s: Session[]) => void
  setActiveWorkspace: (id: string | null) => void
  setActiveSession: (id: string | null) => void
  setConnected: (v: boolean) => void
  setIsMobile: (v: boolean) => void
  setActiveTab: (tab: AppState['activeTab']) => void

  // FM session actions
  setFmSessionMode: (sessionId: string, mode: 'following' | 'manual') => void
  setFmManualPath: (sessionId: string, path: string | null) => void
  resetFmToFollowing: (sessionId: string) => void
  setFmDrawerPath: (sessionId: string, path: string | null, mode?: 'view' | 'edit') => void
  closeFmDrawer: (sessionId: string) => void
}

export const useAppStore = create<AppState>((set) => ({
  sidebarOpen: true,
  sidebarCollapsed: false,
  fileManagerOpen: true,
  fileManagerCollapsed: false,
  sidebarWidth: parseInt(localStorage.getItem('omniterm_sidebar_width') || '200'),
  fileManagerWidth: parseInt(localStorage.getItem('omniterm_fm_width') || '300'),
  fontSize: parseInt(localStorage.getItem('omniterm_font_size') || '14'),

  workspaces: [],
  sessions: [],
  activeWorkspaceId: null,
  activeSessionId: null,

  fmSessionStates: {},

  connected: false,
  isMobile: false,
  activeTab: 'terminal',
  settingsOpen: false,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleFileManager: () => set((s) => ({ fileManagerOpen: !s.fileManagerOpen })),
  toggleFileManagerCollapsed: () => set((s) => ({ fileManagerCollapsed: !s.fileManagerCollapsed })),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),

  setSidebarWidth: (w) => set({ sidebarWidth: w }),

  setFileManagerWidth: (w) => set({ fileManagerWidth: w }),

  setFontSize: (s) => {
    const clamped = Math.max(10, Math.min(24, s))
    localStorage.setItem('omniterm_font_size', String(clamped))
    set({ fontSize: clamped })
  },

  setWorkspaces: (workspaces) => set({ workspaces }),
  setSessions: (sessions) => set({ sessions }),
  setActiveWorkspace: (id) => set({ activeWorkspaceId: id }),
  setActiveSession: (id) => set({ activeSessionId: id }),
  setConnected: (v) => set({ connected: v }),
  setIsMobile: (v) => set({ isMobile: v }),
  setActiveTab: (tab) => set({ activeTab: tab }),

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
