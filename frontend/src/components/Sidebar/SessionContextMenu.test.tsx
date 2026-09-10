import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { SessionContextMenu, type SessionContextMenuState } from './SessionContextMenu'
import type { Session } from '../../api/client'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const session: Session = {
  id: 's1',
  project_id: 'p1',
  workspace_path: '/repo/main',
  name: 'session-1',
  tmux_session_name: 'omni-s1',
  hook_enabled: false,
  created_at: '2026-01-01T00:00:00Z',
  runtime_kind: 'acp',
}

function baseProps(overrides: Partial<Parameters<typeof SessionContextMenu>[0]> = {}) {
  return {
    menu: { session, x: 10, y: 10 } as SessionContextMenuState | null,
    onClose: vi.fn(),
    onBatchMode: vi.fn(),
    onRename: vi.fn(),
    ...overrides,
  }
}

describe('SessionContextMenu', () => {
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
  })

  function renderMenu(props: Parameters<typeof SessionContextMenu>[0]) {
    act(() => {
      root.render(<SessionContextMenu {...props} />)
    })
  }

  function menuButton(labelKey: string): HTMLElement {
    const btn = [...document.body.querySelectorAll('.context-menu-item')].find(
      (b) => b.textContent === labelKey,
    )
    expect(btn, `菜单项未渲染: ${labelKey}`).toBeTruthy()
    return btn as HTMLElement
  }

  it('menu 为 null 时什么都不渲染', () => {
    renderMenu(baseProps({ menu: null }))
    expect(document.body.querySelector('.pixel-float')).toBeNull()
    expect(document.querySelectorAll('.context-menu-item').length).toBe(0)
  })

  it('点击「批量操作」触发回调并关闭菜单', () => {
    const onBatchMode = vi.fn()
    const onClose = vi.fn()
    renderMenu(baseProps({ onBatchMode, onClose }))

    act(() => {
      menuButton('sidebar.batchMode').click()
    })
    expect(onBatchMode).toHaveBeenCalledWith(session)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('点击「重命名」触发回调并关闭菜单', () => {
    const onRename = vi.fn()
    const onClose = vi.fn()
    renderMenu(baseProps({ onRename, onClose }))

    act(() => {
      menuButton('sidebar.rename').click()
    })
    expect(onRename).toHaveBeenCalledWith(session)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Esc 关闭菜单', () => {
    const onClose = vi.fn()
    renderMenu(baseProps({ onClose }))

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('遮罩点击关闭菜单', () => {
    const onClose = vi.fn()
    renderMenu(baseProps({ onClose }))
    const menuEl = document.body.querySelector('.pixel-float') as HTMLElement
    const overlay = menuEl.previousElementSibling as HTMLElement

    act(() => {
      overlay.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('锚点超出视口时 clamp 进视口', () => {
    renderMenu(
      baseProps({
        menu: { session, x: window.innerWidth + 200, y: window.innerHeight + 200 },
      }),
    )
    const menuEl = document.body.querySelector('.pixel-float') as HTMLElement
    const left = parseInt(menuEl.style.left, 10)
    const top = parseInt(menuEl.style.top, 10)
    expect(left).toBeLessThanOrEqual(window.innerWidth - 160)
    expect(top).toBeLessThanOrEqual(window.innerHeight - 88)
    expect(left).toBeGreaterThanOrEqual(0)
    expect(top).toBeGreaterThanOrEqual(0)
  })
})
