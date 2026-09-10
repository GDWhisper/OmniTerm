import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '../../stores/chatStore'
import '../../i18n'

// 文件附件只落元数据：历史气泡以「文件名 + 大小」chip 还原「当时发了什么」。
// 独立的轻量测试文件，避免给 ChatMessage 的其余渲染路径建重 harness。

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

function renderMessage(blocks: ChatMessage['blocks'], text = 'see this') {
  const message: ChatMessage = {
    id: 'm1',
    role: 'user',
    text,
    blocks,
    createdAt: Date.now(),
  }
  act(() => {
    root.render(<ChatMessageView message={message} />)
  })
}

describe('ChatMessageView file chips', () => {
  it('renders a file chip with name and formatted size', () => {
    renderMessage([
      { type: 'text', text: 'see this' },
      { type: 'file', name: 'report.pdf', mimeType: 'application/pdf', size: 2048 },
    ])
    expect(container.textContent).toContain('report.pdf')
    expect(container.textContent).toContain('2.0 KB')
  })

  it('renders file chips alongside images', () => {
    renderMessage([
      { type: 'text', text: 'see this' },
      { type: 'image', mimeType: 'image/png', data: 'AAAA' },
      { type: 'file', name: 'notes.txt', mimeType: 'text/plain', size: 12 },
    ])
    expect(container.querySelector('img')).toBeTruthy()
    expect(container.textContent).toContain('notes.txt')
    expect(container.textContent).toContain('12 B')
  })

  it('renders no chip for a text-only message', () => {
    renderMessage([{ type: 'text', text: 'plain text' }], 'plain text')
    expect(container.textContent).toContain('plain text')
    expect(container.textContent).not.toContain('KB')
  })
})
