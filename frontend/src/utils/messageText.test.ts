import { describe, it, expect } from 'vitest'
import type { ChatMessage, ContentBlock } from '../stores/chatStore'
import { extractMessageText } from './messageText'

function text(text: string): ContentBlock {
  return { type: 'text', text }
}

function thought(text: string): ContentBlock {
  return { type: 'thought', text }
}

function tool(content: string): ContentBlock {
  return {
    type: 'tool_call',
    toolCallId: 't1',
    status: 'completed',
    kind: 'execute',
    content,
  }
}

function msg(role: ChatMessage['role'], blocks: ContentBlock[], plain = ''): ChatMessage {
  return {
    id: 'm1',
    role,
    text: plain,
    blocks,
    createdAt: 0,
  }
}

describe('extractMessageText', () => {
  it('user 消息取 message.text', () => {
    expect(extractMessageText(msg('user', [text('正文')], '用户正文'))).toBe('用户正文')
  })

  it('user 消息即使有 blocks 也取 text（plain 字段为准）', () => {
    expect(extractMessageText(msg('user', [text('block')], 'plain'))).toBe('plain')
  })

  it('assistant 拼接全部 text 块，以 \\n\\n 连接', () => {
    expect(extractMessageText(msg('assistant', [text('第一段'), text('第二段')]))).toBe(
      '第一段\n\n第二段',
    )
  })

  it('assistant 忽略 thought / tool_call / plan / todo / system / image 块', () => {
    const blocks: ContentBlock[] = [
      thought('思考'),
      text('正文'),
      tool('ls -la'),
      { type: 'plan', entries: [{ content: '计划', status: 'pending' }] },
      { type: 'todo', entries: [{ content: '待办', status: 'pending', priority: 'low' }] },
      { type: 'system', label: 'event' },
      { type: 'image', mimeType: 'image/png', data: 'aa' },
    ]
    expect(extractMessageText(msg('assistant', blocks))).toBe('正文')
  })

  it('assistant 无 text 块返回空串', () => {
    expect(extractMessageText(msg('assistant', [thought('思考')]))).toBe('')
    expect(extractMessageText(msg('assistant', []))).toBe('')
  })

  it('system 消息返回空串', () => {
    expect(extractMessageText(msg('system', [text('x')]))).toBe('')
  })
})
