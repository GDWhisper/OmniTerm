import { describe, it, expect } from 'vitest'
import type { ChatMessage, ContentBlock } from '../stores/chatStore'
import { chatTailSignature, shouldShowJumpToBottom } from './chatScroll'

function msg(id: string, blocks: ContentBlock[], text = '', streaming = false): ChatMessage {
  return { id, role: 'assistant', text, blocks, createdAt: 0, streaming }
}

describe('chatTailSignature', () => {
  it('空列表返回空串', () => {
    expect(chatTailSignature([])).toBe('')
  })

  it('同一批消息指纹稳定', () => {
    const messages = [msg('a', [{ type: 'text', text: 'hi' }], 'hi')]
    expect(chatTailSignature(messages)).toBe(chatTailSignature([...messages]))
  })

  it('流式扩写末条正文 → 指纹变化', () => {
    const before = [msg('a', [{ type: 'text', text: 'he' }], 'he', true)]
    const after = [msg('a', [{ type: 'text', text: 'hello' }], 'hello', true)]
    expect(chatTailSignature(after)).not.toBe(chatTailSignature(before))
  })

  it('追加新消息 → 指纹变化', () => {
    const before = [msg('a', [{ type: 'text', text: 'hi' }], 'hi')]
    const after = [...before, msg('b', [{ type: 'text', text: 'new' }], 'new')]
    expect(chatTailSignature(after)).not.toBe(chatTailSignature(before))
  })

  it('头部前插更早历史（末条不变）→ 指纹不变', () => {
    const messages = [msg('b', [{ type: 'text', text: 'latest' }], 'latest')]
    const prepended = [msg('a', [{ type: 'text', text: 'older' }], 'older'), ...messages]
    expect(chatTailSignature(prepended)).toBe(chatTailSignature(messages))
  })

  it('仅 streaming 标志翻转（markDone 收尾）→ 指纹不变，不误报新内容', () => {
    const streaming = [msg('a', [{ type: 'text', text: 'x' }], 'x', true)]
    const done = [msg('a', [{ type: 'text', text: 'x' }], 'x', false)]
    expect(chatTailSignature(streaming)).toBe(chatTailSignature(done))
  })

  it('末条工具块仅状态推进（正文长度不变）→ 指纹变化', () => {
    const running: ContentBlock[] = [
      { type: 'tool_call', toolCallId: 't1', status: 'running', content: 'ls' },
    ]
    const completed: ContentBlock[] = [
      { type: 'tool_call', toolCallId: 't1', status: 'completed', content: 'ls' },
    ]
    expect(chatTailSignature([msg('a', completed)])).not.toBe(
      chatTailSignature([msg('a', running)]),
    )
  })

  it('末条 thought 块增长 → 指纹变化', () => {
    const before = [msg('a', [{ type: 'thought', text: 'th' }])]
    const after = [msg('a', [{ type: 'thought', text: 'thinking' }])]
    expect(chatTailSignature(after)).not.toBe(chatTailSignature(before))
  })
})

describe('shouldShowJumpToBottom', () => {
  it('贴底时不显示', () => {
    expect(shouldShowJumpToBottom(true, 'sig', 'other')).toBe(false)
  })

  it('无基线（从未贴底）时不显示', () => {
    expect(shouldShowJumpToBottom(false, 'sig', null)).toBe(false)
  })

  it('离开底部但内容未变时不显示', () => {
    expect(shouldShowJumpToBottom(false, 'sig', 'sig')).toBe(false)
  })

  it('离开底部且内容有增长时显示', () => {
    expect(shouldShowJumpToBottom(false, 'sig2', 'sig1')).toBe(true)
  })
})
