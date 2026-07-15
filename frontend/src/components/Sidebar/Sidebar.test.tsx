import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { Sidebar } from './Sidebar'
import { useAppStore } from '../../stores/appStore'

// Mock api/client
vi.mock('../../api/client', () => ({
  api: {
    listProjects: vi.fn().mockResolvedValue([]),
    listWorktrees: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
    listExternalSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    health: vi.fn().mockResolvedValue({ status: 'ok' }),
    systemInfo: vi.fn().mockResolvedValue({ home_dir: '/home/user' }),
    listDuplicates: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    listDirs: vi.fn().mockResolvedValue({ files: [] }),
    pathExists: vi.fn().mockResolvedValue({ exists: true }),
  },
  ApiError: class ApiError extends Error {
    status: number
    body: unknown
    constructor(message: string, status: number, body?: unknown) {
      super(message)
      this.status = status
      this.body = body
    }
  },
}))

// Import mocked api for assertions
import { api } from '../../api/client'

// Mock useAttention
vi.mock('../../hooks/useAttention', () => ({
  useAttention: () => ({
    fire: vi.fn(),
    clearAlert: vi.fn(),
    setActive: vi.fn(),
    reasonFor: vi.fn(),
  }),
}))

// Mock pixelAnimations
vi.mock('../../utils/pixelAnimations', () => ({
  triggerBump: vi.fn(),
}))

// Test data
const fakeProject = {
  id: 'proj-1',
  name: 'Test Project',
  path: '/home/user/test-project',
  created_at: '2026-01-01T00:00:00Z',
}

const fakeWorkspace = {
  id: 'ws-1',
  project_id: 'proj-1',
  label: 'main',
  path: '/home/user/test-project',
  is_main: true,
  git_branch: 'main',
  is_git_repo: true,
  is_git_worktree: false,
  created_at: '2026-01-01T00:00:00Z',
}

const fakeNewSession = {
  id: 'new-sess-1',
  project_id: 'proj-1',
  workspace_path: '/home/user/test-project',
  tmux_session_name: 'test-session',
  name: 'test-session',
  is_active: true,
  hook_enabled: false,
  created_at: '2026-01-01T00:00:00Z',
  runtime_kind: 'tmux' as const,
}

describe('Sidebar handleCreateSession', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    localStorage.clear()
    vi.clearAllMocks()

    // Setup api mocks
    const { api } = await import('../../api/client')
    vi.mocked(api.listProjects).mockResolvedValue([fakeProject])
    vi.mocked(api.listWorktrees).mockResolvedValue([fakeWorkspace])
    vi.mocked(api.listSessions).mockResolvedValue([])
    vi.mocked(api.createSession).mockResolvedValue(fakeNewSession)

    // Setup store with active project and workspace
    useAppStore.setState({
      projects: [fakeProject],
      worktrees: { [fakeProject.id]: [fakeWorkspace] },
      sessions: {},
      activeProjectId: fakeProject.id,
      activeWorkspaceId: fakeWorkspace.id,
      activeSessionId: null,
      activeExternalSession: null,
      sidebarCollapsed: false,
      connected: true,
      workspaceSessionMemory: {},
      fmSessionStates: {},
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    document.body.removeChild(container)
    localStorage.clear()
  })

  it('creates session and activates it via activateSession', async () => {
    i18n.changeLanguage('en')

    root.render(
      <I18nextProvider i18n={i18n}>
        <Sidebar />
      </I18nextProvider>
    )

    // Wait for sidebar to render with project
    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeProject.name)
    })

    // Expand the project to show worktrees
    const projectHeader = container.querySelector('.sidebar-project-header') as HTMLElement
    expect(projectHeader).toBeTruthy()
    projectHeader!.click()

    // Wait for worktree to appear
    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeWorkspace.label)
    })

    // Click the "+" button to open create session modal
    const addButton = container.querySelector('.sidebar-wt-add-btn') as HTMLElement
    expect(addButton).toBeTruthy()
    addButton!.click()

    // Wait for modal to appear (Modal uses fixed inset-0 backdrop)
    await vi.waitFor(() => {
      const modal = container.querySelector('.fixed.inset-0')
      expect(modal).toBeTruthy()
    })

    // Find the session name input and type a name
    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    expect(input).toBeTruthy()
    // Trigger change event
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set
    nativeInputValueSetter?.call(input, 'my-test-session')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))

    // Find and click the create/submit button (the primary button in modal)
    const buttons = container.querySelectorAll('button')
    const submitButton = (Array.from(buttons).find(btn =>
      btn.textContent?.toLowerCase().includes('create') ||
      btn.textContent?.toLowerCase().includes('提交') ||
      btn.classList.contains('primary')
    ) || buttons[buttons.length - 1]) as HTMLElement
    submitButton.click()

    // Wait for api.createSession to be called
    await vi.waitFor(() => {
      expect(vi.mocked(api.createSession)).toHaveBeenCalledWith(
        fakeProject.id,
        fakeWorkspace.path,
        'my-test-session'
      )
    })

    // Verify activateSession was called (activeSessionId should be set)
    await vi.waitFor(() => {
      const state = useAppStore.getState()
      expect(state.activeSessionId).toBe(fakeNewSession.id)
      expect(state.activeExternalSession).toBeNull()
    })
  })

  it('creates session with empty name when name is not provided', async () => {
    i18n.changeLanguage('en')

    root.render(
      <I18nextProvider i18n={i18n}>
        <Sidebar />
      </I18nextProvider>
    )

    // Wait for sidebar to render
    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeProject.name)
    })

    // Expand project
    const projectHeader = container.querySelector('.sidebar-project-header') as HTMLElement
    projectHeader!.click()

    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeWorkspace.label)
    })

    // Click "+" button
    const addButton = container.querySelector('.sidebar-wt-add-btn') as HTMLElement
    addButton!.click()

    // Wait for modal (Modal uses fixed inset-0 backdrop)
    await vi.waitFor(() => {
      const modal = container.querySelector('.fixed.inset-0')
      expect(modal).toBeTruthy()
    })

    // Click submit without entering a name
    const buttons = container.querySelectorAll('button')
    const submitButton = (Array.from(buttons).find(btn =>
      btn.textContent?.toLowerCase().includes('create') ||
      btn.textContent?.toLowerCase().includes('提交') ||
      btn.classList.contains('primary')
    ) || buttons[buttons.length - 1]) as HTMLElement
    submitButton.click()

    // Verify createSession was called with undefined name
    await vi.waitFor(() => {
      expect(vi.mocked(api.createSession)).toHaveBeenCalledWith(
        fakeProject.id,
        fakeWorkspace.path,
        undefined
      )
    })

    // Verify session was activated
    await vi.waitFor(() => {
      expect(useAppStore.getState().activeSessionId).toBe(fakeNewSession.id)
    })
  })
})
