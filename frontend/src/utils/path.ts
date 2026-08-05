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
