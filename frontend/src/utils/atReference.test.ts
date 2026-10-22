import { describe, it, expect } from 'vitest'
import { findAtToken, insertAtReferences, isAtReferenceSafePath, replaceAtToken } from './atReference'

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

describe('insertAtReferences', () => {
  it('inserts at the start without a leading space', () => {
    expect(insertAtReferences('', 0, 0, ['src/main.rs'])).toEqual({
      text: '@src/main.rs ',
      cursor: 13,
    })
  })

  it('adds a leading space when the caret follows a non-whitespace character', () => {
    expect(insertAtReferences('hello world', 5, 5, ['src/a.ts'])).toEqual({
      text: 'hello @src/a.ts  world',
      cursor: 16,
    })
  })

  it('does not add a leading space after existing whitespace', () => {
    expect(insertAtReferences('see ', 4, 4, ['a.ts'])).toEqual({
      text: 'see @a.ts ',
      cursor: 10,
    })
  })

  it('replaces the selected range and preserves trailing text', () => {
    expect(insertAtReferences('hello world', 0, 5, ['a.ts'])).toEqual({
      text: '@a.ts  world',
      cursor: 6,
    })
  })

  it('inserts multiple paths separated by spaces', () => {
    expect(insertAtReferences('', 0, 0, ['a.ts', 'b.ts'])).toEqual({
      text: '@a.ts @b.ts ',
      cursor: 12,
    })
  })

  it('replaces an active @ token', () => {
    const text = 'look @src'
    const token = findAtToken(text, text.length)!
    expect(insertAtReferences(text, token.start, text.length, ['src/main.rs'])).toEqual({
      text: 'look @src/main.rs ',
      cursor: 18,
    })
  })

  it('returns the text unchanged for an empty path list', () => {
    expect(insertAtReferences('abc', 1, 2, [])).toEqual({ text: 'abc', cursor: 1 })
  })
})

describe('isAtReferenceSafePath', () => {
  it('accepts workspace-relative paths', () => {
    expect(isAtReferenceSafePath('src/main.rs')).toBe(true)
    expect(isAtReferenceSafePath('./docs/plan.md')).toBe(true)
  })

  it('rejects empty, whitespace, and @ paths', () => {
    expect(isAtReferenceSafePath('')).toBe(false)
    expect(isAtReferenceSafePath('a b.ts')).toBe(false)
    expect(isAtReferenceSafePath('a\tb.ts')).toBe(false)
    expect(isAtReferenceSafePath('a\nb.ts')).toBe(false)
    expect(isAtReferenceSafePath('a@b.ts')).toBe(false)
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
