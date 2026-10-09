import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  DEFAULT_THINKING_EFFECT,
  THINKING_EFFECT_ENABLED_STORAGE_KEY,
  THINKING_EFFECT_RENDERERS,
  THINKING_EFFECT_STORAGE_KEY,
  THINKING_EFFECTS,
  parseThinkingEffectId,
  readThinkingEffectId,
} from './thinkingEffects'

/** 最小内存 Storage 替身——只实现本模块读到的方法。 */
function fakeStorage(entries: Record<string, string>): Storage {
  return {
    getItem: (k: string) => entries[k] ?? null,
    setItem: () => {},
  } as unknown as Storage
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseThinkingEffectId', () => {
  it('accepts every registered effect literal', () => {
    for (const effect of THINKING_EFFECTS) {
      expect(parseThinkingEffectId(effect.id)).toBe(effect.id)
    }
  })

  it('rejects missing and corrupt values instead of passing them through', () => {
    expect(parseThinkingEffectId(null)).toBeNull()
    expect(parseThinkingEffectId('')).toBeNull()
    expect(parseThinkingEffectId('hex')).toBeNull()
    expect(parseThinkingEffectId('Braille')).toBeNull()
  })
})

describe('readThinkingEffectId', () => {
  it('defaults to the scramble effect when nothing is stored', () => {
    expect(readThinkingEffectId(fakeStorage({}))).toBe(DEFAULT_THINKING_EFFECT)
    expect(DEFAULT_THINKING_EFFECT).toBe('scramble')
  })

  it('reads a valid stored choice', () => {
    expect(readThinkingEffectId(fakeStorage({ [THINKING_EFFECT_STORAGE_KEY]: 'braille' }))).toBe('braille')
  })

  it('self-heals corrupt stored values to the default', () => {
    expect(readThinkingEffectId(fakeStorage({ [THINKING_EFFECT_STORAGE_KEY]: 'glitch' }))).toBe(
      DEFAULT_THINKING_EFFECT,
    )
  })
})

describe('thinking effect registry', () => {
  it('keeps options and renderers in one-to-one correspondence', () => {
    const ids = THINKING_EFFECTS.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(Object.keys(THINKING_EFFECT_RENDERERS).sort()).toEqual([...ids].sort())
    // 展示名 key 统一走 settings.thinkingEffect.*（翻译在两个 locale 里）。
    for (const effect of THINKING_EFFECTS) {
      expect(effect.labelKey).toMatch(/^settings\.thinkingEffect\./)
    }
    // 存档键是常量导出，防止调用方手写字符串漂移。
    expect(THINKING_EFFECT_STORAGE_KEY).toBe('omniterm_thinking_effect')
    expect(THINKING_EFFECT_ENABLED_STORAGE_KEY).toBe('omniterm_thinking_effect_enabled')
  })
})

describe('scramble renderer', () => {
  const render = THINKING_EFFECT_RENDERERS.scramble

  it('grows the noise length across the elapsed-time tiers', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(render(0)).toHaveLength(16)
    expect(render(2_999)).toHaveLength(16)
    expect(render(3_000)).toHaveLength(24)
    expect(render(9_999)).toHaveLength(24)
    expect(render(10_000)).toHaveLength(36)
    expect(render(29_999)).toHaveLength(36)
    expect(render(30_000)).toHaveLength(54)
    expect(render(10 * 60_000)).toHaveLength(54)
  })

  it('emits only lowercase hex characters', () => {
    for (const elapsed of [0, 5_000, 20_000, 60_000]) {
      expect(render(elapsed)).toMatch(/^[0-9a-f]+$/)
    }
  })
})

describe('spinner renderer', () => {
  const render = THINKING_EFFECT_RENDERERS.spinner

  it('cycles ◐◓◑◒ on a 120ms beat and loops every 4 frames', () => {
    expect(render(0)).toBe('◐')
    expect(render(119)).toBe('◐')
    expect(render(120)).toBe('◓')
    expect(render(240)).toBe('◑')
    expect(render(360)).toBe('◒')
    expect(render(480)).toBe('◐')
  })
})

describe('braille renderer', () => {
  const render = THINKING_EFFECT_RENDERERS.braille

  it('cycles the 10-frame braille spinner on an 80ms beat and loops', () => {
    expect(render(0)).toBe('⠋')
    expect(render(79)).toBe('⠋')
    expect(render(80)).toBe('⠙')
    expect(render(720)).toBe('⠏')
    expect(render(800)).toBe('⠋')
  })
})
