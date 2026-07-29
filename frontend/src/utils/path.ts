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
