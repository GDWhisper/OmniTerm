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

/**
 * tps（tokens/s）读数：一位小数（`12.35 → "12.3"`）。只出数字，单位字形由
 * i18n 文案提供（`chat.msg.tps` = `{{tps}} tok/s`），不在此硬编码。非有限值/非正数
 * → `null`，调用方整段不渲染（与 `formatWorkDuration` 的三态语义一致）。
 */
export function formatTps(tps: number | null | undefined): string | null {
  if (tps === null || tps === undefined || !Number.isFinite(tps) || tps <= 0) return null
  return tps.toFixed(1)
}

/**
 * 工具耗时的三态封装：`null/undefined/≤0` → `null`（未知与「没观测到工具」都整段不渲染），
 * 否则走 `formatWorkDuration`。与 `formatTps` 同模式——「三态 → 渲染与否」的判断只在这里一份，
 * 调用方不各自内联（实时读数与定稿读数两个调用点共用）。
 */
export function formatToolDuration(ms: number | null | undefined, locale?: string): string | null {
  if (ms === null || ms === undefined || !(ms > 0)) return null
  return formatWorkDuration(ms, locale)
}

export type RelativeAgeParts =
  | { unit: 'now' }
  | { unit: 'minute' | 'hour' | 'day' | 'month' | 'year'; value: number }

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTH_DAYS = 30
const YEAR_DAYS = 365

/**
 * 侧栏会话行的紧凑相对时间：只出一档单位（刚刚 / N分 / N小时 / N天 / N个月 / N年）。
 * 单位文案由调用方按 `unit` 走 i18n，本函数只负责分档与取整。
 * 未来时间戳（时钟偏差）按「刚刚」处理；非法时间戳返回 null。
 */
export function relativeAgeParts(ms: number, now: number = Date.now()): RelativeAgeParts | null {
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return null
  const delta = now - ms
  if (delta < MINUTE_MS) return { unit: 'now' }
  if (delta < HOUR_MS) return { unit: 'minute', value: Math.floor(delta / MINUTE_MS) }
  if (delta < DAY_MS) return { unit: 'hour', value: Math.floor(delta / HOUR_MS) }
  const days = Math.floor(delta / DAY_MS)
  if (days < MONTH_DAYS) return { unit: 'day', value: days }
  if (days < YEAR_DAYS) return { unit: 'month', value: Math.floor(days / MONTH_DAYS) }
  return { unit: 'year', value: Math.floor(days / YEAR_DAYS) }
}
