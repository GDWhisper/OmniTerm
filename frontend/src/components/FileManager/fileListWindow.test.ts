import { describe, expect, it } from 'vitest'
import {
  computeFileListWindow,
  FM_OVERSCAN,
  FM_ROW_HEIGHT,
  FM_VIRTUALIZE_THRESHOLD,
  type FileListWindow,
} from './fileListWindow'

/** 总高度守恒：spacer + 渲染行 == 全量行 × 行高 */
function totalHeight(w: FileListWindow, count: number): number {
  return w.topPad + (w.end - w.start) * FM_ROW_HEIGHT + w.bottomPad - count * FM_ROW_HEIGHT
}

describe('computeFileListWindow', () => {
  it('阈值以下全量渲染', () => {
    expect(computeFileListWindow(FM_VIRTUALIZE_THRESHOLD, 9_999, 400)).toEqual({
      start: 0,
      end: FM_VIRTUALIZE_THRESHOLD,
      topPad: 0,
      bottomPad: 0,
    })
  })

  it('超过阈值只渲染可视区 + overscan，且总高度守恒', () => {
    const count = 5300
    const w = computeFileListWindow(count, FM_ROW_HEIGHT * 2075, 471)

    expect(w.start).toBe(2075 - FM_OVERSCAN)
    expect(w.end).toBeGreaterThan(w.start)
    expect(w.end).toBeLessThan(count)
    expect(totalHeight(w, count)).toBe(0)
  })

  it('滚动到底部不越界，bottom spacer 归零且总高度守恒', () => {
    const count = 5300
    const w = computeFileListWindow(count, count * FM_ROW_HEIGHT - 471, 471)

    expect(w.end).toBe(count)
    expect(w.bottomPad).toBe(0)
    expect(totalHeight(w, count)).toBe(0)
  })

  it('视口高度未测出时用兜底行数，而不是渲染全量', () => {
    const count = 5300
    const w = computeFileListWindow(count, 0, 0)

    expect(w.start).toBe(0)
    expect(w.end).toBeLessThan(count)
    expect(totalHeight(w, count)).toBe(0)
  })

  it('滚动位置超出内容时区间被钳制', () => {
    const count = 5300
    const w = computeFileListWindow(count, Number.MAX_SAFE_INTEGER, 471)

    expect(w.end).toBe(count)
    expect(totalHeight(w, count)).toBe(0)
  })
})
