/**
 * 文件表格虚拟滚动的窗口计算单一真源。
 *
 * 列表超过阈值时只渲染可视区 + overscan，并用上下两个 spacer 行撑住总高度，
 * 保持原生滚动条与 sticky 表头/操作列的行为；阈值以下全量渲染，小目录的
 * DOM 结构与行内编辑/拖拽/测试断言完全不变。
 */

/**
 * 行高（px）：由 24px 动作图标决定（preflight 已清掉 td 默认 padding）。
 * 与 index.css 的文件表格行高同步，改动任一处都需同步另一处。
 */
export const FM_ROW_HEIGHT = 24

/** 超过此条目数才启用窗口化；以下全量渲染。 */
export const FM_VIRTUALIZE_THRESHOLD = 200

/** 可视区上下额外渲染的行数（滚动时不露白）。 */
export const FM_OVERSCAN = 8

/** 容器高度尚未测出时的兜底可视行数（jsdom / 隐藏面板）。 */
const FALLBACK_VIEWPORT_ROWS = 20

export interface FileListWindow {
  start: number
  end: number
  topPad: number
  bottomPad: number
}

/**
 * 计算可视行区间与上下 spacer 高度。
 *
 * 不变式：`topPad + (end - start) * FM_ROW_HEIGHT + bottomPad === count * FM_ROW_HEIGHT`
 * （滚动条总高度恒定，不随窗口化抖动）。
 */
export function computeFileListWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
): FileListWindow {
  if (count <= FM_VIRTUALIZE_THRESHOLD) {
    return { start: 0, end: count, topPad: 0, bottomPad: 0 }
  }

  const height = viewportHeight > 0 ? viewportHeight : FM_ROW_HEIGHT * FALLBACK_VIEWPORT_ROWS
  const visibleRows = Math.max(1, Math.ceil(height / FM_ROW_HEIGHT))
  const rawStart = Math.floor(Math.max(0, scrollTop) / FM_ROW_HEIGHT) - FM_OVERSCAN
  const start = Math.min(Math.max(0, count - visibleRows), Math.max(0, rawStart))
  const end = Math.min(count, start + visibleRows + FM_OVERSCAN * 2)

  return {
    start,
    end,
    topPad: start * FM_ROW_HEIGHT,
    bottomPad: (count - end) * FM_ROW_HEIGHT,
  }
}
