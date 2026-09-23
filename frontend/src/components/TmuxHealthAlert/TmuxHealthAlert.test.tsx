import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import {
  TmuxHealthAlert,
  TMUX_HEALTH_POLL_MS,
  DEAF_CONFIRM_THRESHOLD,
} from './TmuxHealthAlert'
import { api, ApiError } from '../../api/client'
import type { TmuxHealth, TmuxRebuildResult } from '../../api/client'
import { useToastStore } from '../../stores/toastStore'
import { advanceClock, realTick } from '../../test/timers'

vi.mock('../../api/client', () => ({
  api: {
    tmuxHealth: vi.fn(),
    tmuxRebuild: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    status: number
    body: unknown
    constructor(status: number, body: unknown, message: string) {
      super(message)
      this.status = status
      this.body = body
    }
  },
}))

function makeHealth(overrides: Partial<TmuxHealth> = {}): TmuxHealth {
  return {
    state: 'healthy',
    consecutive_deaf: 0,
    last_deaf_at: null,
    orphan_count: 0,
    orphan_warn_threshold: 5,
    probe_interval_secs: 30,
    ...overrides,
  }
}

const REBUILD_OK: TmuxRebuildResult = {
  ok: true,
  server_pid: 12345,
  socket_removed: true,
  detail: 'killed stale server',
}

function toasts() {
  return useToastStore.getState().toasts
}

function alertEl(): Element | null {
  return document.body.querySelector('[data-testid="tmux-health-alert"]')
}

function rebuildButton(): HTMLButtonElement | null {
  return document.body.querySelector('[data-testid="tmux-rebuild-btn"]')
}

describe('TmuxHealthAlert', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot> | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    // 模块工厂里的 vi.fn() 不归 restoreAllMocks 管：调用计数与 Once 队列会跨用例
    // 泄漏（曾致 toHaveBeenCalledTimes(2) 拿到 13），必须逐用例 reset。
    vi.mocked(api.tmuxHealth).mockReset()
    vi.mocked(api.tmuxRebuild).mockReset()
    i18n.changeLanguage('en')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    root?.unmount()
    container.remove()
    root = null
    useToastStore.setState({ toasts: [] })
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // 每个用例先配置好 api mock 再挂载：组件挂载即发第一探，mock 未就绪会读到 undefined。
  function render() {
    root = createRoot(container)
    root.render(
      <I18nextProvider i18n={i18n}>
        <TmuxHealthAlert />
      </I18nextProvider>,
    )
  }

  /** 等首轮探测落定并完成重渲染。 */
  async function firstProbeDone() {
    await vi.waitFor(() => expect(api.tmuxHealth).toHaveBeenCalled())
    await realTick()
    await realTick()
  }

  async function mountWith(health: TmuxHealth) {
    vi.mocked(api.tmuxHealth).mockResolvedValue(health)
    render()
    await vi.waitFor(() => expect(alertEl()).toBeTruthy())
  }

  // ── 告警显隐（后端四态分类的前端消费） ──

  it('deaf 且连续确认达到阈值 → 渲染告警 + 重建按钮', async () => {
    await mountWith(
      makeHealth({ state: 'deaf', consecutive_deaf: DEAF_CONFIRM_THRESHOLD, last_deaf_at: '2026-09-22T00:03:22Z' }),
    )
    expect(document.body.textContent).toContain('Deaf tmux server detected')
    expect(rebuildButton()).toBeTruthy()
    expect(rebuildButton()!.textContent?.trim()).toBe('Rebuild tmux server')
  })

  it('deaf 但连续确认未达阈值 → 不告警（防单次探测抖动误报）', async () => {
    vi.mocked(api.tmuxHealth)
      .mockResolvedValueOnce(makeHealth({ state: 'deaf', consecutive_deaf: DEAF_CONFIRM_THRESHOLD - 1 }))
      .mockResolvedValue(makeHealth({ state: 'deaf', consecutive_deaf: DEAF_CONFIRM_THRESHOLD }))
    render()
    await firstProbeDone()
    expect(alertEl()).toBeNull()
    // 正向对照：状态确已消费——下一轮达到阈值即告警
    await advanceClock(TMUX_HEALTH_POLL_MS)
    expect(alertEl()).toBeTruthy()
  })

  it('healthy / no_server → 完全静默', async () => {
    vi.mocked(api.tmuxHealth)
      .mockResolvedValueOnce(makeHealth({ state: 'healthy' }))
      .mockResolvedValueOnce(makeHealth({ state: 'no_server' }))
      .mockResolvedValue(makeHealth({ state: 'deaf', consecutive_deaf: DEAF_CONFIRM_THRESHOLD }))
    render()
    await firstProbeDone()
    expect(alertEl()).toBeNull()
    await advanceClock(TMUX_HEALTH_POLL_MS)
    expect(alertEl()).toBeNull()
    // 正向对照：第三轮 deaf 确认即告警
    await advanceClock(TMUX_HEALTH_POLL_MS)
    expect(alertEl()).toBeTruthy()
  })

  it('other → 仅轻量提示，不给重建按钮', async () => {
    await mountWith(makeHealth({ state: 'other' }))
    expect(document.body.textContent).toContain('tmux health probe hit an unknown failure')
    expect(rebuildButton()).toBeNull()
  })

  it('orphan_count 超阈值 → 风险提示文案（含计数与警戒线），无操作按钮', async () => {
    await mountWith(makeHealth({ orphan_count: 7, orphan_warn_threshold: 5 }))
    expect(document.body.textContent).toContain('7 orphan tmux control clients')
    expect(document.body.textContent).toContain('warning threshold 5')
    expect(document.body.textContent).toContain('freeze on the next SIGTERM')
    expect(rebuildButton()).toBeNull()
  })

  it('orphan_count 等于阈值 → 不提示（严格大于才提示）', async () => {
    vi.mocked(api.tmuxHealth)
      .mockResolvedValueOnce(makeHealth({ orphan_count: 5, orphan_warn_threshold: 5 }))
      .mockResolvedValue(makeHealth({ state: 'deaf', consecutive_deaf: DEAF_CONFIRM_THRESHOLD }))
    render()
    await firstProbeDone()
    expect(alertEl()).toBeNull()
    // 正向对照
    await advanceClock(TMUX_HEALTH_POLL_MS)
    expect(alertEl()).toBeTruthy()
  })

  it('deaf + 孤儿超阈值 → 告警与风险提示同屏', async () => {
    await mountWith(
      makeHealth({ state: 'deaf', consecutive_deaf: 4, orphan_count: 9, orphan_warn_threshold: 5 }),
    )
    expect(document.body.textContent).toContain('Deaf tmux server detected')
    expect(document.body.textContent).toContain('9 orphan tmux control clients')
    expect(rebuildButton()).toBeTruthy()
  })

  // ── 重建动作 ──

  it('重建成功 → 成功提示 + 立即刷新 health；进行中防双击', async () => {
    await mountWith(makeHealth({ state: 'deaf', consecutive_deaf: DEAF_CONFIRM_THRESHOLD }))
    let resolveRebuild!: (r: TmuxRebuildResult) => void
    vi.mocked(api.tmuxRebuild).mockImplementation(
      () => new Promise<TmuxRebuildResult>((res) => { resolveRebuild = res }),
    )

    const btn = rebuildButton()!
    btn.click()
    btn.click() // 连点两下也只发一次请求
    await vi.waitFor(() => expect(api.tmuxRebuild).toHaveBeenCalledTimes(1))
    await realTick()
    expect(rebuildButton()!.disabled).toBe(true)
    expect(rebuildButton()!.textContent?.trim()).toBe('Rebuilding…')

    resolveRebuild(REBUILD_OK)
    await vi.waitFor(() => {
      expect(toasts().some((t) => t.type === 'success' && t.message === 'tmux server rebuilt')).toBe(true)
    })
    // 成功后立即刷新 health（不等下一轮轮询）：初始 1 次 + 刷新 1 次
    expect(api.tmuxHealth).toHaveBeenCalledTimes(2)
    // 恢复可再点（health 仍为 deaf 时告警保留）
    await vi.waitFor(() => expect(rebuildButton()!.disabled).toBe(false))
  })

  it('409 not_deaf → 提示「已恢复，无需重建」+ 刷新 health，且不自动重试轰炸', async () => {
    await mountWith(makeHealth({ state: 'deaf', consecutive_deaf: DEAF_CONFIRM_THRESHOLD }))
    vi.mocked(api.tmuxRebuild).mockRejectedValue(new ApiError(409, { error: 'not_deaf' }, 'not_deaf'))

    rebuildButton()!.click()
    await vi.waitFor(() => {
      expect(
        toasts().some((t) => t.type === 'info' && t.message === 'tmux server has recovered — no rebuild needed'),
      ).toBe(true)
    })
    expect(api.tmuxHealth).toHaveBeenCalledTimes(2)

    // 刻意无自动重试：推 5 个轮询周期，重建请求仍只有那一发
    await advanceClock(5 * TMUX_HEALTH_POLL_MS)
    expect(api.tmuxRebuild).toHaveBeenCalledTimes(1)
  })

  it('409 heal_in_progress → 提示「重建进行中」，不重试轰炸', async () => {
    await mountWith(makeHealth({ state: 'deaf', consecutive_deaf: DEAF_CONFIRM_THRESHOLD }))
    vi.mocked(api.tmuxRebuild).mockRejectedValue(new ApiError(409, { error: 'heal_in_progress' }, 'heal_in_progress'))

    rebuildButton()!.click()
    await vi.waitFor(() => {
      expect(toasts().some((t) => t.type === 'info' && t.message === 'Rebuild already in progress')).toBe(true)
    })
    await advanceClock(5 * TMUX_HEALTH_POLL_MS)
    expect(api.tmuxRebuild).toHaveBeenCalledTimes(1)
  })

  it('500 → 错误提示（带后端 error 串）', async () => {
    await mountWith(makeHealth({ state: 'deaf', consecutive_deaf: DEAF_CONFIRM_THRESHOLD }))
    vi.mocked(api.tmuxRebuild).mockRejectedValue(
      new ApiError(500, { error: 'socket inode mismatch' }, 'socket inode mismatch'),
    )

    rebuildButton()!.click()
    await vi.waitFor(() => {
      expect(
        toasts().some(
          (t) => t.type === 'error' && t.message === 'Failed to rebuild tmux server: socket inode mismatch',
        ),
      ).toBe(true)
    })
  })

  // ── 轮询链 ──

  it('单一轮询链：挂载即探一次，此后每 10s 一次；恢复 healthy 后横幅自动消失；卸载释放定时器', async () => {
    vi.mocked(api.tmuxHealth)
      .mockResolvedValueOnce(makeHealth({ state: 'deaf', consecutive_deaf: DEAF_CONFIRM_THRESHOLD }))
      .mockResolvedValue(makeHealth({ state: 'healthy' }))
    render()
    await vi.waitFor(() => expect(alertEl()).toBeTruthy())
    expect(api.tmuxHealth).toHaveBeenCalledTimes(1)

    await advanceClock(TMUX_HEALTH_POLL_MS)
    expect(api.tmuxHealth).toHaveBeenCalledTimes(2)
    expect(alertEl()).toBeNull()

    // 卸载后定时器释放，不再继续轮询
    root!.unmount()
    root = null
    const calls = vi.mocked(api.tmuxHealth).mock.calls.length
    await advanceClock(2 * TMUX_HEALTH_POLL_MS)
    expect(api.tmuxHealth).toHaveBeenCalledTimes(calls)
  })

  it('轮询失败静默：不弹 toast，且下一轮继续探测', async () => {
    vi.mocked(api.tmuxHealth)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(makeHealth({ state: 'deaf', consecutive_deaf: DEAF_CONFIRM_THRESHOLD }))
    render()
    await firstProbeDone()
    expect(toasts()).toHaveLength(0)
    expect(alertEl()).toBeNull()
    // 正向对照：失败不打断轮询链，下一轮正常出告警
    await advanceClock(TMUX_HEALTH_POLL_MS)
    expect(alertEl()).toBeTruthy()
    expect(toasts()).toHaveLength(0)
  })
})
