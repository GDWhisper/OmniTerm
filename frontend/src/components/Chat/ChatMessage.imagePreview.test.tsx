import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '../../stores/chatStore'
import '../../i18n'

// 已发送图片：气泡缩略图可点击 → Modal 大图预览。live 消息的原图仍在
// `data`（`thumb` 只是索引缩略图）；历史行按 D3 只有缩略图，预览即缩略图。

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderImages(images: ChatMessage['blocks']) {
  const message: ChatMessage = {
    id: 'm1',
    role: 'user',
    text: '',
    blocks: images,
    createdAt: Date.now(),
  }
  act(() => {
    root.render(<ChatMessageView message={message} />)
  })
}

/** 预览图片在 Modal portal 里（document.body 末尾），与气泡内的缩略图区分开。 */
function previewImg(): HTMLImageElement | null {
  const modal = document.body.querySelector('.pixel-float')
  return modal?.querySelector<HTMLImageElement>('img') ?? null
}

describe('ChatMessageView image preview', () => {
  it('shows the thumbnail in the bubble and the original in the preview modal', () => {
    renderImages([
      {
        type: 'image',
        mimeType: 'image/png',
        data: 'ORIGINAL',
        thumb: { mimeType: 'image/jpeg', data: 'THUMB' },
      },
    ])

    const bubbleImg = container.querySelector<HTMLImageElement>('[data-chat-body] img')
    expect(bubbleImg?.getAttribute('src')).toBe('data:image/jpeg;base64,THUMB')

    const trigger = container.querySelector<HTMLButtonElement>('[data-chat-body] button')
    expect(trigger).toBeTruthy()
    act(() => trigger!.click())

    expect(previewImg()?.getAttribute('src')).toBe('data:image/png;base64,ORIGINAL')
  })

  it('previews the stored thumbnail for historical messages (no original)', () => {
    renderImages([{ type: 'image', mimeType: 'image/jpeg', data: 'HISTORY_THUMB' }])

    act(() => container.querySelector<HTMLButtonElement>('[data-chat-body] button')!.click())

    expect(previewImg()?.getAttribute('src')).toBe('data:image/jpeg;base64,HISTORY_THUMB')
  })

  it('closes the preview on Escape', () => {
    renderImages([{ type: 'image', mimeType: 'image/png', data: 'ORIGINAL' }])
    act(() => container.querySelector<HTMLButtonElement>('[data-chat-body] button')!.click())
    expect(previewImg()).toBeTruthy()

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(previewImg()).toBeNull()
  })
})
