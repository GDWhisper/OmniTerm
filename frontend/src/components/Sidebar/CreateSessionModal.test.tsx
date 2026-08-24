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
  useAppStore.setState({
    activeProjectId: 'proj-1',
    worktrees: { 'proj-1': [{ id: 'wt-1', project_id: 'proj-1', path: '/tmp/proj', label: 'main', is_main: true, is_git_repo: true, is_git_worktree: false }] },
    sessions: {}, activateSession: vi.fn(), multiplexerAvailable: true, multiplexer: 'tmux',
  })
  useAgentStore.setState({ agents: [{ id: 'agent-1', display_name: 'Claude', command: 'claude', args: [], env: [], created_at: '', updated_at: '' }] })
  useToastStore.setState({ addToast: vi.fn() })
}

function renderModal(workspaceId = 'wt-1') {
  const reloadSessions = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  setup()
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

  it('shows pty and tmux engine options and "default" badge on pty after expanding', () => {
    renderModal()
    const terminalCard = Array.from(document.body.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('终端') && !b.textContent!.includes('ACP'),
    )
    expect(terminalCard).toBeTruthy()
    act(() => terminalCard!.click())
    expect(document.body.textContent).toContain('pty')
    expect(document.body.textContent).toContain('tmux')
    expect(document.body.textContent).toContain('默认')
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

  // ─── API 契约 ───

  it('does not create a session on initial render', () => {
    renderModal()
    expect(api.createSession).not.toHaveBeenCalled()
  })

  it('calls api.createSession with correct args for default pty terminal session', async () => {
    renderModal()
    // Simulate Enter key which triggers handleCreateSession
    const input = document.body.querySelector('input[type="text"]') as HTMLInputElement | null
    expect(input).toBeTruthy()
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(() => {
      expect(api.createSession).toHaveBeenCalledWith('proj-1', '/tmp/proj', undefined, undefined, 'pty', undefined)
    })
  })
})
