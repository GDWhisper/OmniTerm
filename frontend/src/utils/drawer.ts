/**
 * 抽屉初始高度：无历史记录时默认取视口高度 50%（点开文件默认占文件管理器一半），
 * 有记录时尊重用户拖拽结果。与拖拽钳制 [120, innerHeight-60]（useDrawerResize）一致。
 */
export function getInitialDrawerHeight(storageKey: string): number {
  const stored = sessionStorage.getItem(storageKey)
  if (stored) {
    const n = parseInt(stored)
    if (!Number.isNaN(n)) return n
  }
  const half = Math.round(window.innerHeight * 0.5)
  return Math.max(120, Math.min(window.innerHeight - 60, half))
}
