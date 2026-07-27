import { describe, it, expect } from 'vitest'
import { findAtToken, replaceAtToken } from './atReference'

describe('findAtToken', () => {
  it('detects @ at start of text', () => {
    expect(findAtToken('@src', 4)).toEqual({ start: 0, query: 'src' })
  })

  it('detects @ after whitespace', () => {
    expect(findAtToken('look at @src/ma', 15)).toEqual({ start: 8, query: 'src/ma' })
  })

  it('detects @ after newline', () => {
    expect(findAtToken('line1\n@a', 8)).toEqual({ start: 6, query: 'a' })
  })

  it('returns empty query right after @', () => {
    expect(findAtToken('hello @', 7)).toEqual({ start: 6, query: '' })
  })

  it('rejects email-like @ (preceded by non-whitespace)', () => {
    expect(findAtToken('user@example', 12)).toBeNull()
  })

  it('rejects when whitespace after @ before cursor', () => {
    expect(findAtToken('@src ok', 7)).toBeNull()
  })

  it('rejects double @', () => {
    expect(findAtToken('@a@b', 4)).toBeNull()
  })

  it('returns null without @', () => {
    expect(findAtToken('no token', 8)).toBeNull()
  })

  it('only considers text before cursor', () => {
    expect(findAtToken('@abc', 2)).toEqual({ start: 0, query: 'a' })
  })
})

describe('replaceAtToken', () => {
  it('replaces token and appends trailing space', () => {
    expect(replaceAtToken('see @sr', 4, 7, 'src/main.rs')).toEqual({
      text: 'see @src/main.rs ',
      cursor: 17,
    })
  })

  it('preserves text after cursor', () => {
    expect(replaceAtToken('@sr tail', 0, 3, 'src')).toEqual({
      text: '@src  tail',
      cursor: 5,
    })
  })

  it('handles empty query', () => {
    expect(replaceAtToken('hi @', 3, 4, 'a.txt')).toEqual({
      text: 'hi @a.txt ',
      cursor: 10,
    })
  })
})
