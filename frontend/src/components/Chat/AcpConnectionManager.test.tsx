import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useAcpConnectionStore } from '../../stores/acpConnectionStore'
import { AcpConnectionManager } from './AcpConnectionManager'
import type { Session } from '../../api/client'

/**
 * X15 回归防线：slot 生命周期。`connections` 的 key 集合 = 当前挂载的
 * AcpSlot 集合（AcpSlot 挂载 register、卸载 unregister）——等价于「哪些
 * 会话持有 WS + 独立退避重连循环」。修复前 `activatedRef` 只增不减，
 * 「已释放出清」「已删除/归档出清」两条会转红（失效会话仍留在集合里，
 * 连接与重连循环永不释放）。
 */
vi.mock('../../hooks/useAcpChat', () => ({
  useAcpChat: () => ({
    connectionState: 'disconnected',
    sendPrompt: () => {},
    cancel: () => {},
    restore: () => {},
    respondPermission: () => {},
    setConfigOption: () => {},
  }),
}))

function session(id: string, over?: Partial<Session>): Session {
  return {
    id,
    project_id: 'p1',
    workspace_path: '/tmp/ws',
    hook_enabled: false,
    created_at: '2026-01-01T00:00:00Z',
    runtime_kind: 'acp',
    ...over,
  }
}

const slotIds = () => Object.keys(useAcpConnectionStore.getState().connections).sort()

describe('AcpConnectionManager slot 生命周期（X15）', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    useAcpConnectionStore.setState({ connections: {} })
    useAppStore.setState({ sessions: {}, activeSessionId: null })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => root.render(<AcpConnectionManager />))
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('激活的 ACP 会话持有 slot；切换会话时保留前者（不拆 WS）', () => {
    act(() => useAppStore.setState({ sessions: { p1: [session('a')] }, activeSessionId: 'a' }))
    expect(slotIds()).toEqual(['a'])

    act(() =>
      useAppStore.setState({
        sessions: { p1: [session('a'), session('b')] },
        activeSessionId: 'b',
      }),
    )
    expect(slotIds()).toEqual(['a', 'b'])
  })

  it('非活跃且已释放（release）的会话出清 slot', () => {
    act(() => useAppStore.setState({ sessions: { p1: [session('a')] }, activeSessionId: 'a' }))
    act(() =>
      useAppStore.setState({
        sessions: { p1: [session('a'), session('b')] },
        activeSessionId: 'b',
      }),
    )
    expect(slotIds()).toEqual(['a', 'b'])

    // a 被释放（进程不在）且已不是活跃会话 → slot 出清
    act(() =>
      useAppStore.setState({
        sessions: { p1: [session('a', { acp_process_alive: false }), session('b')] },
      }),
    )
    expect(slotIds()).toEqual(['b'])
  })

  it('删除/归档（从 sessions 列表消失）的会话出清 slot', () => {
    act(() => useAppStore.setState({ sessions: { p1: [session('a')] }, activeSessionId: 'a' }))
    act(() =>
      useAppStore.setState({
        sessions: { p1: [session('a'), session('b')] },
        activeSessionId: 'b',
      }),
    )
    expect(slotIds()).toEqual(['a', 'b'])

    act(() => useAppStore.setState({ sessions: { p1: [session('b')] } }))
    expect(slotIds()).toEqual(['b'])
  })

  it('活跃的已释放会话保留 slot（「恢复会话」入口依赖该连接）', () => {
    act(() =>
      useAppStore.setState({
        sessions: { p1: [session('a', { acp_process_alive: false })] },
        activeSessionId: 'a',
      }),
    )
    expect(slotIds()).toEqual(['a'])
  })

  it('非 ACP（tmux/pty）活跃会话不创建 slot', () => {
    act(() =>
      useAppStore.setState({
        sessions: { p1: [session('t', { runtime_kind: 'tmux' })] },
        activeSessionId: 't',
      }),
    )
    expect(slotIds()).toEqual([])
  })
})
