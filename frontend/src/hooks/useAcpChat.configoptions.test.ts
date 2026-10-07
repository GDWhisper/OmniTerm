import { describe, it, expect } from 'vitest'
import { parseConfigOptions } from './useAcpChat'

// 回归：ACP SessionConfigSelectOption.description 必须保留到前端（模型消耗倍率
// 就在这个字段里，同名模型仅靠它区分）。曾整体丢弃 → 下拉里两个同名模型
// 看起来一模一样（见 ConfigToolbar 的 "Hy3 / x0.00 credits" 实测案例）。

describe('parseConfigOptions', () => {
  it('keeps the description of each select option', () => {
    const raw = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'hy3-x',
        options: [
          { value: 'hy3', name: 'Hy3', description: 'x0.00 credits' },
          { value: 'hy3-x', name: 'Hy3', description: 'x0.05 credits' },
        ],
      },
    ]
    const opts = parseConfigOptions(raw)
    expect(opts).toHaveLength(1)
    // 同名两项各自的 description 都要在，且不能互相串
    expect(opts[0].options).toEqual([
      { value: 'hy3', name: 'Hy3', description: 'x0.00 credits' },
      { value: 'hy3-x', name: 'Hy3', description: 'x0.05 credits' },
    ])
  })

  it('omits the description key when absent, empty, or non-string', () => {
    const raw = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'a',
        options: [
          { value: 'a', name: 'A' },
          { value: 'b', name: 'B', description: '' },
          { value: 'c', name: 'C', description: null },
        ],
      },
    ]
    const opts = parseConfigOptions(raw)
    // 空/非法 description 不得落键（渲染层据此判空，避免渲染空节点）
    for (const o of opts[0].options) {
      expect(o).not.toHaveProperty('description')
    }
  })
})
