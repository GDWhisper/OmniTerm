import type { TFunction } from 'i18next'
import { api, type AgentSideDeleteResult, type Session } from '../../api/client'
import type { ConfirmCheckbox } from '../Modal/ConfirmDialog'

/**
 * 「同时永久删除 agent 侧会话记录」勾选框的共享判据。
 *
 * 单条删除（`DeleteConfirmDialog`）与批量删除（`BatchSessionDialog`）都要同一套
 * 逻辑，抽在这里避免两份实现漂移（工程准则 6）。
 *
 * ## 判据（仅「已知不支持」禁用）
 *
 * 可勾选 = `agentDeleteSupported !== false`
 *
 * - `true`：该 agent 在 initialize 里声明了 `sessionCapabilities.delete`。
 * - `undefined`（本浏览器从未连过该会话 / 后端重启后未恢复）：**可勾选**——
 *   能力未知不等于不支持，后端删除时会现场拉起一个短命 agent 进程探明能力，
 *   再决定是否发 `session/delete`；不该让用户「先恢复会话」自己跑一趟。
 * - `false`（该 agent 明确未声明能力，实测 codebuddy）：禁用——拉起也不会让它
 *   学会这个方法，勾了必然 skipped，可勾选就是谎报（宁可漏删，不可谎报已删）。
 *
 * 进程是否驻留（`acp_process_alive`）**不是**前端判据：进程不在（reaper 回收 /
 * 手动 release / 后端重启 / 连接已死）时后端会临时拉起补发（
 * `delete_agent_side_record_via_ephemeral_spawn`），删除结果照常以
 * `agent_side` 三态如实回报。
 */

/** 判据来源（`Session` 的字段子集，便于单测直接构造）。 */
export interface AgentSideCandidate {
  id: string
  runtime_kind: Session['runtime_kind']
}

/** 该会话是否满足「删除 agent 侧记录」的前端条件（唯一否决：已知不支持）。 */
export function isAgentSideDeleteEligible(capability: boolean | undefined): boolean {
  return capability !== false
}

/**
 * 构造传给 `ConfirmDialog` 的复选框配置 + 本次真正会带 `delete_agent_side` 的会话集。
 *
 * @param candidates     本次删除涉及的会话（单条 = 一个；批量 = 全部选中项）
 * @param capabilityOf   读某会话的 `agentDeleteSupported`（chatStore 选择器）
 * @param defaultChecked 用户上次的选择；仅在可勾选时生效（禁用态由组件强制未勾选）
 * @returns `checkbox` 为 `undefined` 表示本次删除不含 ACP 会话（非 ACP 不该出现该框）
 */
export function buildAgentSideDeleteCheckbox(args: {
  candidates: AgentSideCandidate[]
  capabilityOf: (sessionId: string) => boolean | undefined
  defaultChecked: boolean
  t: TFunction
}): { checkbox?: ConfirmCheckbox; eligibleIds: Set<string> } {
  const acp = args.candidates.filter((c) => c.runtime_kind === 'acp')
  if (acp.length === 0) return { checkbox: undefined, eligibleIds: new Set() }

  const eligibleIds = new Set(
    acp.filter((c) => isAgentSideDeleteEligible(args.capabilityOf(c.id))).map((c) => c.id),
  )
  const enabled = eligibleIds.size > 0
  // 批量场景可能「部分可勾选、部分不行」（已知不支持的混在里面）：勾选后只对
  // 可勾选的会话发请求（逐条判据），hint 只在**全部**不可勾选时出现——部分可勾
  // 时不必解释跳过项，因为那些会话仍然照常删除，只是不带 agent 侧删除。
  return {
    checkbox: {
      label: args.t('sidebar.deleteAgentSideLabel'),
      danger: true,
      defaultChecked: args.defaultChecked,
      disabled: !enabled,
      // 不可勾选时只剩「agent 未声明能力」一个原因（见文件头判据）。
      hint: enabled
        ? args.t('sidebar.deleteAgentSideHint')
        : args.t('sidebar.deleteAgentSideHintUnsupported'),
    },
    eligibleIds,
  }
}

/** 勾选框勾选时，该会话是否真的带 `?delete_agent_side=true`。 */
export function shouldRequestAgentSideDelete(
  eligibleIds: Set<string>,
  sessionId: string,
  checked: boolean,
): boolean {
  return checked && eligibleIds.has(sessionId)
}

/**
 * 两段式的第二段：`DELETE /sessions/{id}` 返回 `pending`（进程不驻留，后端不在
 * 删除请求内临时拉起 agent）时，带着会话的 `agent_id` / `acp_session_id` /
 * `workspace_path` 补发 agent 侧删除端点，返回可上报的结果。
 *
 * 缺失上下文（理论上不该有——运行期 ACP 会话三个字段齐备）或请求失败一律按
 * `skipped` 上报：「未能删除」是这里唯一诚实的说法（宁可漏删，不可谎报已删）。
 */
export async function resolvePendingAgentSide(target: {
  agentId?: string
  acpSessionId?: string
  workspacePath?: string
}): Promise<AgentSideDeleteResult> {
  const { agentId, acpSessionId, workspacePath } = target
  if (!agentId || !acpSessionId || !workspacePath) return 'skipped'
  try {
    const res = await api.deleteAgentAcpSession(agentId, acpSessionId, workspacePath)
    return res?.agent_side ?? 'skipped'
  } catch {
    // 错误 toast 由 api client 弹出；这里只把结果降级为「未能删除」
    return 'skipped'
  }
}
