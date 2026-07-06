import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
})
