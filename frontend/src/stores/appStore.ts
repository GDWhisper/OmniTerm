import { create } from 'zustand'
import type { Project, Workspace, Session } from '../api/client'

// Re-export for convenience
export type { Project, Workspace, Session }

/** Default UI zoom (%). The layout applies `zoom: uiZoom / 100`, so 100 = 100%.
 *  Keep in sync with the reset button in Settings.tsx. */
export const DEFAULT_UI_ZOOM = 100

export const MIN_SIDEBAR_WIDTH = 200
export const DEFAULT_SIDEBAR_WIDTH = 256

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
  rightPanelTab: 'files' | 'git'
  sidebarWidth: number
  fileManagerWidth: number

  // Terminal
  fontSize: number

  // UI zoom (browser-level page zoom via CSS zoom)
  uiZoom: number

  // ACP chat font size (base px for ChatView content)
  chatFontSize: number

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
  /**
   * Per-terminal disconnect flag, decoupled from the global `connected`
   * (which is driven by the Sidebar health poll and only reflects whether
   * the backend is reachable). This is set true only when the *terminal's
   * own* WebSocket/xterm instance is torn down (blur/idle disconnect,
   * ws onclose/onerror), and cleared on a successful terminal WS open.
   * The reconnect overlay keys off this so the Sidebar health poll can't
   * silently hide it.
   */
  terminalDisconnected: boolean

  /**
   * Terminal multiplexer name reported by the backend (`/system/info`):
   * "tmux" on unix, "psmux" on Windows. Display-only — API fields and
   * runtime_kind stay 'tmux' regardless of platform.
   */
  multiplexer: string

  // Mobile
  isMobile: boolean
  activeTab: 'terminal' | 'files' | 'sessions'
  mobileGestureEnabled: boolean
  mobileFontSize: number
  mobileLastTab: string

  // Auth
  authState: 'loading' | 'authenticated' | 'unauthenticated'
  authVersion: number
  setAuthState: (state: AppState['authState']) => void

  // Settings panel
  settingsOpen: boolean
  tmuxCheatsheetOpen: boolean
  immersiveMode: boolean
  pixelAnimationsEnabled: boolean
  soundEnabled: boolean
  soundCoinEnabled: boolean
  soundStompEnabled: boolean
  soundPingEnabled: boolean
  crtScanlines: boolean
  parchmentTextureEnabled: boolean
  /** Pixel display font (BETA). Off = pixel text falls back to reader font;
   *  the top bar row (logo + panel title bars) stays pixel regardless. */
  pixelFontEnabled: boolean

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
  setUiZoom: (z: number) => void
  setChatFontSize: (s: number) => void
  setKeybindingMode: (mode: 'tmux' | 'modern') => void
  setAutoCopySelect: (v: boolean) => void
  setProjects: (p: Project[]) => void
  setWorktrees: (projectId: string, ws: Workspace[]) => void
  setSessions: (projectId: string, sessions: Session[]) => void
  // ACP 进程存活状态由后端 WS 事件驱动即时更新（替代 3 秒轮询）。
  setAcpProcessAlive: (sessionId: string, alive: boolean) => void
  setActiveProject: (id: string | null) => void
  setActiveWorkspace: (id: string | null) => void
  setActiveSession: (id: string | null) => void
  setActiveExternalSession: (name: string | null) => void
  /**
   * Activate a session in one atomic update: clears any active external
   * session, sets the active session, and (if a workspace is active)
   * remembers the session for that workspace. Use this whenever a user
   * picks a session (clicking the sidebar, just-created session, etc.)
   * — sites that need side-effects (e.g. attention notifications) can
   * call those *after* this returns.
   */
  activateSession: (sessionId: string) => void
  setConnected: (v: boolean) => void
  setTerminalDisconnected: (v: boolean) => void
  setMultiplexer: (v: string) => void
  setIsMobile: (v: boolean) => void
  setActiveTab: (tab: AppState['activeTab']) => void
  setRightPanelTab: (tab: AppState['rightPanelTab']) => void
  setMobileGestureEnabled: (v: boolean) => void
  setMobileFontSize: (s: number) => void
  setImmersiveMode: (v: boolean) => void
  setPixelAnimationsEnabled: (v: boolean) => void
  setSoundEnabled: (v: boolean) => void
  setSoundCoinEnabled: (v: boolean) => void
  setSoundStompEnabled: (v: boolean) => void
  setSoundPingEnabled: (v: boolean) => void
  setCrtScanlines: (v: boolean) => void
  setParchmentTextureEnabled: (v: boolean) => void
  setPixelFontEnabled: (v: boolean) => void

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
  rightPanelTab: (localStorage.getItem('omniterm_right_panel_tab') as AppState['rightPanelTab']) || 'files',
  sidebarWidth: (() => {
    const fallback = Math.max(DEFAULT_SIDEBAR_WIDTH, Math.floor((typeof window !== 'undefined' ? window.innerWidth : 1920) / 8))
    const stored = parseInt(localStorage.getItem('omniterm_sidebar_width') || String(fallback))
    // 旧版本默认 160 留下的过窄存档值自愈到合法区间
    return Number.isFinite(stored) ? Math.max(MIN_SIDEBAR_WIDTH, stored) : fallback
  })(),
  fileManagerWidth: parseInt(localStorage.getItem('omniterm_fm_width') || String(Math.max(240, Math.floor((typeof window !== 'undefined' ? window.innerWidth : 1920) * 7 / 24)))),
  fontSize: parseInt(localStorage.getItem('omniterm_font_size') || '14'),
  // Read persisted zoom; fall back to default if missing OR corrupted (e.g. a
  // previously-written 'NaN' is truthy and parses to NaN, so the `||` above
  // would not catch it). Non-finite values self-heal instead of breaking layout.
  uiZoom: (() => {
    const raw = parseInt(localStorage.getItem('omniterm_ui_zoom') ?? String(DEFAULT_UI_ZOOM))
    return Number.isFinite(raw) ? raw : DEFAULT_UI_ZOOM
  })(),
  chatFontSize: parseInt(localStorage.getItem('omniterm_chat_font_size') || '13'),
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

  authState: 'loading' as const,
  authVersion: 0,

  connected: false,
  terminalDisconnected: false,
  multiplexer: 'tmux',
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
  soundCoinEnabled: localStorage.getItem('omniterm_sound_coin_enabled') !== 'false',
  soundStompEnabled: localStorage.getItem('omniterm_sound_stomp_enabled') !== 'false',
  soundPingEnabled: localStorage.getItem('omniterm_sound_ping_enabled') !== 'false',
  crtScanlines: localStorage.getItem('omniterm_crt_scanlines') === 'true',
  parchmentTextureEnabled: localStorage.getItem('omniterm_parchment_texture') !== 'false',
  // Default off: first-run users get the uniform reader font (BETA opt-in).
  pixelFontEnabled: localStorage.getItem('omniterm_pixel_font') === 'true',

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleFileManager: () => set((s) => ({ fileManagerOpen: !s.fileManagerOpen })),
  toggleFileManagerCollapsed: () => set((s) => ({ fileManagerCollapsed: !s.fileManagerCollapsed })),
  setRightPanelTab: (tab) => {
    localStorage.setItem('omniterm_right_panel_tab', tab)
    set({ rightPanelTab: tab })
  },
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen, tmuxCheatsheetOpen: false })),
  toggleTmuxCheatsheet: () => set((s) => ({ tmuxCheatsheetOpen: !s.tmuxCheatsheetOpen, settingsOpen: false })),

  setSidebarWidth: (w) => set({ sidebarWidth: w }),

  setFileManagerWidth: (w) => set({ fileManagerWidth: w }),

  setFontSize: (s) => {
    const clamped = Math.max(10, Math.min(24, s))
    localStorage.setItem('omniterm_font_size', String(clamped))
    set({ fontSize: clamped })
  },

  setUiZoom: (z) => {
    // Guard against non-finite input (e.g. undefined/NaN) so we never persist a
    // 'NaN' string that would later poison the layout. Clamp only valid numbers.
    if (!Number.isFinite(z)) return
    const clamped = Math.max(50, Math.min(200, z))
    localStorage.setItem('omniterm_ui_zoom', String(clamped))
    set({ uiZoom: clamped })
  },

  setChatFontSize: (s) => {
    const clamped = Math.max(10, Math.min(20, s))
    localStorage.setItem('omniterm_chat_font_size', String(clamped))
    set({ chatFontSize: clamped })
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
  setAcpProcessAlive: (sessionId, alive) =>
    set((s) => {
      const next: Record<string, Session[]> = {}
      for (const [pid, list] of Object.entries(s.sessions)) {
        next[pid] = list.map((x) =>
          x.id === sessionId ? { ...x, acp_process_alive: alive } : x,
        )
      }
      return { sessions: next }
    }),
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

  /**
   * Atomic session activation — see interface for contract. Batches all
   * related state + localStorage writes into one set() so subscribers
   * re-render at most once. Mirrors the pattern used by switchWorkspace.
   */
  activateSession: (sessionId) => {
    const { activeWorkspaceId, workspaceSessionMemory } = get()
    localStorage.setItem('omniterm_active_session', sessionId)
    const newMemory = activeWorkspaceId
      ? { ...workspaceSessionMemory, [activeWorkspaceId]: sessionId }
      : workspaceSessionMemory
    if (activeWorkspaceId) {
      localStorage.setItem('omniterm_ws_session_memory', JSON.stringify(newMemory))
    }
    set({
      activeExternalSession: null,
      activeSessionId: sessionId,
      workspaceSessionMemory: newMemory,
    })
  },
  setConnected: (v) => set({ connected: v }),
  setAuthState: (state) =>
    set((s) => ({ authState: state, authVersion: s.authVersion + 1 })),
  setTerminalDisconnected: (v) => set({ terminalDisconnected: v }),
  setMultiplexer: (v) => set({ multiplexer: v }),
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
  setSoundCoinEnabled: (v) => {
    localStorage.setItem('omniterm_sound_coin_enabled', String(v))
    set({ soundCoinEnabled: v })
  },
  setSoundStompEnabled: (v) => {
    localStorage.setItem('omniterm_sound_stomp_enabled', String(v))
    set({ soundStompEnabled: v })
  },
  setSoundPingEnabled: (v) => {
    localStorage.setItem('omniterm_sound_ping_enabled', String(v))
    set({ soundPingEnabled: v })
  },
  setCrtScanlines: (v) => {
    localStorage.setItem('omniterm_crt_scanlines', String(v))
    set({ crtScanlines: v })
  },
  setParchmentTextureEnabled: (v) => {
    localStorage.setItem('omniterm_parchment_texture', String(v))
    set({ parchmentTextureEnabled: v })
  },
  setPixelFontEnabled: (v) => {
    localStorage.setItem('omniterm_pixel_font', String(v))
    set({ pixelFontEnabled: v })
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
