import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useMinuteNow } from './useMinuteNow'
import { realTick } from '../test/timers'

function Probe() {
  const now = useMinuteNow()
  return <span data-now={now} />
}

function TwoProbes() {
  return (
    <>
      <Probe />
      <Probe />
    </>
  )
}

describe('useMinuteNow', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let unmounted = false

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    unmounted = false
  })

  afterEach(() => {
    if (!unmounted) {
      act(() => {
        root.unmount()
      })
    }
    document.body.removeChild(container)
    vi.useRealTimers()
  })

  it('多个订阅者共用一个分钟级 interval，全部卸载后停止', async () => {
    const start = Date.now()
    act(() => {
      root.render(<TwoProbes />)
    })

    const spans = () => Array.from(container.querySelectorAll('span')) as HTMLElement[]
    expect(spans()).toHaveLength(2)
    expect(spans().every((el) => el.dataset.now === String(start))).toBe(true)
    // 两个订阅者共用同一个 interval
    expect(vi.getTimerCount()).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
      await realTick()
    })
    expect(spans().every((el) => el.dataset.now === String(start + 60_000))).toBe(true)

    act(() => {
      root.unmount()
    })
    unmounted = true
    // 最后一个订阅者卸载后 interval 必须释放
    expect(vi.getTimerCount()).toBe(0)
  })
})
