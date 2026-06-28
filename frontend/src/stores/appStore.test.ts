import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from './appStore'

describe('appStore mobile state', () => {
  beforeEach(() => {
    useAppStore.setState({
      isMobile: false,
      activeTab: 'terminal',
      mobileGestureEnabled: true,
      mobileFontSize: 13,
      mobileLastTab: 'terminal',
    })
  })

  it('defaults mobile font size to 13', () => {
    expect(useAppStore.getState().mobileFontSize).toBe(13)
  })

  it('toggles mobile gesture enabled', () => {
    useAppStore.getState().setMobileGestureEnabled(false)
    expect(useAppStore.getState().mobileGestureEnabled).toBe(false)
  })

  it('clamps mobile font size between 12 and 20', () => {
    useAppStore.getState().setMobileFontSize(8)
    expect(useAppStore.getState().mobileFontSize).toBe(12)
    useAppStore.getState().setMobileFontSize(25)
    expect(useAppStore.getState().mobileFontSize).toBe(20)
  })
})
