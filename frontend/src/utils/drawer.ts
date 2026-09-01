/** 抽屉最小高度（拖拽钳制下界与初始高度共用） */
export const DRAWER_MIN_HEIGHT = 120
/** 抽屉顶部须保留的视口空隙（拖拽钳制上界 = innerHeight - DRAWER_TOP_GAP） */
export const DRAWER_TOP_GAP = 60

/** 抽屉高度钳制：[DRAWER_MIN_HEIGHT, innerHeight - DRAWER_TOP_GAP]（拖拽与初始高度共用真源） */
export function clampDrawerHeight(height: number): number {
  return Math.max(DRAWER_MIN_HEIGHT, Math.min(window.innerHeight - DRAWER_TOP_GAP, height))
}

/**
 * 抽屉初始高度：无历史记录时默认取视口高度 50%（点开文件默认占文件管理器一半），
 * 有记录时尊重用户拖拽结果。钳制范围见 `clampDrawerHeight`。
 */
export function getInitialDrawerHeight(storageKey: string): number {
  const stored = sessionStorage.getItem(storageKey)
  if (stored) {
    const n = parseInt(stored)
    if (!Number.isNaN(n)) return n
  }
  return clampDrawerHeight(Math.round(window.innerHeight * 0.5))
}
