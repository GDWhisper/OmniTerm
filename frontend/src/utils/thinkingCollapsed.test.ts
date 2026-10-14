import { describe, it, expect } from 'vitest'
import {
  THINKING_COLLAPSED_MODES,
  THINKING_COLLAPSED_STORAGE_KEY,
  DEFAULT_THINKING_COLLAPSED_MODE,
  parseThinkingCollapsedMode,
  readThinkingCollapsedMode,
  THINKING_AUTO_COLLAPSE_STORAGE_KEY,
  DEFAULT_THINKING_AUTO_COLLAPSE,
  readThinkingAutoCollapse,
  resolveThinkingStreamingSummary,
} from './thinkingCollapsed'

// 思考块展示行为的单一真源契约：收起态档位（选项数组顺序 = 面板按钮顺序、
// 白名单存档解析——脏值回落默认，绝不把脏值当档位提交、「显示简要」的单行
// 取行规则），以及「完成后自动折叠」开关（默认开，只有显式 'false' 才关）。

describe('thinkingCollapsed 档位注册表', () => {
  it('exposes exactly two modes with 完全隐藏 first', () => {
    expect(THINKING_COLLAPSED_MODES.map((m) => m.id)).toEqual(['hide', 'brief'])
    expect(DEFAULT_THINKING_COLLAPSED_MODE).toBe('hide')
  })

  it('every mode carries a settings i18n label key', () => {
    for (const m of THINKING_COLLAPSED_MODES) {
      expect(m.labelKey).toMatch(/^settings\.thinkingCollapsed/)
    }
  })

  it('storage key is namespaced under omniterm_', () => {
    expect(THINKING_COLLAPSED_STORAGE_KEY).toBe('omniterm_thinking_collapsed')
  })
})

describe('parseThinkingCollapsedMode', () => {
  it('accepts the two known modes', () => {
    expect(parseThinkingCollapsedMode('hide')).toBe('hide')
    expect(parseThinkingCollapsedMode('brief')).toBe('brief')
  })

  it('rejects missing / unknown / empty values', () => {
    expect(parseThinkingCollapsedMode(null)).toBeNull()
    expect(parseThinkingCollapsedMode('')).toBeNull()
    expect(parseThinkingCollapsedMode('summary')).toBeNull()
    expect(parseThinkingCollapsedMode('HIDE')).toBeNull()
  })
})

describe('readThinkingCollapsedMode', () => {
  function storageWith(value: string | null): Storage {
    const map = new Map<string, string>()
    if (value !== null) map.set(THINKING_COLLAPSED_STORAGE_KEY, value)
    return {
      get length() { return map.size },
      clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null,
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      removeItem: (k: string) => { map.delete(k) },
      setItem: (k: string, v: string) => { map.set(k, String(v)) },
    } as Storage
  }

  it('reads a stored mode verbatim', () => {
    expect(readThinkingCollapsedMode(storageWith('brief'))).toBe('brief')
    expect(readThinkingCollapsedMode(storageWith('hide'))).toBe('hide')
  })

  it('falls back to 完全隐藏 when missing or corrupt', () => {
    expect(readThinkingCollapsedMode(storageWith(null))).toBe('hide')
    expect(readThinkingCollapsedMode(storageWith('nonsense'))).toBe('hide')
  })
})

describe('readThinkingAutoCollapse', () => {
  // 本项的存档读取与档位不同：默认值为 true，故判 `!== 'false'`——只有显式存过
  // 'false' 才关，其余（缺省 / 脏值）一律回落默认。测试要同时锁住这两侧，
  // 否则有人把它「顺手改成 === 'true'」会让缺省用户静默丢掉该功能。
  function storageWith(value: string | null): Storage {
    const map = new Map<string, string>()
    if (value !== null) map.set(THINKING_AUTO_COLLAPSE_STORAGE_KEY, value)
    return {
      get length() { return map.size },
      clear: () => map.clear(),
      getItem: (k: string) => map.get(k) ?? null,
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      removeItem: (k: string) => { map.delete(k) },
      setItem: (k: string, v: string) => { map.set(k, String(v)) },
    } as Storage
  }

  it('storage key is namespaced under omniterm_', () => {
    expect(THINKING_AUTO_COLLAPSE_STORAGE_KEY).toBe('omniterm_thinking_autocollapse')
  })

  it('defaults to ON', () => {
    expect(DEFAULT_THINKING_AUTO_COLLAPSE).toBe(true)
  })

  it('honours an explicitly stored value', () => {
    expect(readThinkingAutoCollapse(storageWith('true'))).toBe(true)
    expect(readThinkingAutoCollapse(storageWith('false'))).toBe(false)
  })

  it('falls back to ON when missing or corrupt', () => {
    // 缺省与脏值都回落默认（开）：宁可多折一次让用户点开，也不要因为一个
    // 脏值把功能静默关掉。
    expect(readThinkingAutoCollapse(storageWith(null))).toBe(true)
    expect(readThinkingAutoCollapse(storageWith('nonsense'))).toBe(true)
    expect(readThinkingAutoCollapse(storageWith(''))).toBe(true)
    expect(readThinkingAutoCollapse(storageWith('TRUE'))).toBe(true)
  })
})

describe('resolveThinkingStreamingSummary', () => {
  it('returns the last line of a single-line thought', () => {
    expect(resolveThinkingStreamingSummary('先读一下配置文件')?.text).toBe('先读一下配置文件')
  })

  it('returns the LAST line, not the first', () => {
    // 流式期间最后一行正是正在生长的那一行——预览要跟着它长。
    expect(resolveThinkingStreamingSummary('第一行\n第二行\n第三行')?.text).toBe('第三行')
  })

  it('tracks the growing tail line as chunks arrive', () => {
    expect(resolveThinkingStreamingSummary('先看')?.text).toBe('先看')
    expect(resolveThinkingStreamingSummary('先看\n再看')?.text).toBe('再看')
    expect(resolveThinkingStreamingSummary('先看\n再看看')?.text).toBe('再看看')
  })

  it('skips trailing blank lines left by paragraph breaks', () => {
    expect(resolveThinkingStreamingSummary('想了很久\n\n\n')?.text).toBe('想了很久')
    expect(resolveThinkingStreamingSummary('A\nB\n\n\nC\n\n')?.text).toBe('C')
  })

  it('trims surrounding whitespace on the picked line', () => {
    expect(resolveThinkingStreamingSummary('A\n   缩进的一行   ')?.text).toBe('缩进的一行')
  })

  it('returns null for blank / whitespace-only thoughts', () => {
    // null 而不是空串：调用方据此整个不渲染预览行。
    expect(resolveThinkingStreamingSummary('')).toBeNull()
    expect(resolveThinkingStreamingSummary('\n\n')).toBeNull()
    expect(resolveThinkingStreamingSummary('   \n\t\n')).toBeNull()
  })

  it('handles CRLF line endings', () => {
    expect(resolveThinkingStreamingSummary('第一行\r\n第二行\r\n')?.text).toBe('第二行')
  })

  it('does not truncate long lines (single-line clipping is the caller\'s job)', () => {
    const long = 'x'.repeat(5000)
    expect(resolveThinkingStreamingSummary(`短行\n${long}`)?.text).toBe(long)
  })

  it('skips a long run of trailing blank lines without scanning the whole text', () => {
    // 末尾连续空行由一次尾部剥离吃掉，不需要向前逐行试错。
    const many = Array.from({ length: 200 }, () => '').join('\n')
    expect(resolveThinkingStreamingSummary(`内容\n${many}`)?.text).toBe('内容')
  })

  // --- key 语义：驱动「换行时纵向滚入」动画 ---

  it('keys the summary by the line start offset', () => {
    // '第一行' 占 3 字符 + 换行符 → 第二行从偏移 4 起。
    expect(resolveThinkingStreamingSummary('第一行\n第二行')).toEqual({ key: '4', text: '第二行' })
    expect(resolveThinkingStreamingSummary('先看\n再看')).toEqual({ key: '3', text: '再看' })
  })

  it('keeps the key stable while the same line grows', () => {
    // 同一行在流式生长期间 key 不变 → React 不重挂载、不重放滚入动画。
    const a = resolveThinkingStreamingSummary('先看\n再看')
    const b = resolveThinkingStreamingSummary('先看\n再看看')
    expect(a?.key).toBe(b?.key)
    expect(b?.text).toBe('再看看')
  })

  it('changes the key when the stream moves to a new line', () => {
    const before = resolveThinkingStreamingSummary('先看\n再看')
    const after = resolveThinkingStreamingSummary('先看\n再看\n新行')
    expect(after?.key).not.toBe(before?.key)
    expect(after?.text).toBe('新行')
  })
})
