import { describe, it, expect, beforeEach } from 'vitest'
import {
  MAX_TRACKED_SCROLL_MEMORIES,
  clearAllChatScrollMemory,
  clearChatScrollMemory,
  getChatScrollMemory,
  setChatScrollMemory,
} from './chatScrollMemory'

describe('chatScrollMemory', () => {
  beforeEach(() => {
    clearAllChatScrollMemory()
  })

  it('set / get / clear 往返，缺失返回 null', () => {
    expect(getChatScrollMemory('s1')).toBeNull()
    setChatScrollMemory('s1', 800)
    expect(getChatScrollMemory('s1')).toBe(800)
    clearChatScrollMemory('s1')
    expect(getChatScrollMemory('s1')).toBeNull()
    // 清除不存在的条目是幂等空操作。
    clearChatScrollMemory('nope')
    expect(getChatScrollMemory('nope')).toBeNull()
  })

  it('负数夹到 0（scrollTop 语义），空 id 忽略', () => {
    setChatScrollMemory('s1', -20)
    expect(getChatScrollMemory('s1')).toBe(0)
    setChatScrollMemory('', 100)
    expect(getChatScrollMemory('')).toBeNull()
  })

  it('有界：超过上限淘汰最久未写，表大小恒为上限', () => {
    for (let i = 0; i < MAX_TRACKED_SCROLL_MEMORIES; i++) {
      setChatScrollMemory(`s${i}`, i)
    }
    expect(getChatScrollMemory('s0')).toBe(0)
    setChatScrollMemory('overflow', 999)
    expect(getChatScrollMemory('s0')).toBeNull()
    expect(getChatScrollMemory('s1')).toBe(1)
    expect(getChatScrollMemory('overflow')).toBe(999)
    // 仍只有上限条（淘汰一条、新增一条）。
    let count = 0
    for (let i = 0; i < MAX_TRACKED_SCROLL_MEMORIES + 1; i++) {
      if (getChatScrollMemory(`s${i}`) !== null) count++
    }
    expect(count).toBe(MAX_TRACKED_SCROLL_MEMORIES - 1)
  })

  it('重写刷新新鲜度：被淘汰的变成第二旧，而非重写项', () => {
    for (let i = 0; i < MAX_TRACKED_SCROLL_MEMORIES; i++) {
      setChatScrollMemory(`s${i}`, i)
    }
    // s0 最旧，重写一次后应排到最后。
    setChatScrollMemory('s0', 42)
    setChatScrollMemory('overflow', 999)
    expect(getChatScrollMemory('s0')).toBe(42)
    expect(getChatScrollMemory('s1')).toBeNull()
  })

  it('clearAll 全清（测试隔离契约）', () => {
    setChatScrollMemory('s1', 1)
    setChatScrollMemory('s2', 2)
    clearAllChatScrollMemory()
    expect(getChatScrollMemory('s1')).toBeNull()
    expect(getChatScrollMemory('s2')).toBeNull()
  })
})
