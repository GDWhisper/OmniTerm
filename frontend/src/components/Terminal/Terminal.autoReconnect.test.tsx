import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import {
  FakeWebSocket,
  mountTerminal,
  unmountTerminal,
  dropConnection,
  findReconnectButton,
  setDocumentHidden,
  restoreDocumentVisibility,
} from './Terminal.testUtils'
import { FakeXterm } from './fakeXterm'
import i18n from '../../i18n'
import { useAppStore } from '../../stores/appStore'

// 聚焦页面才重连：意外断开在页面可见时按指数退避自动重试（1→2→4→…→30s
// 封顶，同 useAcpChat 节奏）；页面隐藏期间零尝试；用户回来（visibilitychange
// / focus / 任意活动事件）立即重连并重置退避。blur/idle 主动拆除逻辑不变，
// 拆除后由同一引擎在回来时自愈（整端重建 + 跳过抢焦点）。

describe('Terminal auto-reconnect (聚焦页面才重连)', () => {
  let host: HTMLElement
  let root: Root

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // jsdom 的 document.hasFocus() 恒 false → blur/idle 计时器永不武装，
    // 「聚焦」语义无从测起；统一 stub 成「有焦点」。
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    FakeWebSocket.instances = []
    FakeXterm.instances = []
    i18n.changeLanguage('zh')
    useAppStore.setState({
      isMobile: false,
      activeSessionId: 'sess-1',
      activeExternalSession: null,
      terminalDisconnected: false,
      connected: true,
    })
    ;({ host, root } = await mountTerminal())
  })

  afterEach(() => {
    unmountTerminal(root)
    vi.unstubAllGlobals()
    vi.useRealTimers()
    restoreDocumentVisibility()
  })

  /** 关闭当前最新一条连接（模拟重连尝试失败）。 */
  async function failNewestConnection() {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    await act(async () => {
      ws.readyState = FakeWebSocket.CLOSED
      ws.onclose?.()
    })
    return ws
  }

  it('页面可见时意外断开 1s 后自动重连，成功后遮罩自愈', async () => {
    const ws1 = FakeWebSocket.instances[0]
    await dropConnection(ws1)
    expect(findReconnectButton(host)).toBeTruthy()
    // 引擎已接管：遮罩显示「正在自动重连」而非纯手动按钮
    expect(host.textContent).toContain(i18n.t('terminal.status.reconnecting'))
    expect(FakeWebSocket.instances.length).toBe(1)

    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(FakeWebSocket.instances.length).toBe(2)
    const ws2 = FakeWebSocket.instances[1]
    await act(async () => {
      ws2.readyState = FakeWebSocket.OPEN
      ws2.onopen?.()
    })
    expect(useAppStore.getState().terminalDisconnected).toBe(false)
    expect(findReconnectButton(host)).toBeUndefined()
  })

  it('重连失败按指数退避 1→2→4→8→16→30s 封顶，成功后计数归零', async () => {
    await dropConnection(FakeWebSocket.instances[0])

    // 每轮：推进当前退避间隔 → 新连接出现 → 让它失败 → 下一轮间隔翻倍。
    const step = async (delay: number, expectedCount: number) => {
      await act(async () => {
        vi.advanceTimersByTime(delay)
      })
      expect(FakeWebSocket.instances.length).toBe(expectedCount)
      await failNewestConnection()
    }
    await step(1000, 2)
    await step(2000, 3)
    await step(4000, 4)
    await step(8000, 5)
    await step(16000, 6)
    // 封顶 30s：间隔不再翻倍
    await step(30000, 7)
    await act(async () => {
      vi.advanceTimersByTime(29999)
    })
    expect(FakeWebSocket.instances.length).toBe(7)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(FakeWebSocket.instances.length).toBe(8)

    // 成功一次 → 计数归零，下次断开从 1s 重新爬
    const ws8 = FakeWebSocket.instances[7]
    await act(async () => {
      ws8.readyState = FakeWebSocket.OPEN
      ws8.onopen?.()
    })
    await dropConnection(ws8)
    await act(async () => {
      vi.advanceTimersByTime(999)
    })
    expect(FakeWebSocket.instances.length).toBe(8)
    await act(async () => {
      vi.advanceTimersByTime(1)
    })
    expect(FakeWebSocket.instances.length).toBe(9)
  })

  it('页面隐藏期间零重连尝试，回可见后立即重连（不等退避）', async () => {
    setDocumentHidden(true)
    await dropConnection(FakeWebSocket.instances[0])
    await act(async () => {
      vi.advanceTimersByTime(120_000)
    })
    expect(FakeWebSocket.instances.length).toBe(1)

    setDocumentHidden(false)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(FakeWebSocket.instances.length).toBe(2)
    const ws2 = FakeWebSocket.instances[1]
    await act(async () => {
      ws2.readyState = FakeWebSocket.OPEN
      ws2.onopen?.()
    })
    expect(useAppStore.getState().terminalDisconnected).toBe(false)
  })

  it('空闲拆除后用户活动即整端重建自愈，且不抢焦点', async () => {
    // useTerminal 的 idle 计时器在武装时读值（store 变更不重排已挂定时器），
    // 默认 15 分钟 → 推进到触发点。
    await act(async () => {
      vi.advanceTimersByTime(15 * 60_000 + 1000)
    })
    expect(useAppStore.getState().terminalDisconnected).toBe(true)
    expect(findReconnectButton(host)).toBeTruthy()
    expect(FakeXterm.instances[0].disposed).toBe(true)

    // 用户回来：任意输入活动（mousemove）触发 kick → teardown 态走整端重建
    await act(async () => {
      document.dispatchEvent(new Event('mousemove'))
    })
    await act(async () => {})
    expect(FakeWebSocket.instances.length).toBe(2)
    const ws2 = FakeWebSocket.instances[1]
    await act(async () => {
      ws2.readyState = FakeWebSocket.OPEN
      ws2.onopen?.()
    })
    expect(useAppStore.getState().terminalDisconnected).toBe(false)
    expect(findReconnectButton(host)).toBeUndefined()
    // autoFocus=true（桌面态）但引擎路径必须跳过：焦点没有被终端抢走
    expect(FakeXterm.instances[1].focusCount).toBe(0)
  })

  it('退避排队期间手动点击重连立即生效，且引擎排队被取消不再补发', async () => {
    await dropConnection(FakeWebSocket.instances[0]) // 引擎已排队 1s 重试
    const btn = findReconnectButton(host)
    expect(btn).toBeTruthy()
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})
    expect(FakeWebSocket.instances.length).toBe(2)
    const ws2 = FakeWebSocket.instances[1]
    await act(async () => {
      ws2.readyState = FakeWebSocket.OPEN
      ws2.onopen?.()
    })
    expect(useAppStore.getState().terminalDisconnected).toBe(false)
    // connectWs 入口取消了排队中的自动重试：推进 5s 不得出现第三次连接
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(FakeWebSocket.instances.length).toBe(2)
  })
})
