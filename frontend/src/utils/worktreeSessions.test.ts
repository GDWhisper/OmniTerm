import { describe, it, expect } from 'vitest'
import { sessionsForWorktree } from './worktreeSessions'
import type { Session, Workspace } from '../api/client'

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    project_id: 'p1',
    workspace_path: '/repo/main',
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

const mainWt = makeWt({ id: 'w-main', path: '/repo/main', is_main: true })
const featureWt = makeWt({ id: 'w-feat', path: '/repo/feature', is_main: false })

describe('sessionsForWorktree', () => {
  it('精确匹配 worktree 路径的会话归入对应 worktree', () => {
    const mainSession = makeSession({ id: 'a', workspace_path: '/repo/main' })
    const featSession = makeSession({ id: 'b', workspace_path: '/repo/feature' })
    const sessions = [mainSession, featSession]
    const wts = [mainWt, featureWt]

    expect(sessionsForWorktree(sessions, wts, '/repo/main').map(s => s.id)).toEqual(['a'])
    expect(sessionsForWorktree(sessions, wts, '/repo/feature').map(s => s.id)).toEqual(['b'])
  })

  it('主 worktree 额外包含不匹配任何 worktree 路径的孤儿会话', () => {
    const mainSession = makeSession({ id: 'a', workspace_path: '/repo/main' })
    const orphan = makeSession({ id: 'o', workspace_path: '/somewhere/else' })
    const sessions = [mainSession, orphan]
    const wts = [mainWt, featureWt]

    expect(sessionsForWorktree(sessions, wts, '/repo/main').map(s => s.id)).toEqual(['a', 'o'])
  })

  it('非主 worktree 不含孤儿会话', () => {
    const featSession = makeSession({ id: 'b', workspace_path: '/repo/feature' })
    const orphan = makeSession({ id: 'o', workspace_path: '/somewhere/else' })
    const sessions = [featSession, orphan]
    const wts = [mainWt, featureWt]

    expect(sessionsForWorktree(sessions, wts, '/repo/feature').map(s => s.id)).toEqual(['b'])
  })

  it('无 is_main 时列表第一个 worktree 承担主 worktree 角色', () => {
    const first = makeWt({ id: 'w-first', path: '/repo/first', is_main: false })
    const second = makeWt({ id: 'w-second', path: '/repo/second', is_main: false })
    const firstSession = makeSession({ id: 'a', workspace_path: '/repo/first' })
    const orphan = makeSession({ id: 'o', workspace_path: '/elsewhere' })
    const sessions = [firstSession, orphan]

    expect(sessionsForWorktree(sessions, [first, second], '/repo/first').map(s => s.id)).toEqual(['a', 'o'])
    expect(sessionsForWorktree(sessions, [first, second], '/repo/second').map(s => s.id)).toEqual([])
  })
})
