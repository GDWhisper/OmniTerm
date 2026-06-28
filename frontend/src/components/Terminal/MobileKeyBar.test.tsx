import { describe, it, expect, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { MobileKeyBar } from './MobileKeyBar'

describe('MobileKeyBar', () => {
  it('calls onKey when special key pressed', async () => {
    const onKey = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<MobileKeyBar onKey={onKey} scrollMode={false} onToggleScrollMode={vi.fn()} />)
    })
    const esc = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Esc')
    expect(esc).toBeTruthy()
    await act(async () => {
      esc?.click()
    })
    expect(onKey).toHaveBeenCalledWith('Esc')
    root.unmount()
    document.body.removeChild(container)
  })
})
