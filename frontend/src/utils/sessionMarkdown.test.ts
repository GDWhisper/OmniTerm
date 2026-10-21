import { describe, it, expect } from 'vitest'
import type { ChatMessage, ContentBlock } from '../stores/chatStore'
import { messageToMarkdown } from './messageMarkdown'
import { sessionToMarkdown } from './sessionMarkdown'
import { utf8Bytes } from './textBytes'

const NOW = new Date(2026, 9, 21, 10, 0, 0)

function msg(
  id: string,
  role: ChatMessage['role'],
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role,
    text,
    blocks: [{ type: 'text', text }] as ContentBlock[],
    createdAt: new Date(2026, 9, 21, 9, 0, 0).getTime(),
    ...extra,
  }
}

function imageMsg(id: string, data: string): ChatMessage {
  return {
    id,
    role: 'user',
    text: '',
    blocks: [{ type: 'image', mimeType: 'image/jpeg', data }],
    createdAt: new Date(2026, 9, 21, 9, 0, 0).getTime(),
  }
}

describe('sessionToMarkdown', () => {
  it('空会话：只出头部，无正文', () => {
    const res = sessionToMarkdown([], { now: NOW })
    expect(res.includedMessages).toBe(0)
    expect(res.omittedMessages).toBe(0)
    expect(res.markdown).toContain('# 会话导出：')
    expect(res.markdown).not.toContain('## Agent:')
  })

  it('单条消息：头部 + 复用单条导出的正文', () => {
    const res = sessionToMarkdown([msg('m1', 'user', '你好')], { now: NOW })
    expect(res.includedMessages).toBe(1)
    expect(res.markdown).toContain('你好')
    expect(res.markdown).toContain('## Agent: agent')
  })

  it('多条消息按时间正序拼接', () => {
    const res = sessionToMarkdown(
      [msg('m1', 'user', '第一'), msg('m2', 'assistant', '第二'), msg('m3', 'user', '第三')],
      { now: NOW },
    )
    expect(res.includedMessages).toBe(3)
    const order = ['第一', '第二', '第三'].map((t) => res.markdown.indexOf(t))
    expect(order[0]).toBeLessThan(order[1])
    expect(order[1]).toBeLessThan(order[2])
  })

  it('system 消息不导出（宿主内部事件，非对话内容）', () => {
    const res = sessionToMarkdown(
      [msg('m1', 'user', '你好'), msg('m2', 'system', '内部告知')],
      { now: NOW },
    )
    expect(res.includedMessages).toBe(1)
    expect(res.markdown).not.toContain('内部告知')
  })

  it('流式中的消息不导出（尚未定稿落库）', () => {
    const res = sessionToMarkdown(
      [msg('m1', 'user', '你好'), msg('m2', 'assistant', '半截', { streaming: true })],
      { now: NOW },
    )
    expect(res.includedMessages).toBe(1)
    expect(res.markdown).not.toContain('半截')
  })

  it('条数上限：保留最新的一段，省略较早的，并显式标注省略量', () => {
    const res = sessionToMarkdown(
      [msg('m1', 'user', '一'), msg('m2', 'user', '二'), msg('m3', 'user', '三')],
      { now: NOW, maxMessages: 2 },
    )
    expect(res.includedMessages).toBe(2)
    expect(res.omittedMessages).toBe(1)
    expect(res.markdown).toContain('三')
    expect(res.markdown).toContain('二')
    expect(res.markdown).not.toContain('一')
    expect(res.markdown).toContain('已省略较早的 1 条消息')
  })

  it('字节上限：只装得下最新的若干条', () => {
    const one = utf8Bytes(messageToMarkdown(msg('m1', 'user', '正文'), { now: NOW }))
    const res = sessionToMarkdown(
      [msg('m1', 'user', '一'), msg('m2', 'user', '二'), msg('m3', 'user', '三')],
      { now: NOW, maxBytes: one * 2 },
    )
    expect(res.includedMessages).toBe(2)
    expect(res.omittedMessages).toBe(1)
    expect(res.markdown).toContain('三')
    expect(res.markdown).not.toContain('一')
  })

  it('单条就超字节上限时仍导出这一条（与后端分页「至少一行」同取舍）', () => {
    const res = sessionToMarkdown([msg('m1', 'user', '很长的一段正文')], { now: NOW, maxBytes: 1 })
    expect(res.includedMessages).toBe(1)
    expect(res.markdown).toContain('很长的一段正文')
  })

  it('守恒：纳入条数 + 省略条数 == 候选总数', () => {
    const res = sessionToMarkdown(
      [
        msg('m1', 'user', '一'),
        msg('m2', 'system', '内部'),
        msg('m3', 'assistant', '二'),
        msg('m4', 'user', '三'),
      ],
      { now: NOW, maxMessages: 2 },
    )
    expect(res.includedMessages + res.omittedMessages).toBe(3)
  })

  it('预算够时图片内联为 data URI', () => {
    const res = sessionToMarkdown([imageMsg('m1', 'QUJD')], { now: NOW })
    expect(res.markdown).toContain('![图片 1](data:image/jpeg;base64,QUJD)')
    expect(res.degradedImages).toBe(0)
  })

  it('预算不足时图片降级为占位符，且占位符可见（缺失不静默）', () => {
    const base = utf8Bytes(messageToMarkdown(imageMsg('m1', 'QUJD'), { now: NOW }))
    const res = sessionToMarkdown([imageMsg('m1', 'QUJD')], { now: NOW, maxBytes: base + 1 })
    expect(res.degradedImages).toBe(1)
    expect(res.markdown).toContain('> [图片 1：未导出（超出体积上限）]')
    expect(res.markdown).not.toContain('data:image')
    expect(res.markdown).toContain('1 张图片因体积上限未内联')
  })

  it('导出体积不超过上限（正文部分）', () => {
    const res = sessionToMarkdown(
      [msg('m1', 'user', '一'), msg('m2', 'assistant', '二')],
      { now: NOW, maxBytes: 200 },
    )
    expect(res.bytes).toBeLessThanOrEqual(200)
  })

  it('头部写明导出时刻与三条口径说明', () => {
    const res = sessionToMarkdown([msg('m1', 'user', '你好')], { now: NOW, sessionName: 'demo' })
    expect(res.markdown).toContain('# 会话导出：demo')
    expect(res.markdown).toContain('导出时间：2026-10-21 10:00:00')
    expect(res.markdown).toContain('图片以内联缩略图导出')
    expect(res.markdown).toContain('思考过程（thinking）不导出')
    expect(res.markdown).toContain('工具调用输出最多保留前 40 行')
  })

  it('拉取阶段即截断时，头部写明「更早的历史未包含」而不谎报总数', () => {
    const res = sessionToMarkdown([msg('m1', 'user', '你好')], { now: NOW, historyTruncated: true })
    expect(res.markdown).toContain('更早的历史未包含')
    expect(res.markdown).not.toContain('共 1 条')
  })
})
