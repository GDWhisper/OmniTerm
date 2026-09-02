import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
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

describe('ToastContainer 消失行为', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const renderOne = (type: 'error' | 'info' = 'error') => {
    useToastStore.getState().addToast(type, 'boom')
    act(() => {
      root.render(<ToastContainer />)
    })
    return container.querySelector('.toast-pixel') as HTMLElement
  }

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    document.body.removeChild(container)
    useToastStore.setState({ toasts: [] })
    vi.useRealTimers()
  })

  it('倒计时结束后自动消失', () => {
    renderOne()
    act(() => {
      vi.advanceTimersByTime(4000)
    })
    expect(container.querySelector('.toast-pixel')).toBeNull()
  })

  it('hover 期间暂停倒计时，移开后继续走剩余时间', () => {
    const toast = renderOne()
    act(() => {
      vi.advanceTimersByTime(1500)
      toast.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    // 再走 10s：hover 中不消失
    act(() => {
      vi.advanceTimersByTime(10000)
    })
    expect(container.querySelector('.toast-pixel')).toBeTruthy()

    // hover 移开要先单独 flush：恢复计时的 timer 在 setPaused(false) 的 effect 里才创建
    act(() => {
      toast.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    })
    act(() => {
      vi.advanceTimersByTime(2400)
    })
    expect(container.querySelector('.toast-pixel')).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(container.querySelector('.toast-pixel')).toBeNull()
  })

  it('点击 ✕ 立即关闭', () => {
    const toast = renderOne()
    const closeBtn = toast.querySelector('button') as HTMLButtonElement
    act(() => {
      closeBtn.click()
    })
    expect(container.querySelector('.toast-pixel')).toBeNull()
  })

  it('点击消息正文不关闭（否则无法选中复制报错信息）', () => {
    const toast = renderOne('info')
    const body = toast.querySelector('span') as HTMLElement
    act(() => {
      body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('.toast-pixel')).toBeTruthy()
  })

  it('同屏 toast 数量有上限，超出丢弃最旧的', () => {
    for (let i = 0; i < 8; i++) useToastStore.getState().addToast('info', `msg-${i}`)
    act(() => {
      root.render(<ToastContainer />)
    })
    const texts = [...container.querySelectorAll('.toast-pixel')].map((n) => n.textContent)
    expect(texts).toHaveLength(5)
    expect(texts[0]).toContain('msg-3')
    expect(texts[4]).toContain('msg-7')
  })
})
