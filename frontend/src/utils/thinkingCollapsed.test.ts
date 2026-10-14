import { describe, it, expect } from 'vitest'
import {
  THINKING_COLLAPSED_MODES,
  THINKING_COLLAPSED_STORAGE_KEY,
  DEFAULT_THINKING_COLLAPSED_MODE,
  parseThinkingCollapsedMode,
  readThinkingCollapsedMode,
  thinkingPreviewLine,
} from './thinkingCollapsed'

// 思考块收起态档位的单一真源契约：选项数组顺序（= 面板按钮顺序）、白名单
// 存档解析（脏值回落默认，绝不把脏值当档位提交）、以及「显示简要」的单行
// 取行规则（最后一个非空行 / 空行回退 / 空文本）。

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

describe('thinkingPreviewLine', () => {
  it('returns the last line of a single-line thought', () => {
    expect(thinkingPreviewLine('先读一下配置文件')).toBe('先读一下配置文件')
  })

  it('returns the LAST line, not the first', () => {
    // 流式期间最后一行正是正在生长的那一行——预览要跟着它长。
    expect(thinkingPreviewLine('第一行\n第二行\n第三行')).toBe('第三行')
  })

  it('tracks the growing tail line as chunks arrive', () => {
    expect(thinkingPreviewLine('先看')).toBe('先看')
    expect(thinkingPreviewLine('先看\n再看')).toBe('再看')
    expect(thinkingPreviewLine('先看\n再看看')).toBe('再看看')
  })

  it('skips trailing blank lines left by paragraph breaks', () => {
    expect(thinkingPreviewLine('想了很久\n\n\n')).toBe('想了很久')
    expect(thinkingPreviewLine('A\nB\n\n\nC\n\n')).toBe('C')
  })

  it('trims surrounding whitespace on the picked line', () => {
    expect(thinkingPreviewLine('A\n   缩进的一行   ')).toBe('缩进的一行')
  })

  it('returns empty for blank / whitespace-only thoughts', () => {
    expect(thinkingPreviewLine('')).toBe('')
    expect(thinkingPreviewLine('\n\n')).toBe('')
    expect(thinkingPreviewLine('   \n\t\n')).toBe('')
  })

  it('handles CRLF line endings', () => {
    expect(thinkingPreviewLine('第一行\r\n第二行\r\n')).toBe('第二行')
  })

  it('does not truncate long lines (single-line clipping is the caller\'s job)', () => {
    const long = 'x'.repeat(5000)
    expect(thinkingPreviewLine(`短行\n${long}`)).toBe(long)
  })

  it('skips a long run of trailing blank lines without scanning the whole text', () => {
    // 末尾连续空行由一次尾部剥离吃掉，不需要向前逐行试错。
    const many = Array.from({ length: 200 }, () => '').join('\n')
    expect(thinkingPreviewLine(`内容\n${many}`)).toBe('内容')
  })
})
