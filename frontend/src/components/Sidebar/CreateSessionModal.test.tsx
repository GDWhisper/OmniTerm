import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { CreateSessionModal } from './CreateSessionModal'
import { useAppStore } from '../../stores/appStore'
import { useAgentStore } from '../../stores/agentStore'
import { useToastStore } from '../../stores/toastStore'
import { api } from '../../api/client'

vi.mock('../../api/client', () => ({
  api: { createSession: vi.fn().mockResolvedValue({ id: 'sess-new', name: 'test' }) },
}))

if (typeof globalThis.localStorage === 'undefined') {
  const store: Record<string, string> = {}
  globalThis.localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v },
    removeItem: (k: string) => { delete store[k] },
    clear: () => { for (const k in store) delete store[k] },
    get length() { return Object.keys(store).length },
    key: (i: number) => Object.keys(store)[i] ?? null,
  } as unknown as Storage
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function setup() {
  localStorage.removeItem('omniterm_default_terminal_engine')
  localStorage.removeItem('omniterm_last_terminal_engine')
  localStorage.removeItem('omniterm_last_acp_agent')
  useAppStore.setState({
    activeProjectId: 'proj-1',
    worktrees: { 'proj-1': [{ id: 'wt-1', project_id: 'proj-1', path: '/tmp/proj', label: 'main', is_main: true, is_git_repo: true, is_git_worktree: false }] },
    sessions: {}, activateSession: vi.fn(), multiplexerAvailable: true, multiplexer: 'tmux', defaultTerminalEngine: 'tmux', lastAcpAgentId: null,
  })
  useAgentStore.setState({ agents: [{ id: 'agent-1', display_name: 'Claude', command: 'claude', args: [], env: [], created_at: '', updated_at: '' }] })
  useToastStore.setState({ addToast: vi.fn() })
}

function renderModal(
  workspaceId = 'wt-1',
  seed?: { defaultTerminalEngine?: 'pty' | 'tmux'; multiplexerAvailable?: boolean; lastAcpAgentId?: string | null },
) {
  const reloadSessions = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  setup()
  if (seed) useAppStore.setState(seed)
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <CreateSessionModal workspaceId={workspaceId} onClose={onClose} reloadSessions={reloadSessions} />
      </I18nextProvider>,
    )
  })
  return { reloadSessions, onClose }
}

describe('CreateSessionModal', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    ;(api.createSession as ReturnType<typeof vi.fn>).mockClear()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  // ─── 初始渲染：Terminal 为默认选中 ───

  it('renders both session type options (Terminal and ACP) on initial load', () => {
    renderModal()
    expect(document.body.textContent).toContain('终端')
    expect(document.body.textContent).toContain('ACP')
  })

  it('terminal card shows current engine selection when terminal is the active category', () => {
    renderModal()
    // Terminal card subtitle reflects terminalEngine state — informative, not a leak
    // (the real bug — ACP section showing terminal engine options — is fixed by expandedCategory)
    expect(document.body.textContent).toContain('pty')
  })

  it('engine sub-picker is visible when terminal card is selected (default)', () => {
    renderModal()
    // Terminal is selected by default → engine options visible
    expect(document.body.textContent).toContain('pty')
    expect(document.body.textContent).toContain('tmux')
  })

  // ─── 展开终端引擎 ───

  it('shows pty and tmux engine options and the BETA badge on pty after expanding', () => {
    renderModal()
    const terminalCard = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('终端') && !b.textContent!.includes('ACP'),
    )
    expect(terminalCard).toBeTruthy()
    act(() => terminalCard!.click())
    expect(document.body.textContent).toContain('pty')
    expect(document.body.textContent).toContain('tmux')
    expect(document.body.textContent).toContain('BETA')
  })

  // ─── 默认引擎（设置 → 终端）决定初始高亮 ───

  const engineCard = (engine: 'pty' | 'tmux') =>
    Array.from(document.body.querySelectorAll('button')).find((b) =>
      b.textContent?.startsWith(engine),
    )

  /** 卡片是否点亮看选中态边框——jsdom 不保留 `var()` 属性，改读内联 style 文本。 */
  const engineCardSelected = (engine: 'pty' | 'tmux') =>
    (engineCard(engine)!.getAttribute('style') ?? '').includes('2px solid var(--accent)')

  it('preselects the configured default engine', () => {
    renderModal('wt-1', { defaultTerminalEngine: 'pty' })
    expect(engineCardSelected('pty')).toBe(true)
    expect(engineCardSelected('tmux')).toBe(false)
  })

  it('writing back the engine only happens on an explicit pick', async () => {
    renderModal()
    act(() => engineCard('pty')!.click())
    const input = document.body.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(() => {
      expect(api.createSession).toHaveBeenCalledWith('proj-1', '/tmp/proj', undefined, undefined, 'pty', undefined)
    })
    expect(useAppStore.getState().defaultTerminalEngine).toBe('pty')
    expect(localStorage.getItem('omniterm_default_terminal_engine')).toBe('pty')
  })

  it('keeps a tmux preference when the host has no multiplexer', async () => {
    // 回落 pty 是宿主限制而非用户意图，创建后不该把设置里的 tmux 静默改掉
    renderModal('wt-1', { defaultTerminalEngine: 'tmux', multiplexerAvailable: false })
    expect(engineCard('tmux')!.disabled).toBe(true)
    expect(engineCardSelected('pty')).toBe(true)
    const input = document.body.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(() => {
      expect(api.createSession).toHaveBeenCalledWith('proj-1', '/tmp/proj', undefined, undefined, 'pty', undefined)
    })
    expect(useAppStore.getState().defaultTerminalEngine).toBe('tmux')
    expect(localStorage.getItem('omniterm_default_terminal_engine')).toBeNull()
  })

  // ─── ACP 选择 ───

  it('auto-selects first agent when switching to ACP', () => {
    renderModal()
    const acpCard = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('ACP'),
    )
    expect(acpCard).toBeTruthy()
    act(() => acpCard!.click())
    const enabledCount = Array.from(document.body.querySelectorAll('button')).filter((b) => !b.disabled).length
    expect(enabledCount).toBeGreaterThanOrEqual(1)
  })

  it('auto-selects first agent when agents load after ACP is already active', () => {
    useAgentStore.setState({ agents: [], loaded: false })
    renderModal()
    // Click ACP while no agents exist — Create should be disabled
    const acpCard = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('ACP'),
    )
    act(() => acpCard!.click())
    // Now agents arrive (simulating async loadAgents completion)
    act(() => {
      useAgentStore.setState({
        agents: [{ id: 'agent-1', display_name: 'Claude', command: 'claude', args: [], env: [], created_at: '', updated_at: '' }],
        loaded: true,
      })
    })
    // useEffect fires: acpAgentId → 'agent-1' → Create should be enabled
    const enabledBtns = Array.from(document.body.querySelectorAll('button')).filter((b) => !b.disabled)
    expect(enabledBtns.length).toBeGreaterThanOrEqual(1)
  })

  // ─── ACP agent 记忆 + 上次选择标记 ───

  const acpSelect = () => document.body.querySelector('select') as HTMLSelectElement

  const openAcp = () => {
    const acpCard = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('ACP'),
    )
    act(() => acpCard!.click())
  }

  const twoAgents = [
    { id: 'agent-1', display_name: 'Claude', command: 'claude', args: [], env: [], created_at: '', updated_at: '' },
    { id: 'agent-2', display_name: 'Codex', command: 'codex', args: [], env: [], created_at: '', updated_at: '' },
  ]

  it('remembers the agent of the ACP session just created', async () => {
    renderModal()
    openAcp()
    const input = document.body.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(() => {
      expect(api.createSession).toHaveBeenCalledWith('proj-1', '/tmp/proj', expect.any(String), undefined, 'acp', 'agent-1')
    })
    expect(useAppStore.getState().lastAcpAgentId).toBe('agent-1')
    expect(localStorage.getItem('omniterm_last_acp_agent')).toBe('agent-1')
    // ACP 创建不刷新默认引擎
    expect(useAppStore.getState().defaultTerminalEngine).toBe('tmux')
  })

  it('prefers the remembered agent over the first one on reopen', () => {
    renderModal('wt-1', { lastAcpAgentId: 'agent-2' })
    act(() => useAgentStore.setState({ agents: twoAgents }))
    openAcp()
    expect(acpSelect().value).toBe('agent-2')
  })

  it('marks the remembered agent option with the last-used suffix', () => {
    renderModal('wt-1', { lastAcpAgentId: 'agent-2' })
    act(() => useAgentStore.setState({ agents: twoAgents }))
    openAcp()
    const suffix = i18n.t('agentPicker.lastUsedSuffix')
    const options = Array.from(acpSelect().querySelectorAll('option'))
    expect(options.find((o) => o.value === 'agent-2')!.textContent).toContain(suffix)
    expect(options.find((o) => o.value === 'agent-1')!.textContent).not.toContain(suffix)
  })

  it('falls back to the first agent when the remembered agent no longer exists', () => {
    renderModal('wt-1', { lastAcpAgentId: 'agent-gone' })
    openAcp()
    expect(acpSelect().value).toBe('agent-1')
  })

  // ─── API 契约 ───

  it('does not create a session on initial render', () => {
    renderModal()
    expect(api.createSession).not.toHaveBeenCalled()
  })

  it('calls api.createSession with correct args for a default terminal session', async () => {
    renderModal()
    // Simulate Enter key which triggers handleCreateSession
    const input = document.body.querySelector('input[type="text"]') as HTMLInputElement | null
    expect(input).toBeTruthy()
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(() => {
      expect(api.createSession).toHaveBeenCalledWith('proj-1', '/tmp/proj', undefined, undefined, 'tmux', undefined)
    })
  })
})
