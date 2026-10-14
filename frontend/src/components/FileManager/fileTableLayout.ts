/**
 * 文件表格列宽的单一真源：常量 + 自适应分配算式。
 *
 * 自适应模式（`nameColAuto`，用户尚未手动拖列）下表格总宽 = 容器宽 - 滚动条宽：
 * - 宽容器（≥ 522px）与历史 D5 算式完全一致（name 吃剩余，mtime/size 取目标值）；
 * - 窄容器按优先级收缩：先 size（信息最次要）、再 mtime、最后 name，各自到
 *   下限为止。下限之和尚装不下时（< 372px）保持下限、表格横向滚动，由
 *   sticky 操作列兜住操作性（X17：修复此前窄容器下 name 被 `minName` 锁死、
 *   表格溢出而 sticky 操作列盖住「大小/修改时间」两列的缺陷）。
 *
 * 手动态（用户拖过任意列）不走本算式——列宽与横向滚动行为与历史一致。
 */

/** 目标列宽（px）——宽容器下的分配（与 D5 原算式同值） */
export const FM_COL = { mtime: 140, size: 100, actions: 132, minName: 140 } as const

/** 窄容器收缩下限（px）——到达后不再继续压，宁愿横向滚动 */
export const FM_COL_MIN = { mtime: 80, size: 60, name: 90 } as const

/** 下载模式的复选框列宽（px），参与容器预算扣减 */
export const FM_COL_CHECKBOX = 32

/** 滚动容器常显滚动条的宽度（px，与 index.css 的 .fm-table-scroll 同步） */
export const FM_SCROLLBAR_W = 8

export interface FileTableColWidths {
  name: number
  mtime: number
  size: number
}

/**
 * 按容器宽度分配 name/mtime/size 三列（actions 列固定 `FM_COL.actions`
 * 不参与分配）。
 *
 * @param containerW 表格外层容器宽度（px，`.fm-table-wrap` 的 clientWidth）
 * @param extra      额外固定列的扣减额（下载模式的复选框列，默认 0）
 */
export function fitFileTableColumns(containerW: number, extra = 0): FileTableColWidths {
  // -FM_SCROLLBAR_W：滚动条常显占宽；-2：与历史算式一致的边框/滚动余量
  const avail = containerW - FM_SCROLLBAR_W - FM_COL.actions - extra - 2
  const idealName = avail - FM_COL.mtime - FM_COL.size
  if (idealName >= FM_COL.minName) {
    return { name: idealName, mtime: FM_COL.mtime, size: FM_COL.size }
  }
  // 缺口 = 理想总额 - 可用额度；按 size → mtime → name 顺序收缩，各自到下限
  let deficit = FM_COL.mtime + FM_COL.size + FM_COL.minName - avail
  const dSize = Math.min(deficit, FM_COL.size - FM_COL_MIN.size)
  deficit -= dSize
  const dMtime = Math.min(deficit, FM_COL.mtime - FM_COL_MIN.mtime)
  deficit -= dMtime
  const dName = Math.min(deficit, FM_COL.minName - FM_COL_MIN.name)
  return {
    name: FM_COL.minName - dName,
    mtime: FM_COL.mtime - dMtime,
    size: FM_COL.size - dSize,
  }
}
