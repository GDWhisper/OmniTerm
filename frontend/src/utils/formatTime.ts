/**
 * 聊天气泡 hover 显示的系统时间（本地时区，智能缩写）：
 * 今天 → HH:mm；今年内跨天 → MM-DD HH:mm；跨年 → YYYY-MM-DD HH:mm。
 * `now` 仅测试注入用，默认取当前时刻。
 */
export function formatHoverTime(ms: number, now: Date = new Date()): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay =
    now.getFullYear() === d.getFullYear() &&
    now.getMonth() === d.getMonth() &&
    now.getDate() === d.getDate()
  if (sameDay) return hm
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (now.getFullYear() === d.getFullYear()) return `${md} ${hm}`
  return `${d.getFullYear()}-${md} ${hm}`
}

/**
 * turn 工作时长（毫秒）的短格式：`<1s → "<1s"`、`<1min → 42s`、`<1h → 42m`、
 * `≥1h → 2h42m`。
 * `null/undefined` 表示时长未知（历史行 duration_ms 为 NULL），返回 `null` 让调用方
 * 不渲染 —— 未知不等于 0；亚秒则显示 `"<1s"` 而非 `"0s"`，避免把「干了不到一秒」
 * 说成「瞬时干完」。
 */
export function formatElapsed(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null
  if (ms < 1000) return '<1s'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h${min % 60}m`
}

/**
 * 会话累计工作时长（`sessions.work_ms`）：0 与未知一样不渲染 —— 会话累计只在 turn
 * 定稿时增长，0 意味着「从无定稿 turn」，而亚秒的少量 turn 会落到 `"<1s"`，
 * 两者不能混为一谈。与消息级的 `formatElapsed`（0 也渲染）口径故意不同。
 */
export function formatSessionWork(ms?: number | null): string | null {
  return ms ? formatElapsed(ms) : null
}
