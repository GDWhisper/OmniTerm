/**
 * ACP 等待特效（消息流底部 `ThinkingIndicator`）的单一真源。
 *
 * 「等待 agent 输出」指示器的动画样式收在这里：选项数组（顺序即设置面板
 * 按钮顺序）、每个特效的帧生成器（纯函数：输入已等待毫秒，输出该时刻要
 * 显示的文本）与 localStorage 存档键。组件只负责 rAF 调度与 DOM 直写，
 * 不携带任何特效逻辑。
 *
 * 新增一个特效 = ① 本文件 `THINKING_EFFECTS` 加一条、
 * `THINKING_EFFECT_RENDERERS` 加对应生成器；② 两个 translation.json
 * （en/zh）加 `settings.thinkingEffect.<id>` 的展示名 key。
 * 其余（store、设置面板、组件）零改动。
 */

export type ThinkingEffectId = 'scramble' | 'spinner' | 'braille'

export interface ThinkingEffectOption {
  id: ThinkingEffectId
  labelKey: string
}

/** 选项数组，顺序即设置面板展示顺序（乱码流为默认，排最前）。 */
export const THINKING_EFFECTS: readonly ThinkingEffectOption[] = [
  { id: 'scramble', labelKey: 'settings.thinkingEffect.scramble' },
  { id: 'spinner', labelKey: 'settings.thinkingEffect.spinner' },
  { id: 'braille', labelKey: 'settings.thinkingEffect.braille' },
]

export const DEFAULT_THINKING_EFFECT: ThinkingEffectId = 'scramble'

/** 特效选择存档键。 */
export const THINKING_EFFECT_STORAGE_KEY = 'omniterm_thinking_effect'

/** 总开关存档键（默认开：只有显式存 'false' 才关闭）。 */
export const THINKING_EFFECT_ENABLED_STORAGE_KEY = 'omniterm_thinking_effect_enabled'

/** 严格白名单：存档值损坏时回落 null，绝不把脏值当特效提交。 */
export function parseThinkingEffectId(raw: string | null): ThinkingEffectId | null {
  return raw === 'scramble' || raw === 'spinner' || raw === 'braille' ? raw : null
}

/** 读取特效选择：白名单校验后回落默认（乱码流）。 */
export function readThinkingEffectId(storage: Storage = localStorage): ThinkingEffectId {
  return parseThinkingEffectId(storage.getItem(THINKING_EFFECT_STORAGE_KEY)) ?? DEFAULT_THINKING_EFFECT
}

/** 帧索引：elapsedMs 时刻对应的帧号（按 frameMs 节拍循环）。 */
function frameAt(elapsedMs: number, frameMs: number, frameCount: number): number {
  return Math.floor(elapsedMs / frameMs) % frameCount
}

/* ── 乱码流（"decoding" noise：随机 hex，永不锁定出可读文本） ── */

const SCRAMBLE_HEX_CHARS = '0123456789abcdef'

/** 长度档：等待越久噪声越长（数据化原三元链，改档位只改本表）。 */
const SCRAMBLE_LENGTH_TIERS: readonly { untilMs: number; length: number }[] = [
  { untilMs: 3_000, length: 16 },
  { untilMs: 10_000, length: 24 },
  { untilMs: 30_000, length: 36 },
  { untilMs: Infinity, length: 54 },
]

function scrambleFrame(elapsedMs: number): string {
  let len = SCRAMBLE_LENGTH_TIERS[SCRAMBLE_LENGTH_TIERS.length - 1].length
  for (const tier of SCRAMBLE_LENGTH_TIERS) {
    if (elapsedMs < tier.untilMs) {
      len = tier.length
      break
    }
  }
  let s = ''
  for (let i = 0; i < len; i++) {
    s += SCRAMBLE_HEX_CHARS[(Math.random() * SCRAMBLE_HEX_CHARS.length) | 0]
  }
  return s
}

/* ── 经典转圈 ── */

const SPINNER_FRAMES = '◐◓◑◒'
const SPINNER_FRAME_MS = 120

function spinnerFrame(elapsedMs: number): string {
  return SPINNER_FRAMES[frameAt(elapsedMs, SPINNER_FRAME_MS, SPINNER_FRAMES.length)]
}

/* ── 盲文点阵（braille spinner，ora 默认形态） ── */

const BRAILLE_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const BRAILLE_FRAME_MS = 80

function brailleFrame(elapsedMs: number): string {
  return BRAILLE_FRAMES[frameAt(elapsedMs, BRAILLE_FRAME_MS, BRAILLE_FRAMES.length)]
}

/** 渲染器：输入已等待毫秒，输出该时刻应显示的文本（纯函数，勿引入副作用）。 */
export type ThinkingEffectRenderer = (elapsedMs: number) => string

export const THINKING_EFFECT_RENDERERS: Record<ThinkingEffectId, ThinkingEffectRenderer> = {
  scramble: scrambleFrame,
  spinner: spinnerFrame,
  braille: brailleFrame,
}
