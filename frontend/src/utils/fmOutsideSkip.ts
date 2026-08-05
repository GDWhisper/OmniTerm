/**
 * 「越界写入暂时别提醒」的本地持久化。
 *
 * 存储格式：localStorage key `omniterm_fm_outside_skip`，值为 JSON 字符串数组，
 * 每个元素是一个已确认放行的 workspace root（绝对路径字符串），例如：
 *   ["/home/user/proj","/srv/data"]
 *
 * 说明：
 * - 仅当 workspaceRoot 存在（session/workspace 模式由 listFiles2 返回
 *   `workspace_root`）时才参与判断；project 模式返回裸数组、无
 *   workspace_root（undefined），此时 isOutsideSkipped 恒为 false（安全默认）。
 * - localStorage 在隐私模式/配额用尽等场景可能抛异常，所有读写均 try/catch
 *   包裹，失败时静默降级为「不跳过、每次提醒」。
 */

const STORAGE_KEY = 'omniterm_fm_outside_skip'

function readSkippedRoots(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    // 损坏数据 / localStorage 不可访问：当作无记录，安全默认。
    return []
  }
}

/** 该 workspace root 是否已被用户勾选「暂时别提醒」放行。 */
export function isOutsideSkipped(workspaceRoot: string | undefined | null): boolean {
  if (!workspaceRoot) return false
  return readSkippedRoots().includes(workspaceRoot)
}

/** 记录该 workspace root 为已放行（幂等，重复调用不产生重复条目）。 */
export function markOutsideSkipped(workspaceRoot: string | undefined | null): void {
  if (!workspaceRoot) return
  const roots = readSkippedRoots()
  if (roots.includes(workspaceRoot)) return
  roots.push(workspaceRoot)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(roots))
  } catch {
    // 隐私模式等场景写入失败：静默忽略，后续仍会提醒。
  }
}
