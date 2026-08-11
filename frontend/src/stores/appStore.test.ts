import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAppStore } from './appStore'

describe('appStore mobile state', () => {
  beforeEach(() => {
    useAppStore.setState({
      isMobile: false,
      activeTab: 'terminal',
      mobileGestureEnabled: true,
      mobileFontSize: 13,
      mobileLastTab: 'terminal',
    })
  })

  it('defaults mobile font size to 13', () => {
    expect(useAppStore.getState().mobileFontSize).toBe(13)
  })

  it('toggles mobile gesture enabled', () => {
    useAppStore.getState().setMobileGestureEnabled(false)
    expect(useAppStore.getState().mobileGestureEnabled).toBe(false)
  })

  it('clamps mobile font size between 12 and 20', () => {
    useAppStore.getState().setMobileFontSize(8)
    expect(useAppStore.getState().mobileFontSize).toBe(12)
    useAppStore.getState().setMobileFontSize(25)
    expect(useAppStore.getState().mobileFontSize).toBe(20)
  })
})

describe('appStore.activateSession', () => {
  // Each test starts with a clean state so memory writes from earlier
  // cases don't leak into later assertions.
  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState({
      activeSessionId: null,
      activeExternalSession: null,
      activeWorkspaceId: null,
      workspaceSessionMemory: {},
    })
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('sets activeSessionId and clears activeExternalSession', () => {
    useAppStore.setState({ activeExternalSession: 'ext-1' })
    useAppStore.getState().activateSession('sess-1')
    const s = useAppStore.getState()
    expect(s.activeSessionId).toBe('sess-1')
    expect(s.activeExternalSession).toBeNull()
  })

  it('persists activeSessionId to localStorage', () => {
    useAppStore.getState().activateSession('sess-1')
    expect(localStorage.getItem('omniterm_active_session')).toBe('sess-1')
  })

  it('updates workspaceSessionMemory when activeWorkspaceId is set', () => {
    useAppStore.setState({ activeWorkspaceId: 'ws-1' })
    useAppStore.getState().activateSession('sess-1')
    expect(useAppStore.getState().workspaceSessionMemory['ws-1']).toBe('sess-1')
  })

  it('persists updated workspaceSessionMemory to localStorage', () => {
    useAppStore.setState({ activeWorkspaceId: 'ws-1' })
    useAppStore.getState().activateSession('sess-1')
    const stored = JSON.parse(localStorage.getItem('omniterm_ws_session_memory') || '{}')
    expect(stored['ws-1']).toBe('sess-1')
  })

  it('does not touch workspaceSessionMemory when no activeWorkspaceId', () => {
    const before = { 'ws-existing': 'sess-x' }
    useAppStore.setState({ workspaceSessionMemory: before })
    useAppStore.getState().activateSession('sess-1')
    // Reference equality — the object shouldn't be rebuilt when there's
    // nothing to update.
    expect(useAppStore.getState().workspaceSessionMemory).toBe(before)
    expect(localStorage.getItem('omniterm_ws_session_memory')).toBeNull()
  })

  it('overwrites previous memory for the same workspace on repeat activation', () => {
    useAppStore.setState({ activeWorkspaceId: 'ws-1' })
    useAppStore.getState().activateSession('sess-1')
    useAppStore.getState().activateSession('sess-2')
    expect(useAppStore.getState().workspaceSessionMemory['ws-1']).toBe('sess-2')
  })

  it('preserves memory entries for other workspaces', () => {
    useAppStore.setState({
      activeWorkspaceId: 'ws-2',
      workspaceSessionMemory: { 'ws-1': 'sess-old' },
    })
    useAppStore.getState().activateSession('sess-2')
    const mem = useAppStore.getState().workspaceSessionMemory
    expect(mem['ws-1']).toBe('sess-old')
    expect(mem['ws-2']).toBe('sess-2')
  })

  it('activates the owning project + worktree of a loaded session', () => {
    useAppStore.setState({
      activeProjectId: 'proj-other',
      activeWorkspaceId: 'wt-other',
      sessions: {
        'project-1': [
          { id: 'sess-1', workspace_path: '/repo/wt-1' },
        ] as never,
      },
      worktrees: {
        'project-1': [
          { id: 'wt-1', path: '/repo/wt-1' },
          { id: 'wt-2', path: '/repo/wt-2' },
        ] as never,
      },
    })
    useAppStore.getState().activateSession('sess-1')
    const s = useAppStore.getState()
    expect(s.activeProjectId).toBe('project-1')
    expect(s.activeWorkspaceId).toBe('wt-1')
    // Memory keys to the resolved worktree, not the stale current one.
    expect(s.workspaceSessionMemory['wt-1']).toBe('sess-1')
    expect(s.workspaceSessionMemory['wt-other']).toBeUndefined()
    expect(localStorage.getItem('omniterm_active_project')).toBe('project-1')
    expect(localStorage.getItem('omniterm_active_workspace')).toBe('wt-1')
  })

  it('keeps current workspace when session owner cannot be resolved', () => {
    useAppStore.setState({
      activeProjectId: 'proj-x',
      activeWorkspaceId: 'wt-x',
      sessions: {}, // owning project's sessions not loaded
    })
    useAppStore.getState().activateSession('sess-ghost')
    const s = useAppStore.getState()
    expect(s.activeSessionId).toBe('sess-ghost')
    expect(s.activeProjectId).toBe('proj-x')
    expect(s.activeWorkspaceId).toBe('wt-x')
  })

  it('activates the worktree in ANOTHER project when the session path maps there', () => {
    // Session is registered under proj-A but its workspace_path belongs to
    // proj-B's worktree (cross-project orphan session). Focusing it should
    // highlight proj-B's worktree, not leave the old workspace highlighted.
    useAppStore.setState({
      activeProjectId: 'proj-A',
      activeWorkspaceId: 'wt-A-main',
      sessions: {
        'proj-A': [
          { id: 'sess-cross', workspace_path: '/repo/proj-B' },
        ] as never,
      },
      worktrees: {
        'proj-A': [{ id: 'wt-A-main', path: '/repo/proj-A' }] as never,
        'proj-B': [{ id: 'wt-B-1', path: '/repo/proj-B' }] as never,
      },
    })
    useAppStore.getState().activateSession('sess-cross')
    const s = useAppStore.getState()
    expect(s.activeProjectId).toBe('proj-B')
    expect(s.activeWorkspaceId).toBe('wt-B-1')
    expect(s.workspaceSessionMemory['wt-B-1']).toBe('sess-cross')
    expect(s.workspaceSessionMemory['wt-A-main']).toBeUndefined()
    expect(localStorage.getItem('omniterm_active_project')).toBe('proj-B')
    expect(localStorage.getItem('omniterm_active_workspace')).toBe('wt-B-1')
  })
})

describe('appStore disconnect timeout settings', () => {
  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState({
      blurDisconnectMin: 10,
      idleDisconnectMin: 15,
      acpIdleRecycleMin: 5,
    })
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('clamps blurDisconnectMin to 1..60 and persists to omniterm_blur_disconnect_min', () => {
    const s = useAppStore.getState()
    s.setBlurDisconnectMin(0)
    expect(useAppStore.getState().blurDisconnectMin).toBe(1)
    expect(localStorage.getItem('omniterm_blur_disconnect_min')).toBe('1')
    s.setBlurDisconnectMin(61)
    expect(useAppStore.getState().blurDisconnectMin).toBe(60)
    expect(localStorage.getItem('omniterm_blur_disconnect_min')).toBe('60')
    s.setBlurDisconnectMin(30)
    expect(useAppStore.getState().blurDisconnectMin).toBe(30)
    expect(localStorage.getItem('omniterm_blur_disconnect_min')).toBe('30')
  })

  it('clamps idleDisconnectMin to 1..60 and persists to omniterm_idle_disconnect_min', () => {
    const s = useAppStore.getState()
    s.setIdleDisconnectMin(0)
    expect(useAppStore.getState().idleDisconnectMin).toBe(1)
    expect(localStorage.getItem('omniterm_idle_disconnect_min')).toBe('1')
    s.setIdleDisconnectMin(61)
    expect(useAppStore.getState().idleDisconnectMin).toBe(60)
    expect(localStorage.getItem('omniterm_idle_disconnect_min')).toBe('60')
    s.setIdleDisconnectMin(30)
    expect(useAppStore.getState().idleDisconnectMin).toBe(30)
    expect(localStorage.getItem('omniterm_idle_disconnect_min')).toBe('30')
  })

  it('clamps acpIdleRecycleMin to 1..60 without writing localStorage', () => {
    const s = useAppStore.getState()
    s.setAcpIdleRecycleMin(0)
    expect(useAppStore.getState().acpIdleRecycleMin).toBe(1)
    s.setAcpIdleRecycleMin(61)
    expect(useAppStore.getState().acpIdleRecycleMin).toBe(60)
    // acp setter is in-memory only — must not touch any localStorage key.
    expect(localStorage.length).toBe(0)
  })
})

describe('appStore disconnect timeout initial values', () => {
  it('defaults blur/idle/acp to 10/15/5 when localStorage has no values', async () => {
    localStorage.clear()
    vi.resetModules()
    const { useAppStore: freshStore } = await import('./appStore')
    const s = freshStore.getState()
    expect(s.blurDisconnectMin).toBe(10)
    expect(s.idleDisconnectMin).toBe(15)
    expect(s.acpIdleRecycleMin).toBe(5)
  })

  it('self-heals NaN persisted values to defaults', async () => {
    localStorage.setItem('omniterm_blur_disconnect_min', 'NaN')
    localStorage.setItem('omniterm_idle_disconnect_min', 'NaN')
    vi.resetModules()
    const { useAppStore: freshStore } = await import('./appStore')
    const s = freshStore.getState()
    expect(s.blurDisconnectMin).toBe(10)
    expect(s.idleDisconnectMin).toBe(15)
  })

  it('self-heals out-of-range persisted values to defaults', async () => {
    localStorage.setItem('omniterm_blur_disconnect_min', '0')
    localStorage.setItem('omniterm_idle_disconnect_min', '999')
    vi.resetModules()
    const { useAppStore: freshStore } = await import('./appStore')
    const s = freshStore.getState()
    expect(s.blurDisconnectMin).toBe(10)
    expect(s.idleDisconnectMin).toBe(15)
  })

  it('reads valid persisted values within range', async () => {
    localStorage.setItem('omniterm_blur_disconnect_min', '25')
    localStorage.setItem('omniterm_idle_disconnect_min', '40')
    vi.resetModules()
    const { useAppStore: freshStore } = await import('./appStore')
    const s = freshStore.getState()
    expect(s.blurDisconnectMin).toBe(25)
    expect(s.idleDisconnectMin).toBe(40)
  })
})

describe('appStore expandAllSessions', () => {

  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('defaults to false when localStorage has no record', async () => {
    vi.resetModules()
    const { useAppStore: freshStore } = await import('./appStore')
    expect(freshStore.getState().expandAllSessions).toBe(false)
  })

  it('initializes to true when localStorage holds a true record', async () => {
    localStorage.setItem('omniterm_expand_all_sessions', 'true')
    vi.resetModules()
    const { useAppStore: freshStore } = await import('./appStore')
    expect(freshStore.getState().expandAllSessions).toBe(true)
  })

  it('setExpandAllSessions updates state and persists to localStorage', () => {
    useAppStore.getState().setExpandAllSessions(true)
    expect(useAppStore.getState().expandAllSessions).toBe(true)
    expect(localStorage.getItem('omniterm_expand_all_sessions')).toBe('true')
    useAppStore.getState().setExpandAllSessions(false)
    expect(useAppStore.getState().expandAllSessions).toBe(false)
    expect(localStorage.getItem('omniterm_expand_all_sessions')).toBe('false')
  })
})

describe('appStore.revealFileInDrawer', () => {
  const SESSIONS = {
    'proj-1': [{ id: 'sess-1', workspace_path: '/repo/wt-1' }],
  } as never

  beforeEach(() => {
    localStorage.clear()
    useAppStore.setState({
      sessions: SESSIONS,
      fmSessionStates: {},
      isMobile: false,
      activeTab: 'terminal',
      mobileLastTab: 'terminal',
      fileManagerOpen: false,
      fileManagerCollapsed: true,
      rightPanelTab: 'git',
    })
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('resolves a relative path against the session workspace root', () => {
    useAppStore.getState().revealFileInDrawer('sess-1', 'docs/plan.md')
    expect(useAppStore.getState().fmSessionStates['sess-1'].drawerPath).toBe('/repo/wt-1/docs/plan.md')
  })

  it('keeps an absolute path as reported', () => {
    useAppStore.getState().revealFileInDrawer('sess-1', '/repo/wt-1/docs/plan.md')
    expect(useAppStore.getState().fmSessionStates['sess-1'].drawerPath).toBe('/repo/wt-1/docs/plan.md')
  })

  it('makes the drawer reachable: panel open, un-collapsed, on the files tab', () => {
    useAppStore.getState().revealFileInDrawer('sess-1', 'a.md')
    const s = useAppStore.getState()
    expect(s.fileManagerOpen).toBe(true)
    expect(s.fileManagerCollapsed).toBe(false)
    expect(s.rightPanelTab).toBe('files')
    expect(localStorage.getItem('omniterm_right_panel_tab')).toBe('files')
  })

  it('opens in view mode', () => {
    useAppStore.getState().revealFileInDrawer('sess-1', 'a.md')
    expect(useAppStore.getState().fmSessionStates['sess-1'].drawerMode).toBe('view')
  })

  it('fills in FM defaults when this is the session\'s first FM entry', () => {
    // 用户从未打开过面板时直接从聊天点文件：entry 不能缺 mode/manualPath，
    // 否则 FileManager 的 following/manual 分支拿到 undefined。
    expect(useAppStore.getState().fmSessionStates['sess-1']).toBeUndefined()
    useAppStore.getState().revealFileInDrawer('sess-1', 'a.md')
    const entry = useAppStore.getState().fmSessionStates['sess-1']
    expect(entry.mode).toBe('following')
    expect(entry.manualPath).toBeNull()
  })

  it('preserves an existing FM entry\'s browsing state', () => {
    useAppStore.setState({
      fmSessionStates: {
        'sess-1': { mode: 'manual', manualPath: '/repo/wt-1/src', drawerPath: null, drawerMode: 'view' },
      },
    })
    useAppStore.getState().revealFileInDrawer('sess-1', 'a.md')
    const entry = useAppStore.getState().fmSessionStates['sess-1']
    expect(entry.mode).toBe('manual')
    expect(entry.manualPath).toBe('/repo/wt-1/src')
    expect(entry.drawerPath).toBe('/repo/wt-1/a.md')
  })

  it('leaves other sessions\' FM state untouched', () => {
    useAppStore.setState({
      fmSessionStates: {
        'sess-other': { mode: 'manual', manualPath: '/x', drawerPath: '/x/y.md', drawerMode: 'edit' },
      },
    })
    useAppStore.getState().revealFileInDrawer('sess-1', 'a.md')
    expect(useAppStore.getState().fmSessionStates['sess-other'].drawerPath).toBe('/x/y.md')
  })

  it('switches to the files pane on mobile only', () => {
    useAppStore.setState({ isMobile: true })
    useAppStore.getState().revealFileInDrawer('sess-1', 'a.md')
    expect(useAppStore.getState().activeTab).toBe('files')
    expect(localStorage.getItem('omniterm_mobile_last_tab')).toBe('files')
  })

  it('does not touch activeTab on desktop', () => {
    useAppStore.getState().revealFileInDrawer('sess-1', 'a.md')
    expect(useAppStore.getState().activeTab).toBe('terminal')
    expect(localStorage.getItem('omniterm_mobile_last_tab')).toBeNull()
  })

  it('is a no-op for a blank path (never opens an empty drawer)', () => {
    useAppStore.getState().revealFileInDrawer('sess-1', '   ')
    expect(useAppStore.getState().fmSessionStates['sess-1']).toBeUndefined()
    expect(useAppStore.getState().fileManagerOpen).toBe(false)
  })

  it('still opens the reported path when the session is not loaded (no root)', () => {
    // 会话未在 store 中（尚未加载）——不造假基准，原样下去由后端判定
    useAppStore.getState().revealFileInDrawer('sess-ghost', 'docs/a.md')
    expect(useAppStore.getState().fmSessionStates['sess-ghost'].drawerPath).toBe('docs/a.md')
  })
})
