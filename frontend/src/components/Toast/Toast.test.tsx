import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { ToastContainer } from './Toast'
import { useToastStore } from '../../stores/toastStore'

describe('ToastContainer', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    document.body.removeChild(container)
    useToastStore.setState({ toasts: [] })
  })

  it('像素 toast 无 emoji 图标与 tailwind 浅色类，仅保留字形前缀', async () => {
    useToastStore.getState().addToast('error', 'boom')
    root.render(<ToastContainer />)
    await vi.waitFor(() => {
      expect(container.querySelector('.toast-pixel.toast-error')).toBeTruthy()
    })
    const toast = container.querySelector('.toast-pixel.toast-error') as HTMLElement
    expect(toast.textContent).toContain('boom')
    // emoji 区间与 variation selector 均不得出现（ui-style-guide §13.3）；
    // U+2715 ✕ 是全库通用的纯文本字形（标题栏关闭钮同款），从 Dingbats 区间中豁免
    expect(toast.textContent || '').not.toMatch(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{2714}\u{2716}-\u{27BF}]/u
    )
    expect(toast.textContent || '').not.toContain('\uFE0F')
    expect(toast.className).not.toMatch(/bg-(blue|green|red|yellow)-50/)
  })
})
