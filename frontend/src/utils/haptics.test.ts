import { describe, it, expect, vi, afterEach } from 'vitest'
import { hapticTap, HAPTIC_TAP_MS } from './haptics'
import { useAppStore } from '../stores/appStore'

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState({ mobileHapticEnabled: true })
})

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
  it('does not vibrate when mobileHapticEnabled is off', () => {
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    useAppStore.setState({ mobileHapticEnabled: false })
    hapticTap()
    expect(vibrate).not.toHaveBeenCalled()
  })
})
