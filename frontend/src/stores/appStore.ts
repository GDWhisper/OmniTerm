import { create } from 'zustand'
import type { Project, Workspace, Session } from '../api/client'
import { toAbsolutePath } from '../utils/path'

// Re-export for convenience
export type { Project, Workspace, Session }

/** Default UI zoom (%). The layout applies `zoom: uiZoom / 100`, so 100 = 100%.
 *  Keep in sync with the reset button in Settings.tsx. */
export const DEFAULT_UI_ZOOM = 100

export const MIN_SIDEBAR_WIDTH = 200
export const DEFAULT_SIDEBAR_WIDTH = 256

// Disconnect / recycle timeouts (minutes). Persisted via localStorage for
// blur & idle; acp recycle is in-memory only (backend API lands separately).
export const MIN_DISCONNECT_MIN = 1
export const MAX_DISCONNECT_MIN = 60
export const DEFAULT_BLUR_DISCONNECT_MIN = 10
export const DEFAULT_IDLE_DISCONNECT_MIN = 15
export const DEFAULT_ACP_IDLE_RECYCLE_MIN = 5

/** Clamp a disconnect timeout (minutes) into the supported range. */
function clampDisconnectMin(n: number): number {
  return Math.max(MIN_DISCONNECT_MIN, Math.min(MAX_DISCONNECT_MIN, n))
}

/**
 * Read a persisted disconnect timeout (minutes). Missing, non-finite, or
 * out-of-range stored values self-heal to the fallback default.
 */
function readDisconnectMin(key: string, fallback: number): number {
  const raw = parseInt(localStorage.getItem(key) ?? '', 10)
  if (!Number.isFinite(raw) || raw < MIN_DISCONNECT_MIN || raw > MAX_DISCONNECT_MIN) {
    return fallback
  }
  return raw
}

interface FmSessionState {
  mode: 'following' | 'manual'
  manualPath: string | null // absolute path when in manual mode
  drawerPath: string | null // file path open in drawer (null = closed)
  drawerMode: 'view' | 'edit' // drawer view/edit mode
}

/** A session's FM state before the user has interacted with the panel. */
export const DEFAULT_FM_SESSION_STATE: FmSessionState = {
  mode: 'following',
  manualPath: null,
  drawerPath: null,
  drawerMode: 'view',
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

  // Disconnect / recycle timeouts (minutes)
  blurDisconnectMin: number
  idleDisconnectMin: number
  acpIdleRecycleMin: number

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

  /** Registered sendData from the active terminal for cross-component access. */
  terminalSendData: ((data: string) => void) | null
  setTerminalSendData: (fn: ((data: string) => void) | null) => void

  // Mobile
  isMobile: boolean
  activeTab: 'terminal' | 'files' | 'sessions'
  mobileGestureEnabled: boolean
  mobileHapticEnabled: boolean
  mobileFontSize: number
  mobileLastTab: string

  // Auth
  authState: 'loading' | 'authenticated' | 'unauthenticated'
  authVersion: number
  /** Password-verification master switch (mirrors backend settings.auth_enabled). */
  authEnabled: boolean
  setAuthState: (state: AppState['authState']) => void
  setAuthEnabled: (v: boolean) => void

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
  /** Expand thinking blocks in chat by default (ON = visible, OFF = collapsed). */
  expandThinking: boolean
  /** Expand tool-call blocks in chat by default (ON = visible, OFF = collapsed). */
  expandToolCalls: boolean
  /** Expand all session-hosting worktrees in the sidebar (ON = all expanded, OFF = focused worktree only). */
  expandAllSessions: boolean

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
  setBlurDisconnectMin: (n: number) => void
  setIdleDisconnectMin: (n: number) => void
  setAcpIdleRecycleMin: (n: number) => void
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
  setMobileHapticEnabled: (v: boolean) => void
  setMobileFontSize: (s: number) => void
  setImmersiveMode: (v: boolean) => void
  setPixelAnimationsEnabled: (v: boolean) => void
  setSoundEnabled: (v: boolean) => void
  setSoundCoinEnabled: (v: boolean) => void
  setSoundStompEnabled: (v: boolean) => void
  setSoundPingEnabled: (v: boolean) => void
  setCrtScanlines: (v: boolean) => void
  setParchmentTextureEnabled: (v: boolean) => void
  setExpandThinking: (v: boolean) => void
  setExpandToolCalls: (v: boolean) => void
  setExpandAllSessions: (v: boolean) => void
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
  /**
   * Open a file reported from outside the FileManager (e.g. an ACP tool call's
   * `locations`) in the drawer, making the drawer actually visible in one
   * atomic update: panel open, un-collapsed, on the `files` tab (and on the
   * `files` pane on mobile). `reportedPath` may be relative to the session's
   * workspace root; it is resolved via [`toAbsolutePath`].
   *
   * Batched into a single `set()` (same rationale as `activateSession`) so
   * subscribers re-render at most once instead of four times.
   */
  revealFileInDrawer: (sessionId: string, reportedPath: string) => void
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
  blurDisconnectMin: readDisconnectMin('omniterm_blur_disconnect_min', DEFAULT_BLUR_DISCONNECT_MIN),
  idleDisconnectMin: readDisconnectMin('omniterm_idle_disconnect_min', DEFAULT_IDLE_DISCONNECT_MIN),
  // Pure in-memory — the backend recycle setting isn't wired up yet.
  acpIdleRecycleMin: DEFAULT_ACP_IDLE_RECYCLE_MIN,
  terminalSendData: null as ((data: string) => void) | null,

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
  authEnabled: true,

  connected: false,
  terminalDisconnected: false,
  multiplexer: 'tmux',
  isMobile: typeof window !== 'undefined' ? window.matchMedia('(max-width: 768px)').matches : false,
  activeTab: (localStorage.getItem('omniterm_mobile_last_tab') as AppState['activeTab']) || 'terminal',
  mobileGestureEnabled: localStorage.getItem('omniterm_mobile_gesture_enabled') !== 'false',
  mobileHapticEnabled: localStorage.getItem('omniterm_mobile_haptic_enabled') !== 'false',
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
  expandThinking: localStorage.getItem('omniterm_expand_thinking') === 'true',
  expandToolCalls: localStorage.getItem('omniterm_expand_tool_calls') === 'true',
  expandAllSessions: localStorage.getItem('omniterm_expand_all_sessions') === 'true',
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

  setBlurDisconnectMin: (n) => {
    const clamped = clampDisconnectMin(n)
    localStorage.setItem('omniterm_blur_disconnect_min', String(clamped))
    set({ blurDisconnectMin: clamped })
  },

  setIdleDisconnectMin: (n) => {
    const clamped = clampDisconnectMin(n)
    localStorage.setItem('omniterm_idle_disconnect_min', String(clamped))
    set({ idleDisconnectMin: clamped })
  },

  // In-memory only — no localStorage write.
  setAcpIdleRecycleMin: (n) => {
    set({ acpIdleRecycleMin: clampDisconnectMin(n) })
  },

  setExpandThinking: (v) => {
    localStorage.setItem('omniterm_expand_thinking', String(v))
    set({ expandThinking: v })
  },

  setExpandToolCalls: (v) => {
    localStorage.setItem('omniterm_expand_tool_calls', String(v))
    set({ expandToolCalls: v })
  },

  setExpandAllSessions: (v) => {
    localStorage.setItem('omniterm_expand_all_sessions', String(v))
    set({ expandAllSessions: v })
  },

  setTerminalSendData: (fn) => set({ terminalSendData: fn }),

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
   *
   * Resolves the session's owning project/worktree from `workspace_path` and
   * activates them together, so the sidebar worktree highlight follows the
   * focused session. Worktree resolution spans all projects — a session may
   * be registered under one project while its `workspace_path` maps to a
   * worktree of another (it renders as an orphan under the registered
   * project's main worktree, but the focused worktree should be the one its
   * path actually belongs to). When the owner can't be resolved (genuine
   * orphan / adopted external session with no matching worktree anywhere,
   * or sessions aren't loaded yet) the active project/workspace are left
   * untouched; session memory falls back to the currently active workspace
   * (legacy contract).
   */
  activateSession: (sessionId) => {
    const { sessions, worktrees, activeWorkspaceId, workspaceSessionMemory } = get()
    localStorage.setItem('omniterm_active_session', sessionId)

    // Resolve the owning project + worktree from loaded session data. The
    // worktree lookup spans ALL projects (not just the session's registered
    // project) because a session can carry a `workspace_path` that belongs to
    // another project's worktree — such sessions render as orphans under the
    // registered project's main worktree, but focusing them should highlight
    // the worktree their path actually maps to.
    let ownerProjectId: string | null = null
    let ownerWorkspaceId: string | null = null
    for (const [pid, sessList] of Object.entries(sessions)) {
      const s = sessList.find((x) => x.id === sessionId)
      if (s) {
        ownerProjectId = pid
        for (const [wpid, wtList] of Object.entries(worktrees)) {
          const wt = (wtList || []).find((w) => w.path === s.workspace_path)
          if (wt) {
            ownerProjectId = wpid
            ownerWorkspaceId = wt.id
            break
          }
        }
        break
      }
    }

    // Memory keyed to the resolved worktree (or legacy: current active one).
    const memoryTarget = ownerWorkspaceId ?? activeWorkspaceId
    const newMemory = memoryTarget
      ? { ...workspaceSessionMemory, [memoryTarget]: sessionId }
      : workspaceSessionMemory
    if (memoryTarget) {
      localStorage.setItem('omniterm_ws_session_memory', JSON.stringify(newMemory))
    }
    if (ownerProjectId) localStorage.setItem('omniterm_active_project', ownerProjectId)
    if (ownerWorkspaceId) localStorage.setItem('omniterm_active_workspace', ownerWorkspaceId)

    set({
      activeExternalSession: null,
      activeSessionId: sessionId,
      activeProjectId: ownerProjectId ?? get().activeProjectId,
      activeWorkspaceId: ownerWorkspaceId ?? get().activeWorkspaceId,
      workspaceSessionMemory: newMemory,
    })
  },
  setConnected: (v) => set({ connected: v }),
  setAuthState: (state) =>
    set((s) => ({ authState: state, authVersion: s.authVersion + 1 })),
  setAuthEnabled: (v) => set({ authEnabled: v }),
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
  setMobileHapticEnabled: (v) => {
    localStorage.setItem('omniterm_mobile_haptic_enabled', String(v))
    set({ mobileHapticEnabled: v })
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

  revealFileInDrawer: (sessionId, reportedPath) => {
    const s = get()
    const session = Object.values(s.sessions)
      .flat()
      .find((x) => x.id === sessionId)
    const abs = toAbsolutePath(reportedPath, session?.workspace_path)
    // 空路径无可打开之物；不要把 drawer 置为 '' 造一个必失败的抽屉
    if (!abs) return

    localStorage.setItem('omniterm_right_panel_tab', 'files')
    if (s.isMobile) localStorage.setItem('omniterm_mobile_last_tab', 'files')

    set({
      fileManagerOpen: true,
      fileManagerCollapsed: false,
      rightPanelTab: 'files',
      // 桌面端 activeTab 不参与布局，不动它（避免污染移动端记忆）
      ...(s.isMobile ? { activeTab: 'files' as const, mobileLastTab: 'files' } : {}),
      fmSessionStates: {
        ...s.fmSessionStates,
        [sessionId]: {
          // 这可能是本会话的首个 FM entry（用户从未打开过面板），
          // 必须铺齐默认值，不能只展开 undefined 留下缺字段的半成品 entry。
          ...DEFAULT_FM_SESSION_STATE,
          ...s.fmSessionStates[sessionId],
          drawerPath: abs,
          drawerMode: 'view' as const,
        },
      },
    })
  },

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
