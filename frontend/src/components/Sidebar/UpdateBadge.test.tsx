import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { UpdateBadge } from './UpdateBadge'
import { api } from '../../api/client'

vi.mock('../../api/client', () => ({
  api: {
    versionCheck: vi.fn(),
    systemUpdate: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number
    body: unknown
    constructor(message: string, status: number, body?: unknown) {
      super(message)
      this.status = status
      this.body = body
    }
  },
}))

// UpdateBadge 的面板经 createPortal 挂到 document.body，查询都走 body
function clickButtonByText(text: string) {
  const btn = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  )
  expect(btn, `button "${text}" not found`).toBeTruthy()
  btn!.click()
}

function healthOk(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

// React 19 调度器用 MessageChannel 排空渲染工作，fake timers 不拦截它：
// 每推进一个时钟片段后必须让真实宏任务队列转一圈，setState 才会完成重渲染，
// 组件续排的下一个 setTimeout/setInterval 才会落进已推进的假时钟里。
function realTick(): Promise<void> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port2.onmessage = () => resolve()
    port1.postMessage(null)
  })
}

async function advanceClock(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    await vi.advanceTimersByTimeAsync(1000)
    await realTick()
  }
}

describe('UpdateBadge 重启监测', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let reload: ReturnType<typeof vi.fn>
  let originalLocation: Location

  beforeEach(async () => {
    vi.useFakeTimers()
    i18n.changeLanguage('en')

    originalLocation = window.location
    reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { href: originalLocation.href, reload },
    })

    vi.mocked(api.versionCheck).mockResolvedValue({
      update_available: true,
      current: '0.2.17',
      latest: '0.2.18',
      channel: 'github_release',
      container: false,
    })
    vi.mocked(api.systemUpdate).mockResolvedValue({
      status: 'updated',
      version: '0.2.18',
      restart_required: true,
      auto_restart: true,
    })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    root.render(
      <I18nextProvider i18n={i18n}>
        <UpdateBadge />
      </I18nextProvider>,
    )
    await vi.waitFor(() => {
      expect(document.body.querySelector('.update-badge')).toBeTruthy()
    })
  })

  afterEach(() => {
    root.unmount()
    document.body.removeChild(container)
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    })
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function triggerUpdate() {
    document.body.querySelector<HTMLElement>('.update-badge')!.click()
    await vi.waitFor(() => {
      expect(document.body.querySelector('.pixel-float')).toBeTruthy()
    })
    clickButtonByText('Update Now')
    await vi.waitFor(() => {
      expect(api.systemUpdate).toHaveBeenCalled()
    })
  }

  it('health 返回目标版本 → 整页刷新（无需捕捉断连）', async () => {
    await triggerUpdate()
    const fetchMock = vi.fn(async () => healthOk({ status: 'ok', version: '0.2.18' }))
    vi.stubGlobal('fetch', fetchMock)

    // 倒计时 3 拍结束后，第 1 拍探测即命中版本 → reload
    await advanceClock(4500)
    expect(reload).toHaveBeenCalledTimes(1)
    // 命中后清除定时器，不再继续探测
    const calls = fetchMock.mock.calls.length
    await advanceClock(5000)
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it('health 持续返回旧版本 → 超时显示诚实提示', async () => {
    await triggerUpdate()
    vi.stubGlobal('fetch', vi.fn(async () => healthOk({ status: 'ok', version: '0.2.17' })))

    // 倒计时 3s + 60s 探测窗口（第 61 拍判超时）
    await advanceClock(65_000)
    expect(reload).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('has not switched to v0.2.18')
  })

  it('旧实现 health 无 version 字段 → 回退到断连→恢复触发刷新', async () => {
    await triggerUpdate()
    let polls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        polls += 1
        // 第 2 拍断连（sawDown），第 3 拍恢复 → 回退状态机触发 reload
        if (polls === 2) throw new Error('connection refused')
        return healthOk({ status: 'ok' })
      }),
    )

    await advanceClock(6500)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
