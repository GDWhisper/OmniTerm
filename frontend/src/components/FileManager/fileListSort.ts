import type { FileEntry } from '../../api/client'
import { isDirEntry } from './filePreviewShared'

export type FileSortKey = 'name' | 'mtime' | 'size'

/**
 * 搜索结果的前端本地排序（目录优先，key 升/降序，名称与 rel_path 作
 * 确定性 tiebreaker）。目录列表仍由后端排序；此函数只用于搜索态，
 * 因为搜索结果是当前列表的快照，不应为了排序再发一次目录请求。
 */
export function sortFileEntries(
  entries: FileEntry[],
  key: FileSortKey,
  desc: boolean,
): FileEntry[] {
  return [...entries].sort((a, b) => {
    const dirCmp = Number(isDirEntry(b.path_type)) - Number(isDirEntry(a.path_type))
    if (dirCmp !== 0) return dirCmp

    let cmp: number
    if (key === 'name') {
      cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    } else if (key === 'mtime') {
      cmp = a.mtime - b.mtime
    } else {
      cmp = (a.size ?? 0) - (b.size ?? 0)
    }
    if (cmp === 0) cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    if (cmp === 0) cmp = (a.rel_path ?? a.name).localeCompare(b.rel_path ?? b.name)
    return desc ? -cmp : cmp
  })
}
