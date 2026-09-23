// mouseModeSyncSeq ↔ 真实 xterm 解析态契约（2026-09-23）：
// 生成的 DECSET 同步序列必须真的翻转 xterm 的 `term.modes.mouseTrackingMode`
// （wheel 放行分支读的就是这个解析态）——这是「前端写 DECSET 同步」修复的
// 底层契约，fake harness 模拟不了（fake 的 modes 是手动置值）。
// 风格照 useTerminal.unicode11.test.ts：直接 import @xterm/xterm，不 mock。
import { describe, it, expect } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { mouseModeSyncSeq } from './useTerminal'

async function write(term: Terminal, text: string): Promise<void> {
  await new Promise<void>(resolve => term.write(text, resolve))
}

function newTerm(): Terminal {
  return new Terminal({ cols: 20, rows: 4 })
}

/** 全量 reset 段（固定顺序）：tracking 9/1000/1002/1003 + encoding 1005/1006/1015。 */
const RESET = '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l'

describe('mouseModeSyncSeq 翻转真实 xterm 解析态', () => {
  it('press → mouseTrackingMode vt200', async () => {
    const term = newTerm()
    await write(term, mouseModeSyncSeq('press', 'default'))
    expect(term.modes.mouseTrackingMode).toBe('vt200')
  })

  it('drag → mouseTrackingMode drag', async () => {
    const term = newTerm()
    await write(term, mouseModeSyncSeq('drag', 'default'))
    expect(term.modes.mouseTrackingMode).toBe('drag')
  })

  it('motion → mouseTrackingMode any', async () => {
    const term = newTerm()
    await write(term, mouseModeSyncSeq('motion', 'default'))
    expect(term.modes.mouseTrackingMode).toBe('any')
  })

  it('从 motion 关到 none → mouseTrackingMode 回 none（全量 reset 段生效）', async () => {
    const term = newTerm()
    await write(term, mouseModeSyncSeq('motion', 'default'))
    expect(term.modes.mouseTrackingMode).toBe('any')
    await write(term, mouseModeSyncSeq('none', 'default'))
    expect(term.modes.mouseTrackingMode).toBe('none')
  })

  it('motion+sgr 组合同样翻转 tracking（encoding set 不破坏 tracking 解析）', async () => {
    const term = newTerm()
    await write(term, mouseModeSyncSeq('motion', 'sgr'))
    expect(term.modes.mouseTrackingMode).toBe('any')
  })

  it('序列形态固定：全量 reset + tracking set + encoding set', () => {
    expect(mouseModeSyncSeq('press', 'sgr')).toBe(RESET + '\x1b[?1000h\x1b[?1006h')
    expect(mouseModeSyncSeq('drag', 'utf8')).toBe(RESET + '\x1b[?1002h\x1b[?1005h')
    expect(mouseModeSyncSeq('none', 'default')).toBe(RESET)
  })
})
