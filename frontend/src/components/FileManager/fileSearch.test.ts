import { describe, it, expect } from 'vitest'
import { computeMatches, MAX_SEARCH_MATCHES } from './fileSearch'

const opts = (query: string, caseSensitive = false, regex = false) => ({ query, caseSensitive, regex })

describe('computeMatches', () => {
  it('finds all substring matches, case-insensitive by default', () => {
    const result = computeMatches('Foo bar FOO foo', opts('foo'))
    expect(result).toEqual({
      matches: [
        { from: 0, to: 3 },
        { from: 8, to: 11 },
        { from: 12, to: 15 },
      ],
      invalid: false,
      truncated: false,
    })
  })

  it('respects case sensitivity when enabled', () => {
    const result = computeMatches('Foo bar FOO foo', opts('foo', true))
    expect(result.matches).toEqual([{ from: 12, to: 15 }])
  })

  it('returns no matches for empty query', () => {
    expect(computeMatches('anything', opts(''))).toEqual({
      matches: [],
      invalid: false,
      truncated: false,
    })
  })

  it('supports regex mode with ignorecase by default', () => {
    const result = computeMatches('a1b22c333', opts('\\d+', false, true))
    expect(result.matches).toEqual([
      { from: 1, to: 2 },
      { from: 3, to: 5 },
      { from: 6, to: 9 },
    ])
  })

  it('honors case sensitivity in regex mode', () => {
    expect(computeMatches('aA', opts('a', true, true)).matches).toEqual([{ from: 0, to: 1 }])
    expect(computeMatches('aA', opts('a', false, true)).matches).toHaveLength(2)
  })

  it('reports invalid regex instead of throwing', () => {
    // 用户输入到一半的正则（未闭合括号）不是错误状态，只停掉高亮
    const result = computeMatches('anything', opts('(', false, true))
    expect(result.invalid).toBe(true)
    expect(result.matches).toEqual([])
  })

  it('skips zero-length regex matches without hanging', () => {
    // `a*` 在 "baaab" 上：位置 0/4/5 都是零长匹配，只有 1..4 是真匹配
    const result = computeMatches('baaab', opts('a*', false, true))
    expect(result.matches).toEqual([{ from: 1, to: 4 }])
  })

  it('truncates at MAX_SEARCH_MATCHES', () => {
    const doc = 'ab'.repeat(MAX_SEARCH_MATCHES + 100)
    const result = computeMatches(doc, opts('ab'))
    expect(result.matches).toHaveLength(MAX_SEARCH_MATCHES)
    expect(result.truncated).toBe(true)
  })

  it('does not report truncation below the cap', () => {
    const doc = 'ab'.repeat(MAX_SEARCH_MATCHES - 1)
    const result = computeMatches(doc, opts('ab'))
    expect(result.matches).toHaveLength(MAX_SEARCH_MATCHES - 1)
    expect(result.truncated).toBe(false)
  })
})
