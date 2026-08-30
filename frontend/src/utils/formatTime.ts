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

/** 时长单位按界面语言出字形（zh → 小时/分钟/秒，en → h/m/s），避免硬编码单位。 */
function unitAmount(value: number, unit: 'hour' | 'minute' | 'second', locale?: string): string {
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'narrow' }).format(value)
}

/**
 * turn 工作时长的口语格式（assistant 消息底部一行）：`<1s → "<1秒"`、
 * `<1min → "42秒"`、`<1h → "2分钟42秒"`（整分省秒）、`≥1h → "1小时2分钟"`。
 *
 * 与 [`formatElapsed`](#formatElapsed) 的分工：那个是给侧栏像素 badge 用的紧凑记号，
 * 这个是正文里给人读的一行，故单位跟随 `locale`（缺省回落运行时语言）。
 * `null/undefined` = 时长未知（迁移前的历史行、未定稿的在建消息）→ 返回 `null`
 * 让调用方整行不渲染；亚秒收成 `<1秒` 而非 `0秒`，与 `formatElapsed` 同口径 ——
 * 不把「干了一小会儿」说成「瞬时干完」。
 */
export function formatWorkDuration(ms: number | null | undefined, locale?: string): string | null {
  if (ms === null || ms === undefined) return null
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

/**
 * 会话累计工作时长（`sessions.work_ms`）：0 与未知一样不渲染 —— 会话累计只在 turn
 * 定稿时增长，0 意味着「从无定稿 turn」，而亚秒的少量 turn 会落到 `"<1s"`，
 * 两者不能混为一谈。与消息级的两个 formatter 口径故意不同：那里亚秒仍给记号
 * （`"<1s"` / `"<1秒"`），这里宁可不显示。
 */
export function formatSessionWork(ms?: number | null): string | null {
  return ms ? formatElapsed(ms) : null
}
