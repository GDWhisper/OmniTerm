import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatAttachDrawer } from './ChatAttachDrawer'
import '../../i18n'

// 抽屉必须 portal 到 body（移动端 strip 有 transform，fixed 会错位）；
// 卡片按 agent 能力置灰；选择后回调并关闭。

let container: HTMLDivElement
let root: Root
let toggle: HTMLButtonElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  // useAnchorPopup 通过该选择器找触发按钮做桌面定位。
  toggle = document.createElement('button')
  toggle.setAttribute('data-toggle', 'chat-attach')
  document.body.appendChild(toggle)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  toggle.remove()
})

function render(overrides: { albumSupported?: boolean; fileSupported?: boolean } = {}) {
  const props = {
    onClose: vi.fn(),
    onSelectAlbum: vi.fn(),
    onSelectFile: vi.fn(),
    albumSupported: true,
    fileSupported: true,
    ...overrides,
  }
  act(() => {
    root.render(<ChatAttachDrawer {...props} />)
  })
  return props
}

function panel(): HTMLElement | null {
  return document.body.querySelector('.pixel-float')
}

/** 两张附件卡片（panel-title-bar 内无 button）。 */
function cards(): HTMLButtonElement[] {
  return Array.from(panel()?.querySelectorAll('button') ?? [])
}

describe('ChatAttachDrawer', () => {
  it('renders into document.body via portal, not inside the caller container', () => {
    render()
    expect(container.querySelector('.pixel-float')).toBeNull()
    expect(panel()).toBeTruthy()
    expect(cards()).toHaveLength(2)
  })

  it('disables the album card when the agent does not accept images', () => {
    render({ albumSupported: false })
    expect(cards()[0].disabled).toBe(true)
    expect(cards()[1].disabled).toBe(false)
  })

  it('disables the file card when the agent does not accept file attachments', () => {
    render({ fileSupported: false })
    expect(cards()[0].disabled).toBe(false)
    expect(cards()[1].disabled).toBe(true)
  })

  it('invokes onSelectFile and closes when the file card is clicked', () => {
    const props = render()
    act(() => cards()[1].click())
    expect(props.onSelectFile).toHaveBeenCalledTimes(1)
    expect(props.onSelectAlbum).not.toHaveBeenCalled()
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('invokes onSelectAlbum when the album card is clicked', () => {
    const props = render()
    act(() => cards()[0].click())
    expect(props.onSelectAlbum).toHaveBeenCalledTimes(1)
    expect(props.onSelectFile).not.toHaveBeenCalled()
  })

  it('does not fire the callback for a disabled card', () => {
    const props = render({ fileSupported: false })
    act(() => cards()[1].click())
    expect(props.onSelectFile).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const props = render()
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on outside mousedown', () => {
    const props = render()
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores mousedown on the trigger button (toggle owns open/close)', () => {
    const props = render()
    act(() => {
      toggle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(props.onClose).not.toHaveBeenCalled()
  })
})
