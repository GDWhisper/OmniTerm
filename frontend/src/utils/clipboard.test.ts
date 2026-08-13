import { describe, it, expect, vi, afterEach } from 'vitest'
import { copyText } from './clipboard'

describe('copyText', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // 恢复 navigator.clipboard 原始状态
    const nav = navigator as Navigator & { clipboard?: Clipboard }
    if (!('clipboard' in nav)) {
      Object.defineProperty(nav, 'clipboard', { value: undefined, configurable: true })
    }
  })

  it('安全上下文：优先走 navigator.clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
  })

  it('navigator.clipboard 缺失：回退 textarea + execCommand', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    })
    const execCommand = vi.fn().mockReturnValue(true)
    document.execCommand = execCommand as typeof document.execCommand

    await expect(copyText('fallback text')).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('navigator.clipboard.writeText 抛错：回退 execCommand', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const execCommand = vi.fn().mockReturnValue(true)
    document.execCommand = execCommand as typeof document.execCommand

    await expect(copyText('retry')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('retry')
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('两条路径都失败：返回 false（不抛异常）', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const execCommand = vi.fn().mockReturnValue(false)
    document.execCommand = execCommand as typeof document.execCommand

    await expect(copyText('doomed')).resolves.toBe(false)
  })

  it('空字符串直接成功，不触碰 clipboard API', async () => {
    const writeText = vi.fn()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    await expect(copyText('')).resolves.toBe(true)
    expect(writeText).not.toHaveBeenCalled()
  })
})
