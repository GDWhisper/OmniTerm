/**
 * 按 id 在 appStore 的会话表里找会话。
 *
 * appStore 的会话表是**按项目切片**的（`Record<project_id, Session[]>`），
 * 「找某个 id 的会话」因此到处都要 `Object.values(sessions).flat().find(...)`。
 * 那句展开+查找此前已在 Layout / ChatView 等处重复出现——同一判断散落 ≥2 处
 * 属工程准则 7①（抽共享函数立单一真源），故收敛到本文件。
 *
 * 注意：**只查已加载的项目切片**。未加载项目里的会话查不到（返回 undefined），
 * 调用方须自行给兜底（不要假设「会话一定在表里」）。
 */

import type { Session } from '../api/client'

/** 展开 appStore 的会话表（按项目切片 → 扁平列表）。 */
export function allSessions(sessions: Record<string, Session[]>): Session[] {
  return Object.values(sessions).flat()
}

/** 按会话 id 查找；未加载该项目时返回 undefined。 */
export function findSessionById(
  sessions: Record<string, Session[]>,
  sessionId: string | null | undefined,
): Session | undefined {
  if (!sessionId) return undefined
  return allSessions(sessions).find((s) => s.id === sessionId)
}
