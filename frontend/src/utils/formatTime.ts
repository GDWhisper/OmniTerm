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
