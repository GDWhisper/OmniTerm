import type { TFunction } from 'i18next'
import type { Session } from '../../api/client'
import type { ConfirmCheckbox } from '../Modal/ConfirmDialog'

/**
 * 「同时永久删除 agent 侧会话记录」勾选框的共享判据。
 *
 * 单条删除（`DeleteConfirmDialog`）与批量删除（`BatchSessionDialog`）都要同一套
 * 三态逻辑，抽在这里避免两份实现漂移（工程准则 6）。
 *
 * ## 判据（能力已知支持 + 进程在驻留）
 *
 * 可勾选 = `agentDeleteSupported === true && acp_process_alive !== false`
 *
 * - `agentDeleteSupported` 来自后端 capabilities 帧（`sessionCapabilities.delete`，
 *   存在即支持）。`undefined` = 本浏览器从未连过该会话 → **不**视为支持：后端
 *   对未知能力不盲发（`method not found` 与真失败无法区分），UI 若可勾选就是
 *   谎报（宁可漏删，不可谎报已删，计划 D3）。
 * - `acp_process_alive === false` = agent 进程已释放（reaper 回收 / 手动 release /
 *   归档），此时没有活连接可发 `session/delete`，勾了也必然被跳过；
 *   `undefined`（归档列表等未富化来源）按未知处理，不据此禁用。
 *
 * ## 为什么禁用而不是「可勾选但后端会跳过」
 *
 * 勾选框代表一个**承诺**。让用户勾上一个注定不执行的选项、再在 toast 里解释
 * 「其实没删」，是把系统的失败转嫁给用户阅读；禁用 + 一句原因才是如实交代。
 */

/** 判据来源（`Session` 的字段子集，便于单测直接构造）。 */
export interface AgentSideCandidate {
  id: string
  runtime_kind: Session['runtime_kind']
  acp_process_alive?: boolean
}

/** 不可勾选的原因（决定 hint 文案；`undefined` = 可勾选）。 */
export type AgentSideBlockReason = 'unsupported' | 'unknown' | 'released'

function blockReason(
  candidate: AgentSideCandidate,
  capability: boolean | undefined,
): AgentSideBlockReason | undefined {
  // 已知不支持是最强的否决：恢复进程也救不回来（该 agent 根本没有这个能力），
  // 优先于「进程已释放」——否则用户会白跑一趟「恢复会话 → 再删」。
  if (capability === false) return 'unsupported';
  // 进程不在：没有活连接可发 RPC。这一条优先于「能力未知」——两者的可执行动作
  // 是同一个（先把进程跑起来），且进程恢复后能力随之被探明，故给更具体的「已释放」。
  if (candidate.acp_process_alive === false) return 'released';
  // 进程活着（或状态未知）但能力未探明：本浏览器从未连过该会话。
  if (capability === undefined) return 'unknown';
  return undefined;
}

/** 该会话是否满足「删除 agent 侧记录」的全部条件。 */
export function isAgentSideDeleteEligible(
  candidate: AgentSideCandidate,
  capability: boolean | undefined,
): boolean {
  return blockReason(candidate, capability) === undefined
}

/** 禁用原因 → 文案 key（i18n 单一真源，两份 locale 都要有）。 */
export function agentSideHintKey(reason: AgentSideBlockReason): string {
  switch (reason) {
    case 'unsupported':
      return 'sidebar.deleteAgentSideHintUnsupported'
    case 'unknown':
      return 'sidebar.deleteAgentSideHintUnknown'
    case 'released':
      return 'sidebar.deleteAgentSideHintReleased'
  }
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
    acp.filter((c) => isAgentSideDeleteEligible(c, args.capabilityOf(c.id))).map((c) => c.id),
  )
  const enabled = eligibleIds.size > 0
  // 批量场景可能「部分可勾选、部分不行」：勾选后只对可勾选的会话发请求（逐条
  // 判据），hint 只在**全部**不可勾选时出现——部分可勾时不必解释跳过项，
  // 因为那些会话仍然照常删除，只是不带 agent 侧删除。
  const reason =
    blockReason(acp[0], args.capabilityOf(acp[0].id)) ?? ('unknown' as AgentSideBlockReason)

  return {
    checkbox: {
      label: args.t('sidebar.deleteAgentSideLabel'),
      danger: true,
      defaultChecked: args.defaultChecked,
      disabled: !enabled,
      hint: enabled ? args.t('sidebar.deleteAgentSideHint') : args.t(agentSideHintKey(reason)),
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
