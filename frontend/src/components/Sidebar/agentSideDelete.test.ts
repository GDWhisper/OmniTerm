import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TFunction } from 'i18next'
import {
  buildAgentSideDeleteCheckbox,
  isAgentSideDeleteEligible,
  resolvePendingAgentSide,
  shouldRequestAgentSideDelete,
  type AgentSideCandidate,
} from './agentSideDelete'

const deleteAgentAcpSession = vi.fn(async () => ({ ok: true, agent_side: 'deleted' as const }))
vi.mock('../../api/client', () => ({
  api: {
    deleteAgentAcpSession: (...args: unknown[]) =>
      (deleteAgentAcpSession as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
  },
}))

/**
 * 「同时永久删除 agent 侧会话记录」勾选框的判据契约。
 *
 * 核心不变量：**唯一禁用原因是「agent 已知不支持」**。能力未知（本浏览器从未
 * 连过该会话）与进程已释放都可勾选——后端会临时拉起短命 agent 进程现场探明
 * 能力并补发 `session/delete`（2026-10-09 行为变更：不再提示用户「先恢复会话」）。
 */

// 只断言 key 本身（i18n 文案由 locale 文件保证），故 t 直接回显 key
const t = ((key: string) => key) as unknown as TFunction

const acp: AgentSideCandidate = { id: 's1', runtime_kind: 'acp' }
const acp2: AgentSideCandidate = { id: 's2', runtime_kind: 'acp' }
const tmux: AgentSideCandidate = { id: 's3', runtime_kind: 'tmux' }

describe('isAgentSideDeleteEligible', () => {
  it('is eligible when the agent supports deletion', () => {
    expect(isAgentSideDeleteEligible(true)).toBe(true)
  })

  it('is eligible when the capability is unknown (the backend probes on demand)', () => {
    expect(isAgentSideDeleteEligible(undefined)).toBe(true)
  })

  it('treats a known-unsupported agent as ineligible (spawning would not help)', () => {
    expect(isAgentSideDeleteEligible(false)).toBe(false)
  })
})

describe('buildAgentSideDeleteCheckbox', () => {
  it('omits the checkbox for sessions with no ACP target', () => {
    const { checkbox, eligibleIds } = buildAgentSideDeleteCheckbox({
      candidates: [tmux],
      capabilityOf: () => true,
      defaultChecked: false,
      t,
    })
    expect(checkbox).toBeUndefined()
    expect(eligibleIds.size).toBe(0)
  })

  it('renders an enabled red checkbox when the capability is confirmed', () => {
    const { checkbox, eligibleIds } = buildAgentSideDeleteCheckbox({
      candidates: [acp],
      capabilityOf: () => true,
      defaultChecked: true,
      t,
    })
    expect(checkbox?.danger).toBe(true)
    expect(checkbox?.disabled).toBe(false)
    expect(checkbox?.defaultChecked).toBe(true)
    expect(checkbox?.label).toBe('sidebar.deleteAgentSideLabel')
    expect([...eligibleIds]).toEqual(['s1'])
  })

  it('keeps the checkbox enabled when the capability was never observed', () => {
    // 能力未知不再禁用：后端删除时会现场拉起短命 agent 探明能力（旧行为是
    // 「禁用 + 提示先恢复会话」，2026-10-09 按用户指令推翻）。
    const { checkbox, eligibleIds } = buildAgentSideDeleteCheckbox({
      candidates: [acp],
      capabilityOf: () => undefined,
      defaultChecked: false,
      t,
    })
    expect(checkbox?.disabled).toBe(false)
    expect(checkbox?.hint).toBe('sidebar.deleteAgentSideHint')
    expect([...eligibleIds]).toEqual(['s1'])
  })

  it('disables the checkbox with an "unsupported" hint when the agent cannot delete', () => {
    const { checkbox, eligibleIds } = buildAgentSideDeleteCheckbox({
      candidates: [acp],
      capabilityOf: () => false,
      defaultChecked: true,
      t,
    })
    expect(checkbox?.disabled).toBe(true)
    expect(checkbox?.hint).toBe('sidebar.deleteAgentSideHintUnsupported')
    expect(eligibleIds.size).toBe(0)
  })

  it('keeps only the eligible sessions in a mixed batch (no blind requests)', () => {
    const { checkbox, eligibleIds } = buildAgentSideDeleteCheckbox({
      candidates: [acp, acp2, tmux],
      capabilityOf: (id) => (id === 's1' ? undefined : false),
      defaultChecked: true,
      t,
    })
    // s1 能力未知 → 可勾（后端现场探明）；s2 已知不支持、s3 非 ACP → 排除
    expect(checkbox?.disabled).toBe(false)
    expect([...eligibleIds]).toEqual(['s1'])
  })

  it('disables the batch checkbox when every ACP session is known-unsupported', () => {
    const { checkbox, eligibleIds } = buildAgentSideDeleteCheckbox({
      candidates: [acp, acp2],
      capabilityOf: () => false,
      defaultChecked: true,
      t,
    })
    expect(checkbox?.disabled).toBe(true)
    expect(checkbox?.hint).toBe('sidebar.deleteAgentSideHintUnsupported')
    expect(eligibleIds.size).toBe(0)
  })
})

describe('shouldRequestAgentSideDelete', () => {
  const eligible = new Set(['s1'])

  it('requests only for eligible sessions when checked', () => {
    expect(shouldRequestAgentSideDelete(eligible, 's1', true)).toBe(true)
    expect(shouldRequestAgentSideDelete(eligible, 's2', true)).toBe(false)
  })

  it('never requests when the checkbox is unchecked', () => {
    expect(shouldRequestAgentSideDelete(eligible, 's1', false)).toBe(false)
  })
})

describe('resolvePendingAgentSide', () => {
  const target = { agentId: 'agent-1', acpSessionId: 'acp-sess-1', workspacePath: '/tmp/ws' }

  beforeEach(() => {
    deleteAgentAcpSession.mockClear()
    deleteAgentAcpSession.mockResolvedValue({ ok: true, agent_side: 'deleted' })
  })

  it('sends the session-row context and reports the endpoint outcome', async () => {
    await expect(resolvePendingAgentSide(target)).resolves.toBe('deleted')
    expect(deleteAgentAcpSession).toHaveBeenCalledWith('agent-1', 'acp-sess-1', '/tmp/ws')
  })

  it('degrades to skipped when the request fails (never claims a deletion)', async () => {
    deleteAgentAcpSession.mockRejectedValueOnce(new Error('boom'))
    await expect(resolvePendingAgentSide(target)).resolves.toBe('skipped')
  })

  it('degrades to skipped when the session-row context is incomplete', async () => {
    for (const missing of [
      { ...target, agentId: undefined },
      { ...target, acpSessionId: undefined },
      { ...target, workspacePath: undefined },
    ]) {
      await expect(resolvePendingAgentSide(missing)).resolves.toBe('skipped')
    }
    expect(deleteAgentAcpSession).not.toHaveBeenCalled()
  })
})
