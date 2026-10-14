import { describe, it, expect } from 'vitest'
import { fitFileTableColumns } from './fileTableLayout'

/**
 * 自适应列宽算式（X17）。关键事实：容器 ≥ 522px 时与 D5 原算式一致（差异
 * 仅为扣除滚动条占宽）；窄容器按 size → mtime → name 顺序收缩到各自下限；
 * 下限之和（364）加滚动条（8）即最小无溢出容器 372px，更窄时保持下限让
 * 表格横向滚动。
 */
describe('fitFileTableColumns', () => {
  // 未触底时：总宽 = name + mtime + size + actions(132) + 2 = 容器宽 - 滚动条(8)
  it('宽容器与 D5 原算式一致：name 吃剩余，mtime/size 取目标值', () => {
    expect(fitFileTableColumns(700)).toEqual({ name: 318, mtime: 140, size: 100 })
    // 不压缩的临界：可用额度恰为 mtime+size+minName
    expect(fitFileTableColumns(522)).toEqual({ name: 140, mtime: 140, size: 100 })
  })

  it('窄容器按优先级收缩：先 size、再 mtime、最后 name', () => {
    expect(fitFileTableColumns(520)).toEqual({ name: 140, mtime: 140, size: 98 })
    expect(fitFileTableColumns(450)).toEqual({ name: 140, mtime: 108, size: 60 })
    // 实测的默认右面板宽度：三列同压（总宽 90+80+60+132+2=364 = 372-8，零溢出）
    expect(fitFileTableColumns(372)).toEqual({ name: 90, mtime: 80, size: 60 })
  })

  it('下限之和不满足时保持下限（横向滚动兜底），不为负也不越下限', () => {
    expect(fitFileTableColumns(364)).toEqual({ name: 90, mtime: 80, size: 60 })
    expect(fitFileTableColumns(300)).toEqual({ name: 90, mtime: 80, size: 60 })
    expect(fitFileTableColumns(0)).toEqual({ name: 90, mtime: 80, size: 60 })
  })

  it('下载模式的复选框列参与预算扣减', () => {
    // 372 容器 + 32px 复选框列 ⇒ 等效于 340 的可用宽 → 与更窄容器同解
    expect(fitFileTableColumns(404, 32)).toEqual(fitFileTableColumns(372, 0))
    expect(fitFileTableColumns(700, 32)).toEqual({ name: 286, mtime: 140, size: 100 })
  })
})
