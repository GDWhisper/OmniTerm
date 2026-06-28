import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { MobileKeyBar } from './MobileKeyBar'

describe('MobileKeyBar', () => {
  it('calls onKey when special key pressed', async () => {
    const onKey = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    root.render(<MobileKeyBar onKey={onKey} scrollMode={false} onToggleScrollMode={vi.fn()} />)
    await vi.waitFor(() => {
      const esc = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Esc')
      expect(esc).toBeTruthy()
      esc?.click()
      expect(onKey).toHaveBeenCalledWith('Esc')
    })
    root.unmount()
    document.body.removeChild(container)
  })
})
