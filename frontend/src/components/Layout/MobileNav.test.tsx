import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MobileNav } from './MobileNav'
import { useAppStore } from '../../stores/appStore'

describe('MobileNav', () => {
  it('renders three nav buttons', async () => {
    useAppStore.setState({ activeTab: 'terminal' })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    root.render(<MobileNav />)
    await vi.waitFor(() => {
      const buttons = container.querySelectorAll('button')
      expect(buttons.length).toBe(3)
    })
    root.unmount()
    document.body.removeChild(container)
  })
})
