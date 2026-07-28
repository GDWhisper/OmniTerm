import { describe, it, expect } from 'vitest'
import { aggregateStatus, sessionStatus } from './agentAggregate'
import type { Session } from '../api/client'

function makeSession(overrides: Partial<Session>): Session {
  return {
    id: 's1',
    project_id: 'p1',
    workspace_path: '/tmp/w',
    tmux_session_name: 'omni-s1',
    hook_enabled: false,
    created_at: '2026-01-01T00:00:00Z',
    runtime_kind: 'tmux',
    ...overrides,
  }
}

const noReason = () => undefined

describe('sessionStatus', () => {
  it('waiting agent is blocked', () => {
    expect(sessionStatus(makeSession({ agent_state: 'waiting' }), undefined)).toBe('blocked')
  })

  it('unseen decision/error attention is blocked', () => {
    expect(sessionStatus(makeSession({}), 'decision')).toBe('blocked')
    expect(sessionStatus(makeSession({}), 'error')).toBe('blocked')
  })

  it('unseen done attention is done', () => {
    expect(sessionStatus(makeSession({ agent_state: 'idle' }), 'done')).toBe('done')
  })

  it('running agent or active pane is working', () => {
    expect(sessionStatus(makeSession({ agent_state: 'running' }), undefined)).toBe('working')
    expect(sessionStatus(makeSession({ is_active: true }), undefined)).toBe('working')
  })

  it('idle agent with seen output is none', () => {
    expect(sessionStatus(makeSession({ agent_state: 'idle' }), undefined)).toBe('none')
  })

  it('acp session uses derived activity, not agent_state', () => {
    const acp = makeSession({ runtime_kind: 'acp' })
    expect(sessionStatus(acp, undefined, 'waiting')).toBe('blocked')
    expect(sessionStatus(acp, undefined, 'running')).toBe('working')
    expect(sessionStatus(acp, undefined, undefined)).toBe('none')
  })

  it('acp session ignores stale tmux agent_state field', () => {
    const acp = makeSession({ runtime_kind: 'acp', agent_state: 'waiting' })
    expect(sessionStatus(acp, undefined, undefined)).toBe('none')
  })
})

describe('aggregateStatus', () => {
  it('empty list is none', () => {
    expect(aggregateStatus([], noReason)).toBe('none')
  })

  it('blocked wins over done and working', () => {
    const sessions = [
      makeSession({ id: 'a', agent_state: 'running' }),
      makeSession({ id: 'b', agent_state: 'waiting' }),
      makeSession({ id: 'c', agent_state: 'idle' }),
    ]
    const reasonFor = (key: string) => (key === 'c' ? ('done' as const) : undefined)
    expect(aggregateStatus(sessions, reasonFor)).toBe('blocked')
  })

  it('done wins over working', () => {
    const sessions = [
      makeSession({ id: 'a', agent_state: 'running' }),
      makeSession({ id: 'b', agent_state: 'idle' }),
    ]
    const reasonFor = (key: string) => (key === 'b' ? ('done' as const) : undefined)
    expect(aggregateStatus(sessions, reasonFor)).toBe('done')
  })

  it('working when only active sessions', () => {
    expect(aggregateStatus([makeSession({ is_active: true })], noReason)).toBe('working')
  })

  it('acp activity accessor feeds aggregation', () => {
    const sessions = [
      makeSession({ id: 'a', runtime_kind: 'acp' }),
      makeSession({ id: 'b', agent_state: 'idle' }),
    ]
    const acpFor = (id: string) => (id === 'a' ? ('waiting' as const) : undefined)
    expect(aggregateStatus(sessions, noReason, acpFor)).toBe('blocked')
  })
})
