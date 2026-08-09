import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectCard } from './ProjectCard'
import type { Project, Session, Workspace } from '../../api/client'

// ProjectCard pulls the render-time context from these hooks/stores;
// mock them so the component can be tested in isolation.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../hooks/useAttention', () => ({
  useAttention: () => ({
    fire: vi.fn(),
    clearAlert: vi.fn(),
    setActive: vi.fn(),
    reasonFor: vi.fn(() => undefined),
  }),
}))

vi.mock('../../stores/appStore', () => ({
  useAppStore: (selector: (s: { pixelAnimationsEnabled: boolean; activateSession: () => void }) => unknown) =>
    selector({
      pixelAnimationsEnabled: false,
      activateSession: vi.fn(),
    }),
}))

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    project_id: 'p1',
    workspace_path: '/repo/main',
    name: 'session-main',
    tmux_session_name: 'omni-s1',
    hook_enabled: false,
    created_at: '2026-01-01T00:00:00Z',
    runtime_kind: 'tmux',
    ...overrides,
  }
}

function makeWt(overrides: Partial<Workspace>): Workspace {
  return {
    id: 'w1',
    project_id: 'p1',
    path: '/repo/main',
    label: 'main',
    is_main: true,
    is_git_repo: true,
    is_git_worktree: false,
    ...overrides,
  }
}

const project: Project = {
  id: 'p1',
  name: 'repo',
  path: '/repo',
  created_at: '2026-01-01T00:00:00Z',
  path_valid: true,
}

const mainWt = makeWt({ id: 'w-main', path: '/repo/main', label: 'main', is_main: true })
const featureWt = makeWt({ id: 'w-feat', path: '/repo/feature', label: 'feature', is_main: false })

const mainSession = makeSession({ id: 'sm', name: 'session-main', workspace_path: '/repo/main' })
const featSession = makeSession({ id: 'sf', name: 'session-feat', workspace_path: '/repo/feature' })

const noop = () => undefined

function baseProps(overrides: Partial<Parameters<typeof ProjectCard>[0]>): Parameters<typeof ProjectCard>[0] {
  return {
    project,
    isExpanded: true,
    worktrees: [mainWt, featureWt],
    sessions: [mainSession, featSession],
    activeWorkspaceId: mainWt.id,
    activeSessionId: null,
    acpActivityFor: noop,
    onToggle: vi.fn(),
    onOpenCreateWorktree: vi.fn(),
    onRename: vi.fn(),
    onDeleteProject: vi.fn(),
    onWorkspaceClick: vi.fn(),
    onRepairProject: vi.fn(),
    onOpenCreateSession: vi.fn(),
    onDeleteWorktree: vi.fn(),
    onDeleteSession: vi.fn(),
    onReleaseRequest: vi.fn(),
    expandAllSessions: false,
    ...overrides,
  }
}

describe('ProjectCard worktree 展开模式', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    document.body.removeChild(container)
  })

  function renderCard(props: Parameters<typeof ProjectCard>[0]) {
    act(() => {
      root.render(<ProjectCard {...props} />)
    })
  }

  it('expandAllSessions=true 且某非聚焦 worktree 有会话时渲染其会话列表', () => {
    renderCard(baseProps({ expandAllSessions: true }))

    // feature worktree 非聚焦但有会话 → 会话列表被展开渲染
    expect(container.querySelector('.sidebar-session-list')).toBeTruthy()
    expect(container.textContent).toContain('session-feat')
    // 主 worktree 聚焦 → 其会话也在
    expect(container.textContent).toContain('session-main')
  })

  it('expandAllSessions=true 且某 worktree 无会话时不渲染其会话列表', () => {
    renderCard(baseProps({ expandAllSessions: true, sessions: [mainSession] }))

    // 仅聚焦的 main worktree 渲染会话列表；feature worktree 无会话则不展开
    expect(container.querySelectorAll('.sidebar-session-list').length).toBe(1)
    expect(container.textContent).toContain('session-main')
    expect(container.textContent).not.toContain('session-feat')
  })

  it('expandAllSessions=false 时仅聚焦 worktree 渲染会话列表（回归）', () => {
    renderCard(baseProps({ expandAllSessions: false }))

    // 非聚焦的 feature worktree 不展开，即使有会话
    expect(container.querySelectorAll('.sidebar-session-list').length).toBe(1)
    expect(container.textContent).toContain('session-main')
    expect(container.textContent).not.toContain('session-feat')
  })

  it('expandAllSessions=true 且非聚焦 worktree 无会话时仅渲染聚焦 worktree（含 noSessions 提示）', () => {
    renderCard(
      baseProps({
        expandAllSessions: true,
        worktrees: [featureWt],
        activeWorkspaceId: featureWt.id,
        sessions: [],
      })
    )

    // 聚焦的 feature worktree 有会话列表容器（显示 noSessions 提示）
    expect(container.querySelector('.sidebar-session-list')).toBeTruthy()
    expect(container.textContent).toContain('sidebar.noSessions')
  })
})
