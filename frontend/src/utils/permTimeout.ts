/**
 * 权限请求超时时长的展示口径（单一真源）。
 *
 * 后端 detail 走秒制（`acp_perm_timeout_secs`，2026-10-01 起），而滑块档位是
 * 30 秒粒度——所以 30/90 秒这类档位若折算成分钟会得到「0 分钟 / 1.5 分钟」这种
 * 反直觉的文案。规则与后端 `acp::reaper::format_perm_duration` 一致：**整分钟报
 * 分钟，其余报秒**。
 *
 * 这里只产出 i18n key + 插值数字，文案交由 `t()` 渲染（保持单一翻译来源）；
 * 组件因此不必知道单位怎么切。
 */

/** detail 的最小结构（避免 util 反向依赖 stores 的具体类型）。 */
interface PermTimeoutDurationInput {
  /** 秒制时长（2026-10-01 起的后端载荷）。 */
  seconds?: number
  /** 分钟制时长（2026-10-01 之前的历史行，读 hydrate 出来的老消息会命中）。 */
  minutes?: number
}

/** 「总是」档：没有超时触发点（auto = 不等待直接自动放行；abort = 永不中止）。 */
export const PERM_TIMEOUT_NEVER_SECS = 0

/**
 * 取出告知载荷里的时长（秒）。历史行只有 `minutes`，按 ×60 回退；两个字段都
 * 缺失/非法时返回 `null`（调用方按「无时长」渲染，不能瞎补一个数）。
 */
export function permTimeoutSeconds(detail?: PermTimeoutDurationInput | null): number | null {
  if (!detail) return null
  if (typeof detail.seconds === 'number' && Number.isFinite(detail.seconds)) {
    return Math.max(0, detail.seconds)
  }
  if (typeof detail.minutes === 'number' && Number.isFinite(detail.minutes)) {
    return Math.max(0, detail.minutes * 60)
  }
  return null
}

/**
 * 时长 → i18n key + 插值数字。整分钟（%60===0）走分钟，其余走秒；
 * `0`（「总是」档）没有时长可言，返回 `null` 由调用方改用无时长句式。
 */
export function permTimeoutDuration(secs: number): { key: string; value: number } | null {
  if (secs === PERM_TIMEOUT_NEVER_SECS) return null
  return secs % 60 === 0
    ? { key: 'system.permTimeout.durationMin', value: secs / 60 }
    : { key: 'system.permTimeout.durationSec', value: secs }
}

/**
 * 告知 label → 实际要翻译的 key。「总是」档（时长 0）下 auto 模式并没有等待，
 * 沿用「N 分钟未获响应」的句式会自相矛盾，故换用不带时长的 `autoAlways` 文案。
 */
export function permTimeoutNoticeLabel(label: string, secs: number | null): string {
  if (secs === PERM_TIMEOUT_NEVER_SECS && label === 'system.permTimeout.auto') {
    return 'system.permTimeout.autoAlways'
  }
  return label
}
