/**
 * 会话显示名的**单一真源**（AGENTS.md 工程准则 7①：同一判断散落 ≥2 处必须收敛）。
 *
 * 优先级（设计见 docs/dev/plans/2026-10-16-session-title-backfill.md D1）：
 *
 *   ① `name`        用户手写名。非空即「用户命名过」，**永不被 agent 侧标题覆盖**
 *   ② `agent_title` agent 侧标题快照（live `session_info_update` / `session/list`）
 *   ③ 宿主默认名    `${agent 显示名}_${MMdd-HHmm}`，由 agent_id + created_at 现算
 *   ④ `未命名`      tmux/pty 等无 agent 的会话
 *
 * ③ 为什么不在库里而在这里现算：默认名的生成口径是**浏览器本地时间**
 * （`CreateSessionModal` 历史上就是这么做的），而后端 `created_at` 是 UTC。
 * 落库会让「按 created_at 重算再比对」这类判据因时区漂移静默失效；展示期用
 * `new Date(created_at)` + 本地 getter 现算，则与历史行为逐字相同，且无需
 * provenance 标记列——`name` 非空即手写，由 schema 保证。
 *
 * 调用方一律经本函数取值，**不要**再写 `session.name || session.tmux_session_name`：
 * 那套写法会让未命名的 ACP 会话渲染成空串（历史依赖 ACP 默认名非空才没暴露），
 * 且新加的 agent 标题永远接不进去。
 */

import type { Session } from '../api/client'

export interface SessionDisplayNameInput {
  name?: string | null
  agent_title?: string | null
  agent_id?: string | null
  created_at?: string
  tmux_session_name?: string | null
}

/** agent 注册表的最小形态（`agentStore.agents` 的子集，避免耦合整个 store）。 */
export interface SessionAgentInfo {
  id: string
  display_name: string
}

/**
 * 宿主默认名：`${agent 显示名}_${MMdd-HHmm}`（本地时间）。
 *
 * 与历史 `CreateSessionModal` 的生成逻辑逐字一致（月/日/时/分各补零到 2 位），
 * 只是把输入从「创建那一刻」换成「行的 created_at」——两者是同一個时刻。
 * `created_at` 解析失败时退化为空串，由调用方走最后的兜底。
 */
export function defaultSessionName(
  agent: SessionAgentInfo | undefined,
  createdAt: string | undefined,
): string {
  if (!agent || !createdAt) return ''
  const d = new Date(createdAt)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${agent.display_name}_${mm}${dd}-${hh}${mi}`
}

/**
 * 会话的展示名。`unnamed` 由调用方传入（i18n 文案），本模块不依赖 react-i18next
 * 以便在非组件上下文里复用与单测。
 */
export function sessionDisplayName(
  session: SessionDisplayNameInput,
  agents: SessionAgentInfo[],
  unnamed: string,
): string {
  const userNamed = session.name?.trim()
  if (userNamed) return userNamed

  const agentTitle = session.agent_title?.trim()
  if (agentTitle) return agentTitle

  const agent = session.agent_id
    ? agents.find((a) => a.id === session.agent_id)
    : undefined
  const fallback = defaultSessionName(agent, session.created_at)
  if (fallback) return fallback

  const engineName = session.tmux_session_name?.trim()
  return engineName || unnamed
}

/** 便捷包装：直接收 `Session`（前端 API 类型）。 */
export function sessionDisplayNameOf(
  session: Session,
  agents: SessionAgentInfo[],
  unnamed: string,
): string {
  return sessionDisplayName(session, agents, unnamed)
}
