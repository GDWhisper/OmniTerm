import { useCallback, useState } from 'react'
import { api, ApiError, type FileEntry } from '../api/client'

/** 只保留目录与符号链接目录；给定 prefix 时按名称前缀（大小写不敏感）过滤。 */
export function filterDirEntries(files: FileEntry[], prefix?: string): FileEntry[] {
  let dirs = files.filter((f) => f.path_type === 'Dir' || f.path_type === 'SymlinkDir')
  if (prefix) {
    const lower = prefix.toLowerCase()
    dirs = dirs.filter((f) => f.name.toLowerCase().startsWith(lower))
  }
  return dirs
}

/**
 * 目录浏览共享状态（创建项目弹窗的自动补全与修复路径弹窗的浏览列表共用）。
 * 404 时 entries 置空且 notFound=true（创建项目弹窗显示「将自动创建」提示，
 * 修复弹窗忽略该标志照常显示空目录态——与拆分前两处实现行为一致）。
 */
export function useDirBrowser() {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState(false)

  const loadDirs = useCallback(async (path: string, prefix?: string) => {
    setLoading(true)
    setError(null)
    setNotFound(false)
    try {
      const data = await api.listDirs(path)
      setEntries(filterDirEntries(data.files, prefix))
    } catch (e: unknown) {
      if (e instanceof ApiError && e.status === 404) {
        setNotFound(true)
        setEntries([])
      } else {
        setError((e instanceof Error ? e.message : String(e)) || '无法访问该目录')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  /** 清空列表与错误标志，回到未浏览的空白态（弹窗打开/关闭、路径输入被清空时使用）。 */
  const reset = useCallback(() => {
    setEntries([])
    setError(null)
    setNotFound(false)
  }, [])

  return { entries, loading, error, notFound, loadDirs, reset }
}
