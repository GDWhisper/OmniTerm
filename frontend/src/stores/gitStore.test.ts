import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useGitStore } from './gitStore'

const gitStatus = vi.hoisted(() => vi.fn(async () => ({
  is_repo: true,
  repo_root: '/repo',
  branch: 'dev',
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  entries: [],
})))

vi.mock('../api/client', () => ({
  api: { gitStatus },
}))

const bind = { session: 's1' }

describe('gitStore.mutate', () => {
  beforeEach(() => {
    gitStatus.mockClear()
    useGitStore.setState({ status: null, branches: [], mutating: false })
  })

  it('refuses a concurrent mutation instead of reporting a phantom success', async () => {
    let release!: () => void
    const firstOp = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const secondOp = vi.fn(async () => {})

    const first = useGitStore.getState().mutate(bind, firstOp)
    await Promise.resolve()
    expect(useGitStore.getState().mutating).toBe(true)

    const second = await useGitStore.getState().mutate(bind, secondOp)
    expect(second).toBe(false)
    expect(secondOp).not.toHaveBeenCalled()

    release()
    await expect(first).resolves.toBe(true)
    expect(firstOp).toHaveBeenCalledTimes(1)
    expect(gitStatus).toHaveBeenCalledTimes(1)
    expect(useGitStore.getState().mutating).toBe(false)
  })

  it('returns true and refreshes status after a successful mutation', async () => {
    const op = vi.fn(async () => {})
    await expect(useGitStore.getState().mutate(bind, op)).resolves.toBe(true)
    expect(op).toHaveBeenCalledTimes(1)
    expect(gitStatus).toHaveBeenCalledWith(bind)
  })

  it('rethrows a failed mutation, refreshes status and releases the busy flag', async () => {
    const op = vi.fn(async () => { throw new Error('boom') })
    await expect(useGitStore.getState().mutate(bind, op)).rejects.toThrow('boom')
    expect(useGitStore.getState().mutating).toBe(false)
    // A failed merge/rebase leaves a paused operation behind; the panel must
    // learn about it immediately instead of waiting for the next poll.
    expect(gitStatus).toHaveBeenCalledTimes(1)
    expect(useGitStore.getState().status).toMatchObject({ branch: 'dev' })
  })
})
