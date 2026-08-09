import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { Sidebar } from './Sidebar'
import { useAppStore } from '../../stores/appStore'

// Mock api/client — same surface as Sidebar.test.tsx so the full Sidebar
// (real ProjectCard, dialogs, polling hook) can render in isolation.
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
    createWorktree: vi.fn(),
    listBranches: vi.fn(),
    initGit: vi.fn(),
    listDirs: vi.fn().mockResolvedValue({ files: [] }),
    pathExists: vi.fn().mockResolvedValue({ exists: true }),
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

describe('Sidebar 会话展开模式（expandAllSessions）', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    localStorage.clear()
    vi.clearAllMocks()

    const { api } = await import('../../api/client')
    vi.mocked(api.listProjects).mockResolvedValue([fakeProject])
    vi.mocked(api.listWorktrees).mockResolvedValue([fakeWorkspace])
    vi.mocked(api.listSessions).mockResolvedValue([])

    useAppStore.setState({
      projects: [fakeProject],
      worktrees: { [fakeProject.id]: [fakeWorkspace] },
      sessions: { [fakeProject.id]: [fakeNewSession] },
      activeProjectId: null,
      activeWorkspaceId: null,
      activeSessionId: null,
      activeExternalSession: null,
      sidebarCollapsed: false,
      connected: true,
      workspaceSessionMemory: {},
      expandAllSessions: false,
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

  function renderSidebar(lang = 'en') {
    i18n.changeLanguage(lang)
    root.render(
      <I18nextProvider i18n={i18n}>
        <Sidebar />
      </I18nextProvider>
    )
  }

  it('模式 1 下含会话项目自动展开，显示 worktree 与内嵌会话', async () => {
    useAppStore.setState({ expandAllSessions: true })
    renderSidebar()

    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeProject.name)
    })
    // 无需点击 header 即展开 worktree 行
    await vi.waitFor(() => {
      expect(container.querySelector('.sidebar-wt-row')).toBeTruthy()
    })
    expect(container.textContent).toContain(fakeNewSession.tmux_session_name)
  })

  it('模式 1 下无会话项目不自动展开（header 保持折叠箭头）', async () => {
    useAppStore.setState({ expandAllSessions: true, sessions: { [fakeProject.id]: [] } })
    renderSidebar()

    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeProject.name)
    })
    expect(container.querySelector('.sidebar-wt-row')).toBeFalsy()
    const header = container.querySelector('.sidebar-project-header') as HTMLElement
    expect(header.textContent).toContain('▶')
  })

  it('模式 1 下手动折叠后保持折叠（不自动弹回），再次点击 header 重新展开', async () => {
    useAppStore.setState({ expandAllSessions: true })
    renderSidebar()

    await vi.waitFor(() => {
      expect(container.querySelector('.sidebar-wt-row')).toBeTruthy()
    })

    // 手动折叠
    const header = container.querySelector('.sidebar-project-header') as HTMLElement
    act(() => { header.click() })
    await vi.waitFor(() => {
      expect(container.querySelector('.sidebar-wt-row')).toBeFalsy()
    })

    // 折叠优先：给自动重渲染留出时间，确认不会自动弹回
    await new Promise((r) => setTimeout(r, 50))
    expect(container.querySelector('.sidebar-wt-row')).toBeFalsy()

    // 再次点击 header 重新展开
    const header2 = container.querySelector('.sidebar-project-header') as HTMLElement
    act(() => { header2.click() })
    await vi.waitFor(() => {
      expect(container.querySelector('.sidebar-wt-row')).toBeTruthy()
    })
  })

  it('标题栏 toggle：模式 2 显示 IconEye；点击切到模式 1 显示 ⤢ + accent 高亮 + tooltip 正确', async () => {
    renderSidebar()

    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeProject.name)
    })

    const toggleBtn = container.querySelector('button[title*="Session expansion"]') as HTMLElement
    expect(toggleBtn).toBeTruthy()
    // 模式 2：IconEye（svg）、无高亮、tooltip 为「仅聚焦」
    expect(toggleBtn.querySelector('svg')).toBeTruthy()
    expect(toggleBtn.textContent).not.toContain('⤢')
    expect(toggleBtn.getAttribute('title')).toBe(
      'Session expansion: focused worktree only (click to expand all)'
    )

    act(() => { toggleBtn.click() })
    await vi.waitFor(() => {
      expect(useAppStore.getState().expandAllSessions).toBe(true)
    })

    // 等 DOM 反映模式 1（按钮内容/高亮/tooltip 随重渲染更新）
    await vi.waitFor(() => {
      const btn = container.querySelector('button[title*="Session expansion"]') as HTMLElement
      expect(btn.textContent).toContain('⤢')
    })
    const toggleBtnOn = container.querySelector('button[title*="Session expansion"]') as HTMLElement
    expect(toggleBtnOn.textContent).toContain('⤢')
    expect(toggleBtnOn.querySelector('svg')).toBeFalsy()
    expect(toggleBtnOn.style.color).toBe('var(--accent)')
    expect(toggleBtnOn.getAttribute('title')).toBe(
      'Session expansion: all worktrees with sessions (click for focused only)'
    )
    // 持久化：localStorage 已写入
    expect(localStorage.getItem('omniterm_expand_all_sessions')).toBe('true')
  })

  it('模式 2（默认）回归：项目默认折叠，点击 header 后才展开 worktree', async () => {
    renderSidebar()

    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeProject.name)
    })
    // 即使项目有会话，默认也只手动展开
    expect(container.querySelector('.sidebar-wt-row')).toBeFalsy()

    const header = container.querySelector('.sidebar-project-header') as HTMLElement
    act(() => { header.click() })
    await vi.waitFor(() => {
      expect(container.querySelector('.sidebar-wt-row')).toBeTruthy()
    })
  })

  it('toggle 按钮 tooltip 中文文案正确（zh）', async () => {
    renderSidebar('zh')

    await vi.waitFor(() => {
      expect(container.textContent).toContain(fakeProject.name)
    })

    const toggleBtn = container.querySelector('button[title*="会话展开"]') as HTMLElement
    expect(toggleBtn).toBeTruthy()
    expect(toggleBtn.getAttribute('title')).toBe('会话展开：仅聚焦的 worktree（点击切换为全部展开）')

    act(() => { toggleBtn.click() })
    await vi.waitFor(() => {
      const btn = container.querySelector('button[title*="会话展开"]') as HTMLElement
      expect(btn.getAttribute('title')).toBe('会话展开：所有含会话的 worktree（点击切换为仅聚焦）')
    })
  })
})
