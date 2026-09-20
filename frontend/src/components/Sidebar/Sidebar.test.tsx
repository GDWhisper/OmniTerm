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
    multiplexerStatus: vi.fn().mockResolvedValue({ available: true }),
    listDuplicates: vi.fn().mockResolvedValue([]),
    listArchivedSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    createWorktree: vi.fn(),
    listBranches: vi.fn(),
    initGit: vi.fn(),
    listDirs: vi.fn().mockResolvedValue({ files: [] }),
    pathExists: vi.fn().mockResolvedValue({ exists: true }),
    archiveSession: vi.fn().mockResolvedValue({ ok: true }),
    releaseSession: vi.fn().mockResolvedValue({ ok: true }),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    versionCheck: vi.fn().mockResolvedValue({ current: '0.1.9', latest: '0.1.9', update_available: false, channel: 'github_release' }),
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

// Test data
const fakeProject = {
  id: 'proj-1',
  name: 'Test Project',
  path: '/home/user/test-project',
  created_at: '2026-01-01T00:00:00Z',
  path_valid: true,
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

    // Wait for modal to appear (Modal portals to document.body)
    await vi.waitFor(() => {
      const modal = document.body.querySelector('.fixed.inset-0')
      expect(modal).toBeTruthy()
    })

    // Find the session name input and type a name (modal lives in body via portal)
    const input = document.body.querySelector('input[type="text"]') as HTMLInputElement
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
    const buttons = document.body.querySelectorAll('button')
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
        'my-test-session',
        undefined,
        // 未点选引擎 → 按设置的默认引擎（tmux）创建，见 utils/terminalEngine
        'tmux',
        undefined,
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

    // Wait for modal (Modal portals to document.body)
    await vi.waitFor(() => {
      const modal = document.body.querySelector('.fixed.inset-0')
      expect(modal).toBeTruthy()
    })

    // Click submit without entering a name (modal lives in body via portal)
    const buttons = document.body.querySelectorAll('button')
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
        undefined,
        undefined,
        // 同上：默认引擎 tmux
        'tmux',
        undefined,
      )
    })

    // Verify session was activated
    await vi.waitFor(() => {
      expect(useAppStore.getState().activeSessionId).toBe(fakeNewSession.id)
    })
  })

  it('非 git 仓库项目点击创建 worktree 的 + 时弹出初始化确认框，确认后调用 initGit', async () => {
    i18n.changeLanguage('en')
    // listBranches rejects with a mocked ApiError carrying code=not_a_git_repo.
    // The vi.mock factory's ApiError has signature (message, status, body),
    // which differs from the real class — cast to the mock signature.
    const MockApiError = ((await import('../../api/client')).ApiError as unknown as new (
      message: string,
      status: number,
      body?: unknown
    ) => Error)
    const notGitError = new MockApiError('project is not a git repository', 400, {
      code: 'not_a_git_repo',
      has_gitignore: false,
    })
    vi.mocked(api.listBranches).mockRejectedValue(notGitError)

    root.render(
      <I18nextProvider i18n={i18n}>
        <Sidebar />
      </I18nextProvider>
    )

    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeProject.name)
    })

    // Click the project's "+" (create worktree) button. The project is
    // collapsed by default, so clicking the header expands it first.
    const projectHeader = container.querySelector('.sidebar-project-header') as HTMLElement
    projectHeader!.click()
    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeWorkspace.label)
    })

    // The header "+" button has title="Create Worktree"
    const wtAddButton = (Array.from(container.querySelectorAll('button')).find(btn =>
      btn.getAttribute('title') === 'Create Worktree' || btn.getAttribute('title') === '创建 Worktree'
    ) || (Array.from(container.querySelectorAll('button')).find(btn =>
      btn.querySelector('svg') !== null && btn.getAttribute('title')?.includes('Worktree')
    ))) as HTMLElement
    expect(wtAddButton).toBeTruthy()
    wtAddButton!.click()

    // Confirm dialog should appear (portaled to body) with the git-init copy
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Initialize Git Repository?')
    })

    // No .gitignore → the warning about committing all existing files shows
    expect(document.body.textContent).toContain('no .gitignore detected')

    // Click the confirm button (confirmText = 'Initialize & Continue')
    const confirmBtn = (Array.from(document.body.querySelectorAll('button')).find(btn =>
      btn.textContent?.includes('Initialize & Continue')
    )) as HTMLElement
    expect(confirmBtn).toBeTruthy()
    confirmBtn!.click()

    await vi.waitFor(() => {
      expect(vi.mocked(api.initGit)).toHaveBeenCalledWith(fakeProject.id)
    })
  })

  it('项目目录已有 .gitignore 时确认框不显示提交警告', async () => {
    i18n.changeLanguage('en')
    const MockApiError = ((await import('../../api/client')).ApiError as unknown as new (
      message: string,
      status: number,
      body?: unknown
    ) => Error)
    const notGitError = new MockApiError('project is not a git repository', 400, {
      code: 'not_a_git_repo',
      has_gitignore: true,
    })
    vi.mocked(api.listBranches).mockRejectedValue(notGitError)

    root.render(
      <I18nextProvider i18n={i18n}>
        <Sidebar />
      </I18nextProvider>
    )

    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeProject.name)
    })
    const projectHeader = container.querySelector('.sidebar-project-header') as HTMLElement
    projectHeader!.click()
    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeWorkspace.label)
    })
    const wtAddButton = (Array.from(container.querySelectorAll('button')).find(btn =>
      btn.getAttribute('title') === 'Create Worktree' || btn.getAttribute('title') === '创建 Worktree'
    )) as HTMLElement
    wtAddButton!.click()

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Initialize Git Repository?')
    })
    expect(document.body.textContent).not.toContain('no .gitignore detected')
  })

  it('连接状态 badge 文本不换行（防 CJK 竖排堆叠）', async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <Sidebar />
      </I18nextProvider>
    )
    await vi.waitFor(() => {
      // 选择器必须锚定底部 status bar——T10 后 CountBadge 也带 status-badge-3d 类，
      // 裸 querySelector('.status-badge-3d') 会命中DOM更靠前的计数 badge
      expect(container.querySelector('.absolute.bottom-0 .status-badge-3d')).toBeTruthy()
    })
    const badge = container.querySelector('.absolute.bottom-0 .status-badge-3d') as HTMLElement
    expect(badge.style.flexShrink).toBe('0')
    const label = badge.querySelector('.font-pixel') as HTMLElement
    expect(label.style.whiteSpace).toBe('nowrap')
  })

  it('项目路径失效时显示修复按钮，点击打开 RepairPathDialog', async () => {
    // changeLanguage 是异步的：不 await 首帧仍可能按旧语言渲染，全套并发下
    // waitFor(项目名，数据不依赖语言) 先成功，而翻译 title 尚未上屏，查询即落空
    await i18n.changeLanguage('en')
    const { api } = await import('../../api/client')
    const broken = { ...fakeProject, path_valid: false }
    vi.mocked(api.listProjects).mockResolvedValue([broken])

    root.render(
      <I18nextProvider i18n={i18n}>
        <Sidebar />
      </I18nextProvider>
    )

    // Wait for the broken project to render
    await vi.waitFor(() => {
      expect(container.textContent).toContain(broken.name)
    })

    // Repair button (⚠) is shown only for invalid paths. waitFor 不能只等项目名：
    // beforeEach 预置的 store 项目与 broken 同名，首帧即命中而 listProjects 尚未
    // 返回，修复按钮那时还没渲染（全套并发下稳定复现）。直接等按钮本身。
    const repairBtn = await vi.waitFor(() => {
      const btn = container.querySelector('button[title*="Project path missing"]')
      expect(btn).toBeTruthy()
      return btn as HTMLElement
    })
    repairBtn.click()

    // RepairPathDialog opens (portaled to document.body) with the repair title
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Project Path Not Found')
    })
    // Original (invalid) path is surfaced in the dialog
    expect(document.body.textContent).toContain(broken.path)
  })
})

describe('Sidebar 批量操作', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const acpSession = {
    id: 'acp-1',
    project_id: 'proj-1',
    workspace_path: '/home/user/test-project',
    tmux_session_name: 'omni-acp-1',
    name: 'acp-session',
    runtime_kind: 'acp' as const,
    acp_process_alive: true,
    hook_enabled: false,
    created_at: '2026-01-02T00:00:00Z',
  }
  const termSession = {
    id: 'term-1',
    project_id: 'proj-1',
    workspace_path: '/home/user/test-project',
    tmux_session_name: 'omni-term-1',
    name: 'term-session',
    runtime_kind: 'tmux' as const,
    hook_enabled: false,
    created_at: '2026-01-01T00:00:00Z',
  }

  beforeEach(async () => {
    localStorage.clear()
    vi.clearAllMocks()

    const { api } = await import('../../api/client')
    vi.mocked(api.listProjects).mockResolvedValue([fakeProject])
    vi.mocked(api.listWorktrees).mockResolvedValue([fakeWorkspace])
    vi.mocked(api.listSessions).mockResolvedValue([acpSession, termSession])
    vi.mocked(api.listArchivedSessions).mockResolvedValue([])
    vi.mocked(api.archiveSession).mockResolvedValue({ ok: true })
    vi.mocked(api.releaseSession).mockResolvedValue({ ok: true })
    vi.mocked(api.deleteSession).mockResolvedValue(undefined)

    // expandAllSessions=true：含会话的项目自动展开，会话行无需手动点击
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
      expandAllSessions: true,
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

  async function renderSidebar() {
    i18n.changeLanguage('en')
    root.render(
      <I18nextProvider i18n={i18n}>
        <Sidebar />
      </I18nextProvider>
    )
    await vi.waitFor(() => {
      expect(container.querySelectorAll('.sidebar-session-item').length).toBe(2)
    })
  }

  function sessionRow(name: string): HTMLElement {
    const nameEl = [...container.querySelectorAll('.session-name')].find((n) => n.textContent === name)
    expect(nameEl, `会话行未渲染: ${name}`).toBeTruthy()
    return nameEl!.closest('.sidebar-session-item') as HTMLElement
  }

  async function openContextMenu(name: string) {
    sessionRow(name).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }),
    )
    await vi.waitFor(() => {
      expect(document.body.querySelector('.context-menu-item')).toBeTruthy()
    })
  }

  async function clickMenuItem(label: string) {
    let btn: Element | undefined
    await vi.waitFor(() => {
      btn = [...document.body.querySelectorAll('.context-menu-item')].find(
        (b) => b.textContent === label,
      )
      expect(btn, `菜单项未渲染: ${label}`).toBeTruthy()
    })
    ;(btn as HTMLElement).click()
  }

  function batchButton(label: string): HTMLButtonElement {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
    expect(btn, `批量按钮未渲染: ${label}`).toBeTruthy()
    return btn as HTMLButtonElement
  }

  it('右键 → 批量操作 → 混选归档：弹窗提示跳过终端，仅对 ACP 调 API', async () => {
    await renderSidebar()

    // 右键 ACP 会话行 → 菜单
    await openContextMenu('acp-session')
    await clickMenuItem('Batch Actions')
    await vi.waitFor(() => {
      expect(container.textContent).toContain('1 selected')
    })

    // 选择模式下点击终端行 = 切换选中（不激活会话）
    sessionRow('term-session').click()
    await vi.waitFor(() => {
      expect(container.textContent).toContain('2 selected')
    })

    const archiveBtn = batchButton('Archive')
    expect(archiveBtn.disabled).toBe(false)
    archiveBtn.click()

    // 混合选择：弹窗另起一行提示终端会话将被跳过
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('1 terminal session(s) do not support this action')
    })

    const modal = document.body.querySelector('.corner-nails') as HTMLElement
    expect(modal).toBeTruthy()
    const confirmBtn = [...modal.querySelectorAll('button')].find(
      (b) => b.textContent === 'Archive',
    ) as HTMLButtonElement
    expect(confirmBtn).toBeTruthy()
    confirmBtn.click()

    await vi.waitFor(() => {
      expect(api.archiveSession).toHaveBeenCalledWith('acp-1')
    })
    expect(api.archiveSession).toHaveBeenCalledTimes(1)
    expect(api.deleteSession).not.toHaveBeenCalled()

    // 执行完成自动退出选择模式（操作栏让位回连接状态栏）
    await vi.waitFor(() => {
      expect(container.textContent).not.toContain('2 selected')
    })
  })

  it('全终端选择时归档/释放按钮禁用，删除可用', async () => {
    await renderSidebar()

    await openContextMenu('term-session')
    await clickMenuItem('Batch Actions')
    await vi.waitFor(() => {
      expect(container.textContent).toContain('1 selected')
    })

    expect(batchButton('Archive').disabled).toBe(true)
    expect(batchButton('Release').disabled).toBe(true)
    expect(batchButton('Delete').disabled).toBe(false)
  })
})
