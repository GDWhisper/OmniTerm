/**
 * ACP agent 选择的默认值：优先上次用过的，否则列表第一个。
 *
 * 从 `CreateSessionModal` 抽出（工程准则 7①：同一判断出现在 ≥2 处必须收敛）——
 * 「Agent 历史」面板的 agent 选择器要用同一口径，否则会出现「弹窗默认 codebuddy、
 * 面板默认 opencode」的分裂。
 */

export interface DefaultAgentCandidate {
  id: string
}

export function defaultAcpAgentId(
  agents: DefaultAgentCandidate[],
  lastAcpAgentId: string | null,
): string | null {
  if (lastAcpAgentId && agents.some((a) => a.id === lastAcpAgentId)) return lastAcpAgentId
  return agents[0]?.id ?? null
}
