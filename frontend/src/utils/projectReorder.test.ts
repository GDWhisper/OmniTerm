import { describe, it, expect } from 'vitest'
import { computeProjectReorder } from './projectReorder'

describe('computeProjectReorder', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('inserts the dragged id before the target', () => {
    expect(computeProjectReorder(ids, 'd', 'b', true)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('inserts the dragged id after the target', () => {
    expect(computeProjectReorder(ids, 'a', 'c', false)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('can move the first card to the end and back', () => {
    expect(computeProjectReorder(ids, 'a', 'd', false)).toEqual(['b', 'c', 'd', 'a'])
    expect(computeProjectReorder(['b', 'c', 'd', 'a'], 'a', 'b', true)).toEqual(ids)
  })

  it('is a permutation: every id survives exactly once', () => {
    const out = computeProjectReorder(ids, 'b', 'd', false)
    expect([...out].sort()).toEqual([...ids].sort())
  })

  it('returns an unchanged copy when dragging onto itself', () => {
    const out = computeProjectReorder(ids, 'b', 'b', true)
    expect(out).toEqual(ids)
    expect(out).not.toBe(ids)
  })

  it('returns an unchanged copy when the target is gone (store/DOM race)', () => {
    expect(computeProjectReorder(ids, 'a', 'ghost', true)).toEqual(ids)
  })

  it('does not mutate the input array', () => {
    const input = ['a', 'b', 'c']
    computeProjectReorder(input, 'c', 'a', true)
    expect(input).toEqual(['a', 'b', 'c'])
  })
})
