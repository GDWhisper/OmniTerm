import { describe, expect, it } from 'vitest'
import { isTerminalAutoResponse } from './ptyInputFilter'

describe('isTerminalAutoResponse', () => {
  it('拦截 DA1 应答（1;2c 回显问题的直接来源）', () => {
    expect(isTerminalAutoResponse('\x1b[?1;2c')).toBe(true)
    expect(isTerminalAutoResponse('\x1b[?6c')).toBe(true)
  })

  it('拦截 DA2 应答（全部终端类型形态）', () => {
    expect(isTerminalAutoResponse('\x1b[>0;276;0c')).toBe(true) // xterm
    expect(isTerminalAutoResponse('\x1b[>85;95;0c')).toBe(true) // rxvt-unicode
    expect(isTerminalAutoResponse('\x1b[>83;40003;0c')).toBe(true) // screen
  })

  it('拦截光标位置应答（CPR / DECXCPR）', () => {
    expect(isTerminalAutoResponse('\x1b[24;80R')).toBe(true)
    expect(isTerminalAutoResponse('\x1b[?24;80R')).toBe(true)
  })

  it('拦截 DSR-OS / DECRPM / 窗口尺寸应答', () => {
    expect(isTerminalAutoResponse('\x1b[0n')).toBe(true)
    expect(isTerminalAutoResponse('\x1b[?2026;2$y')).toBe(true)
    expect(isTerminalAutoResponse('\x1b[8;40;120t')).toBe(true)
  })

  it('拦截 OSC 颜色应答（ST 与 BEL 两种结尾）', () => {
    expect(isTerminalAutoResponse('\x1b]11;rgb:1e1e/2e2e/3e3e\x1b\\')).toBe(true)
    expect(isTerminalAutoResponse('\x1b]4;1;rgb:ffff/0000/0000\x07')).toBe(true)
    expect(isTerminalAutoResponse('\x1b]10;rgb:ffff/ffff/ffff\x07')).toBe(true)
  })

  it('放行用户键盘输入的转义序列', () => {
    expect(isTerminalAutoResponse('\x1b[A')).toBe(false) // ↑
    expect(isTerminalAutoResponse('\x1bOB')).toBe(false) // ↓ (application cursor)
    expect(isTerminalAutoResponse('\x1b[1;5A')).toBe(false) // Ctrl+↑
    expect(isTerminalAutoResponse('\x1bOP')).toBe(false) // F1
    expect(isTerminalAutoResponse('\x1b')).toBe(false) // 裸 ESC
    expect(isTerminalAutoResponse('\x1b\r')).toBe(false) // Alt+Enter
    expect(isTerminalAutoResponse('\r')).toBe(false)
    expect(isTerminalAutoResponse('a')).toBe(false)
    expect(isTerminalAutoResponse('你好')).toBe(false)
  })

  it('放行鼠标协议上报（tmux mouse mode 的合法输入）', () => {
    expect(isTerminalAutoResponse('\x1b[<0;10;5M')).toBe(false) // SGR press
    expect(isTerminalAutoResponse('\x1b[<0;10;5m')).toBe(false) // SGR release
    expect(isTerminalAutoResponse('\x1b[M !!')).toBe(false) // X10 编码
    expect(isTerminalAutoResponse('\x1b[<64;10;5M')).toBe(false) // SGR wheel
  })

  it('放行 DECRQSS/DCS 应答（后端不应答，前端是 tmux 探测唯一来源）', () => {
    expect(isTerminalAutoResponse('\x1bP1$q0m\x1b\\')).toBe(false)
    expect(isTerminalAutoResponse('\x1bP!|46414839\x1b\\')).toBe(false)
  })

  it('放行恰好在应答形态附近的普通文本', () => {
    // 缺失/多余的 ESC、参数不全等都不算应答
    expect(isTerminalAutoResponse('[?1;2c')).toBe(false)
    expect(isTerminalAutoResponse('\x1b[?1;2cextra')).toBe(false)
    expect(isTerminalAutoResponse('prefix\x1b[?1;2c')).toBe(false)
    expect(isTerminalAutoResponse('\x1b[?1;2')).toBe(false)
  })
})
