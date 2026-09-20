import { describe, it, expect } from 'vitest'
import {
  DEFAULT_TERMINAL_ENGINE,
  ENGINE_PREF_STORAGE_KEY,
  parseTerminalEngine,
  readTerminalEnginePref,
  resolveTerminalEngine,
} from './terminalEngine'

/** 最小内存 Storage 替身——只实现本模块读到的两个方法。 */
function fakeStorage(entries: Record<string, string>): Storage {
  return {
    getItem: (k: string) => entries[k] ?? null,
    setItem: () => {},
  } as unknown as Storage
}

describe('parseTerminalEngine', () => {
  it('accepts only the two engine literals', () => {
    expect(parseTerminalEngine('pty')).toBe('pty')
    expect(parseTerminalEngine('tmux')).toBe('tmux')
  })

  it('rejects missing and corrupt values instead of passing them through', () => {
    expect(parseTerminalEngine(null)).toBeNull()
    expect(parseTerminalEngine('')).toBeNull()
    expect(parseTerminalEngine('acp')).toBeNull()
    expect(parseTerminalEngine('TMUX')).toBeNull()
  })
})

describe('readTerminalEnginePref', () => {
  it('defaults to tmux when nothing is stored (pty is still beta)', () => {
    expect(readTerminalEnginePref(fakeStorage({}))).toBe(DEFAULT_TERMINAL_ENGINE)
    expect(DEFAULT_TERMINAL_ENGINE).toBe('tmux')
  })

  it('prefers the current key over the legacy last-used key', () => {
    expect(
      readTerminalEnginePref(
        fakeStorage({ [ENGINE_PREF_STORAGE_KEY]: 'pty', omniterm_last_terminal_engine: 'tmux' }),
      ),
    ).toBe('pty')
  })

  it('inherits the legacy last-used value once, so existing users keep their engine', () => {
    expect(readTerminalEnginePref(fakeStorage({ omniterm_last_terminal_engine: 'pty' }))).toBe('pty')
  })

  it('falls through to the default when both keys hold garbage', () => {
    expect(
      readTerminalEnginePref(
        fakeStorage({ [ENGINE_PREF_STORAGE_KEY]: 'nope', omniterm_last_terminal_engine: 'nope' }),
      ),
    ).toBe(DEFAULT_TERMINAL_ENGINE)
  })
})

describe('resolveTerminalEngine', () => {
  it('keeps tmux only when the host actually has a multiplexer', () => {
    expect(resolveTerminalEngine('tmux', true)).toBe('tmux')
    expect(resolveTerminalEngine('tmux', false)).toBe('pty')
  })

  it('never upgrades an explicit pty preference', () => {
    expect(resolveTerminalEngine('pty', true)).toBe('pty')
    expect(resolveTerminalEngine('pty', false)).toBe('pty')
  })
})
