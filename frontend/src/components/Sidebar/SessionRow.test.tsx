import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SessionRow, type SessionRowProps } from './SessionRow'
import type { Session } from '../../api/client'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    project_id: 'p1',
    workspace_path: '/repo/main',
    name: 'session-1',
    tmux_session_name: 'omni-s1',
    hook_enabled: false,
    created_at: '2026-01-01T00:00:00Z',
    runtime_kind: 'acp',
    ...overrides,
  }
}

function baseProps(overrides: Partial<SessionRowProps> = {}): SessionRowProps {
  return {
    session: makeSession(),
    isActive: false,
    attnReason: undefined,
    activity: undefined,
    selectionMode: false,
    isSelected: false,
    isMobile: true,
    onActivate: vi.fn(),
    onToggleSelect: vi.fn(),
    onContextMenu: vi.fn(),
    onReleaseRequest: vi.fn(),
    onArchiveRequest: vi.fn(),
    onDeleteRequest: vi.fn(),
    ...overrides,
  }
}

describe('SessionRow 交互', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    document.body.removeChild(container)
    vi.useRealTimers()
  })

  function renderRow(props: SessionRowProps): HTMLElement {
    act(() => {
      root.render(<SessionRow {...props} />)
    })
    const row = container.querySelector('.sidebar-session-item') as HTMLElement
    expect(row).toBeTruthy()
    return row
  }

  // jsdom has no TouchEvent constructor; shape the event close enough for
  // useLongPress（与 useLongPress.test.ts 同一手法）。
  function fireTouch(el: Element, type: string, x: number, y: number) {
    const ev = new Event(type, { bubbles: true })
    Object.defineProperty(ev, 'touches', { value: [{ clientX: x, clientY: y }] })
    act(() => {
      el.dispatchEvent(ev)
    })
  }

  it('点击激活会话（非选择模式）', () => {
    const onActivate = vi.fn()
    const row = renderRow(baseProps({ onActivate }))

    act(() => {
      row.click()
    })
    expect(onActivate).toHaveBeenCalledWith('s1')
  })

  it('右键阻止默认菜单并上报锚点坐标', () => {
    const onContextMenu = vi.fn()
    const row = renderRow(baseProps({ onContextMenu }))

    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 })
    act(() => {
      row.dispatchEvent(ev)
    })

    expect(ev.defaultPrevented).toBe(true)
    expect(onContextMenu).toHaveBeenCalledTimes(1)
    const [session, point] = onContextMenu.mock.calls[0]
    expect(session.id).toBe('s1')
    expect(point).toEqual({ x: 40, y: 60 })
  })

  it('长按 500ms 触发菜单；抬手补发的 click 不激活会话', () => {
    vi.useFakeTimers()
    const onContextMenu = vi.fn()
    const onActivate = vi.fn()
    const row = renderRow(baseProps({ onContextMenu, onActivate }))

    fireTouch(row, 'touchstart', 12, 34)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(onContextMenu).toHaveBeenCalledTimes(1)
    expect(onContextMenu.mock.calls[0][1]).toEqual({ x: 12, y: 34 })

    // 浏览器在 touchend 后向 touchstart 目标补发一次 click——
    // 没有抑制的话这里会激活会话（长按弹菜单时同时切换视图）。
    fireTouch(row, 'touchend', 12, 34)
    act(() => {
      row.click()
    })
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('位移超过阈值取消长按（滚动保护）', () => {
    vi.useFakeTimers()
    const onContextMenu = vi.fn()
    const row = renderRow(baseProps({ onContextMenu }))

    fireTouch(row, 'touchstart', 0, 0)
    fireTouch(row, 'touchmove', 40, 40)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(onContextMenu).not.toHaveBeenCalled()
  })

  it('非移动端不启用长按', () => {
    vi.useFakeTimers()
    const onContextMenu = vi.fn()
    const row = renderRow(baseProps({ onContextMenu, isMobile: false }))

    fireTouch(row, 'touchstart', 0, 0)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(onContextMenu).not.toHaveBeenCalled()
  })

  it('选择模式：点击行切换选中而非激活，勾选框反映选中态', () => {
    const onActivate = vi.fn()
    const onToggleSelect = vi.fn()
    const row = renderRow(
      baseProps({ selectionMode: true, isSelected: true, onActivate, onToggleSelect }),
    )

    const checkbox = row.querySelector('input.fm-checkbox') as HTMLInputElement
    expect(checkbox).toBeTruthy()
    expect(checkbox.checked).toBe(true)

    act(() => {
      row.click()
    })
    expect(onToggleSelect).toHaveBeenCalledWith('s1')
    expect(onActivate).not.toHaveBeenCalled()
  })

  it('选择模式：勾选框点击只切换一次（不冒泡到行）', () => {
    const onToggleSelect = vi.fn()
    const row = renderRow(baseProps({ selectionMode: true, onToggleSelect }))
    const checkbox = row.querySelector('input.fm-checkbox') as HTMLInputElement

    act(() => {
      checkbox.click()
    })
    expect(onToggleSelect).toHaveBeenCalledTimes(1)
  })

  it('选择模式：右键不弹菜单，且不渲染行内操作按钮', () => {
    const onContextMenu = vi.fn()
    const row = renderRow(baseProps({ selectionMode: true, onContextMenu }))

    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      row.dispatchEvent(ev)
    })
    expect(onContextMenu).not.toHaveBeenCalled()
    expect(row.querySelector('.row-action')).toBeNull()
  })

  it('常规模式：行内不再有重命名按钮，删除按钮保留', () => {
    renderRow(baseProps())
    expect(container.querySelector('button[title="sidebar.rename"]')).toBeNull()
    expect(container.querySelector('button[title="sidebar.delete"]')).toBeTruthy()
  })
})
