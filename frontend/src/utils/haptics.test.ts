import { describe, it, expect, vi, afterEach } from 'vitest'
import { hapticTap, HAPTIC_TAP_MS } from './haptics'

afterEach(() => vi.unstubAllGlobals())

describe('hapticTap', () => {
  it('calls navigator.vibrate with default duration', () => {
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    hapticTap()
    expect(vibrate).toHaveBeenCalledWith(HAPTIC_TAP_MS)
  })
  it('is a silent no-op when vibrate is unsupported (iOS Safari)', () => {
    vi.stubGlobal('navigator', {})
    expect(() => hapticTap()).not.toThrow()
  })
})
