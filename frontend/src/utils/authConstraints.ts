/**
 * 认证表单的前端预校验契约（单一真源）：
 * - 用户名与后端 `normalize_username` 同一语义（trim 后 1..=32 码点、禁控制字符）；
 * - 密码最小长度在 setup 与改密、登录页与设置页之间必须一致。
 *
 * 后端 `src/auth/mod.rs::normalize_username` 是权威判据；这里只是本地先拦，
 * 避免明知 400 还打一次请求。
 */

/** 用户名长度上限（Unicode 码点，非 UTF-16 码元，与后端 `chars().count()` 一致）。 */
export const MAX_USERNAME_CHARS = 32

/** Cc 类控制字符（C0 + DEL + C1），与后端 `char::is_control()` 同一集合。 */
// eslint-disable-next-line no-control-regex -- 判据就是要匹配控制字符本身
export const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/

/** 密码最小长度（前端统一 UX 下限；后端不强制，见 2026-09-27 计划「不纳入范围」）。 */
export const MIN_PASSWORD_LEN = 4

/**
 * 用户名格式是否合法（与后端同一契约）。输入会先 trim；空串视为不合法——
 * 调用方通常已对「空」有独立语义（按钮 disabled / fillAllFields），提前分流。
 */
export function isValidUsernameShape(raw: string): boolean {
  const name = raw.trim()
  return (
    name.length > 0 &&
    Array.from(name).length <= MAX_USERNAME_CHARS &&
    !CONTROL_CHARS_RE.test(name)
  )
}
