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

/** 时长单位按界面语言出字形（zh → 小时/分钟/秒，en → h/m/s），避免硬编码单位。 */
function unitAmount(value: number, unit: 'hour' | 'minute' | 'second', locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value)
}

/**
 * turn 工作时长（毫秒）的口语格式（assistant 消息底部一行）：`0 → "0秒"`、
 * `0<ms<1s → "<1秒"`、`<1min → "42秒"`、`<1h → "2分钟42秒"`（整分省秒）、
 * `≥1h → "1小时2分钟"`。单位字形走 `Intl`（缺省回落运行时语言），故 zh/en 各得其所。
 *
 * 三态必须互不混淆：`null/undefined` = 时长未知（迁移前的历史行、未定稿的在建消息）
 * → 返回 `null` 让调用方整行不渲染；0 = 该活动没发生；亚秒 = 发生了但不足一秒，
 * 说成 `<1秒` 而非 `0秒`，免得把「干了一小会儿」报成「瞬时干完」。
 */
export function formatWorkDuration(ms: number | null | undefined, locale?: string): string | null {
  if (ms === null || ms === undefined) return null
  if (ms <= 0) return unitAmount(0, 'second', locale)
  if (ms < 1000) return `<${unitAmount(1, 'second', locale)}`
  const total = Math.round(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return unitAmount(hours, 'hour', locale) + unitAmount(minutes, 'minute', locale)
  if (minutes > 0)
    return seconds > 0
      ? unitAmount(minutes, 'minute', locale) + unitAmount(seconds, 'second', locale)
      : unitAmount(minutes, 'minute', locale)
  return unitAmount(seconds, 'second', locale)
}
