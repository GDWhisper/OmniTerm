import { describe, it, expect } from 'vitest'
import { decideSwipeAxis, applyEdgeResistance, resolveSwipeCommit, SWIPE_AXIS_SLOP_PX, SWIPE_COMMIT_PX, EDGE_RESISTANCE } from './swipe'

describe('decideSwipeAxis', () => {
  it('returns null below slop', () => {
    expect(decideSwipeAxis(5, 3)).toBeNull()
  })
  it('vertical wins when dy dominates', () => {
    expect(decideSwipeAxis(20, 40)).toBe('y')
  })
  it('horizontal wins when dx dominates', () => {
    expect(decideSwipeAxis(40, 20)).toBe('x')
  })
  it('slop threshold is exclusive boundary-safe', () => {
    expect(decideSwipeAxis(SWIPE_AXIS_SLOP_PX, 0)).toBe('x')
  })
})

describe('applyEdgeResistance', () => {
  it('passes through when neighbor exists', () => {
    expect(applyEdgeResistance(-80, true, true)).toBe(-80)
  })
  it('damps toward missing neighbor', () => {
    expect(applyEdgeResistance(80, false, true)).toBe(80 * EDGE_RESISTANCE) // prev missing
    expect(applyEdgeResistance(-80, true, false)).toBe(-80 * EDGE_RESISTANCE) // next missing
  })
})

describe('resolveSwipeCommit', () => {
  it('commits past threshold toward existing neighbor', () => {
    expect(resolveSwipeCommit(-(SWIPE_COMMIT_PX + 1), true, true)).toBe('next')
    expect(resolveSwipeCommit(SWIPE_COMMIT_PX + 1, true, true)).toBe('prev')
  })
  it('snaps back below threshold or toward missing neighbor', () => {
    expect(resolveSwipeCommit(-(SWIPE_COMMIT_PX - 1), true, true)).toBeNull()
    expect(resolveSwipeCommit(-200, true, false)).toBeNull()
    expect(resolveSwipeCommit(200, false, true)).toBeNull()
  })
})
