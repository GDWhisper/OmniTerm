/**
 * ACP 会话浏览位置临时记忆（单一真源）。
 *
 * 切走 ACP 会话再回来，视口回到离开前正在读的位置；用户主动置底或刷新页面后
 * 从底部开始。三条决策：
 *
 * 1. **模块作用域而非 sessionStorage**：sessionStorage 跨刷新存活，与「刷新即
 *    清」的需求正相反；chatStore 无 persist，模块作用域与它同生命周期。
 * 2. **保存是写穿，不是切会话 cleanup 补存**：React 的 effect cleanup 在 DOM
 *    已提交为新会话内容之后才运行，读 `scrollRef.current.scrollTop` 拿到的是
 *    新会话被夹紧后的位置；改用 ref 传值又会跨会话串味（进入 B 后没滚动就离
 *    开，会把 A 的位置存成 B 的记忆）。写穿保证记忆只由该会话真实滚动事件产
 *    生、恒最新，离开瞬间无需任何保存动作。
 * 3. **有界（§P1）**：最多跟踪 `MAX_TRACKED_SCROLL_MEMORIES` 个会话，超限淘汰
 *    最久未写；每次写入 delete 后 set = 刷新新鲜度。被淘汰后从底部开始，功能
 *    降级可感知但温和。
 *
 * 清除点（全部是「内容参照系变了」或「用户主动置底」）：滚动回底 / 点「回到
 * 底部」/ 发送 / 重新生成 / 手动恢复重建内容（`useAcpChat` 的 `replay_start`
 * 且 `!suppressReplay`）。「连接即重放」的 suppress 分支不碰 store，故不清
 * ——否则空闲约 125s 一次的 WS 重连会周期性抹掉用户正在用的浏览位置。
 */

/** 同时记忆的会话数上限（§P1 有界；插入序淘汰最久未写）。 */
export const MAX_TRACKED_SCROLL_MEMORIES = 32

const bySession = new Map<string, number>()

/** 记录会话的浏览位置（写穿；同时刷新该条目的新鲜度）。 */
export function setChatScrollMemory(sessionId: string, scrollTop: number): void {
  if (!sessionId) return
  bySession.delete(sessionId)
  if (bySession.size >= MAX_TRACKED_SCROLL_MEMORIES) {
    const oldest = bySession.keys().next().value
    if (oldest !== undefined) bySession.delete(oldest)
  }
  bySession.set(sessionId, Math.max(0, scrollTop))
}

/** 读取会话的浏览位置；无记忆返回 null（调用方据此走贴底态归一）。 */
export function getChatScrollMemory(sessionId: string): number | null {
  return bySession.get(sessionId) ?? null
}

/** 清除单个会话的记忆（用户主动置底 / 内容重建）。 */
export function clearChatScrollMemory(sessionId: string): void {
  bySession.delete(sessionId)
}

/** 清空全部记忆（测试隔离契约；生产路径不调用）。 */
export function clearAllChatScrollMemory(): void {
  bySession.clear()
}
