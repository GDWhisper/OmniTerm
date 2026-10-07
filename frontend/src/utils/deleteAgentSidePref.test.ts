import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readDeleteAgentSidePref, writeDeleteAgentSidePref } from './deleteAgentSidePref'

/**
 * 勾选框记忆的契约：**首次不勾选**（不可逆操作的安全默认），用户明确选择后
 * 沿用。jsdom 提供真实 localStorage，每个用例前清空。
 */
describe('deleteAgentSidePref', () => {
  const KEY = 'omniterm_delete_agent_side'

  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('defaults to unchecked when nothing is stored', () => {
    expect(readDeleteAgentSidePref()).toBe(false)
  })

  it('remembers an explicit opt-in', () => {
    writeDeleteAgentSidePref(true)
    expect(localStorage.getItem(KEY)).toBe('true')
    expect(readDeleteAgentSidePref()).toBe(true)
  })

  it('remembers an explicit opt-out (checking then unchecking sticks)', () => {
    writeDeleteAgentSidePref(true)
    writeDeleteAgentSidePref(false)
    expect(readDeleteAgentSidePref()).toBe(false)
  })

  it('treats corrupted values as unchecked (safe default)', () => {
    localStorage.setItem(KEY, 'yes')
    expect(readDeleteAgentSidePref()).toBe(false)
  })

  it('does not throw when localStorage read/write throws (privacy mode)', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => writeDeleteAgentSidePref(true)).not.toThrow()
    expect(readDeleteAgentSidePref()).toBe(false)
    getItem.mockRestore()
    setItem.mockRestore()
  })
})
