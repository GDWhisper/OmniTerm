import { describe, it, expect } from 'vitest'
import type { TFunction } from 'i18next'
import {
  buildAgentSideDeleteCheckbox,
  isAgentSideDeleteEligible,
  shouldRequestAgentSideDelete,
  type AgentSideCandidate,
} from './agentSideDelete'

/**
 * 「同时永久删除 agent 侧会话记录」勾选框的判据契约。
 *
 * 三态的核心不变量：**只有已知支持且进程在驻留时才可勾选**。未知（本浏览器
 * 从未连过该会话）必须与不支持一样禁用——后端对未知能力不盲发，UI 可勾选
 * 就等于谎报（宁可漏删，不可谎报已删）。
 */

// 只断言 key 本身（i18n 文案由 locale 文件保证），故 t 直接回显 key
const t = ((key: string) => key) as unknown as TFunction

const acpAlive: AgentSideCandidate = { id: 's1', runtime_kind: 'acp', acp_process_alive: true }
const acpReleased: AgentSideCandidate = { id: 's2', runtime_kind: 'acp', acp_process_alive: false }
const tmux: AgentSideCandidate = { id: 's3', runtime_kind: 'tmux' }

describe('isAgentSideDeleteEligible', () => {
  it('is eligible only when the agent supports deletion and the process is resident', () => {
    expect(isAgentSideDeleteEligible(acpAlive, true)).toBe(true)
  })

  it('treats a known-unsupported agent as ineligible', () => {
    expect(isAgentSideDeleteEligible(acpAlive, false)).toBe(false)
  })

  it('treats an UNKNOWN capability as ineligible (never claim a deletion that may not happen)', () => {
    expect(isAgentSideDeleteEligible(acpAlive, undefined)).toBe(false)
  })

  it('is ineligible when the agent process has been released (no live connection to send the RPC)', () => {
    expect(isAgentSideDeleteEligible(acpReleased, true)).toBe(false)
  })

  it('reports "released" ahead of an unknown capability (same actionable fix: restore first)', () => {
    // 进程不在 + 能力未知：两者的动作都是「先把进程跑起来」，故给更具体的
    // 「已释放」，用户不必先猜「是不是 agent 不支持」。
    const { checkbox } = buildAgentSideDeleteCheckbox({
      candidates: [acpReleased],
      capabilityOf: () => undefined,
      defaultChecked: false,
      t,
    })
    expect(checkbox?.hint).toBe('sidebar.deleteAgentSideHintReleased')
  })

  it('reports "unsupported" ahead of "released" (restoring would not help)', () => {
    // 已知不支持时「恢复会话再删」是白跑一趟，必须给不可挽回的那条原因。
    const { checkbox } = buildAgentSideDeleteCheckbox({
      candidates: [acpReleased],
      capabilityOf: () => false,
      defaultChecked: false,
      t,
    })
    expect(checkbox?.hint).toBe('sidebar.deleteAgentSideHintUnsupported')
  })

  it('does not disable on an unknown process state (undefined ≠ released)', () => {
    expect(isAgentSideDeleteEligible({ id: 's4', runtime_kind: 'acp' }, true)).toBe(true)
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
      candidates: [acpAlive],
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

  it('disables the checkbox with an "unsupported" hint when the agent cannot delete', () => {
    const { checkbox } = buildAgentSideDeleteCheckbox({
      candidates: [acpAlive],
      capabilityOf: () => false,
      defaultChecked: true,
      t,
    })
    expect(checkbox?.disabled).toBe(true)
    expect(checkbox?.hint).toBe('sidebar.deleteAgentSideHintUnsupported')
  })

  it('disables the checkbox with an "unknown" hint when the capability was never observed', () => {
    const { checkbox } = buildAgentSideDeleteCheckbox({
      candidates: [acpAlive],
      capabilityOf: () => undefined,
      defaultChecked: true,
      t,
    })
    expect(checkbox?.disabled).toBe(true)
    expect(checkbox?.hint).toBe('sidebar.deleteAgentSideHintUnknown')
  })

  it('disables the checkbox with a "released" hint when the agent process is gone', () => {
    const { checkbox } = buildAgentSideDeleteCheckbox({
      candidates: [acpReleased],
      capabilityOf: () => true,
      defaultChecked: false,
      t,
    })
    expect(checkbox?.disabled).toBe(true)
    expect(checkbox?.hint).toBe('sidebar.deleteAgentSideHintReleased')
  })

  it('keeps only the eligible sessions in a mixed batch (no blind requests)', () => {
    const { checkbox, eligibleIds } = buildAgentSideDeleteCheckbox({
      candidates: [acpAlive, acpReleased, tmux],
      capabilityOf: (id) => (id === 's1' ? true : undefined),
      defaultChecked: true,
      t,
    })
    // s1 支持且在驻留 → 可勾；s2 已释放、s3 非 ACP → 排除
    expect(checkbox?.disabled).toBe(false)
    expect([...eligibleIds]).toEqual(['s1'])
  })

  it('disables the batch checkbox when no ACP session in the batch qualifies', () => {
    const { checkbox, eligibleIds } = buildAgentSideDeleteCheckbox({
      candidates: [acpReleased, acpReleased],
      capabilityOf: () => true,
      defaultChecked: true,
      t,
    })
    expect(checkbox?.disabled).toBe(true)
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
