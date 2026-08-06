// frontend/src/utils/path.ts
//
// Pure path utilities. Currently only used by file browsing UIs
// (FileManager, new-project modal) but kept generic for future reuse.

/**
 * Return the parent directory of `path`, or '' if `path` is root or empty.
 *
 * - ''  /  '/'  → '' (root has no parent)
 * - '/a'         → ''
 * - '/a/b'       → '/a'
 * - '/a/b/'      → '/a'
 * - 'a/b'        → 'a'  (relative paths work too)
 * - 'G:/Codes'   → 'G:/' (Windows drive root stays rooted; bare 'G:' is drive-relative)
 * - 'G:/'        → ''  (drive root has no parent)
 */
export function getParentPath(path: string): string {
  if (!path || path === '/') return ''
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  if (/^[A-Za-z]:$/.test(trimmed)) return ''
  const idx = trimmed.lastIndexOf('/')
  const parent = idx <= 0 ? '' : trimmed.slice(0, idx)
  return /^[A-Za-z]:$/.test(parent) ? parent + '/' : parent
}

/**
 * 判断 `filePath` 是否超出 `workspaceRoot` 边界（用于越界写拦截）。
 *
 * - workspaceRoot 为 undefined/null/空：视为越界（安全默认——project 模式拿不到
 *   workspace_root，宁可每次都确认）。
 * - 路径分隔符边界：用「等于 root 或 root + '/' 前缀」判断，避免 `/home/a`
 *   误匹配 `/home/ab`。
 * - workspaceRoot 尾随斜杠先归一化；root 为 `/`（文件系统根）时任何绝对路径都在内。
 * - Windows 大小写敏感差异忽略（后端有最终防线）。
 */
export function isPathOutsideWorkspace(filePath: string, workspaceRoot: string | undefined | null): boolean {
  if (!workspaceRoot) return true
  const root = workspaceRoot.replace(/\/+$/, '') || '/'
  if (root === '/') return false
  return !(filePath === root || filePath.startsWith(root + '/'))
}

/**
 * 外部改名事件路径还原：drawer 打开文件的绝对路径 `absPath` 以「/ + from（相对 watch 根的
 * 旧路径）」结尾时，前缀即 watch 根，据此把 `to`（相对 watch 根的新路径）还原成新的绝对路径。
 *
 * - 匹配：`resolveRenamedPath('/root/img/a.png', 'img/a.png', 'img/b.png')` → `/root/img/b.png`
 * - 跨目录 move：`resolveRenamedPath('/root/img/a.png', 'img/a.png', 'new/b.png')` → `/root/new/b.png`
 * - 不匹配（rename 与 absPath 无关，如同名文件在别的目录被改名）：返回 `null`
 *
 * 比 basename 匹配更精确：要求目录结构对齐，避免 watch 树内同名文件被改名时误切路径。
 */
export function resolveRenamedPath(absPath: string, from: string, to: string): string | null {
  const suffix = `/${from}`
  if (!absPath.endsWith(suffix)) return null
  const watchRoot = absPath.slice(0, absPath.length - from.length - 1)
  return `${watchRoot}/${to}`
}
