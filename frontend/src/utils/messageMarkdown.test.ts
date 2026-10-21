import { describe, it, expect } from 'vitest'
import type { ChatMessage, ContentBlock } from '../stores/chatStore'
import { messageToMarkdown } from './messageMarkdown'

function text(text: string): ContentBlock {
  return { type: 'text', text }
}

function tool(overrides: Partial<Extract<ContentBlock, { type: 'tool_call' }>> = {}): ContentBlock {
  return {
    type: 'tool_call',
    toolCallId: 't1',
    status: 'completed',
    kind: 'execute',
    title: 'cargo build',
    content: 'Building...\nDone',
    ...overrides,
  }
}

function msg(role: ChatMessage['role'], blocks: ContentBlock[]): ChatMessage {
  return {
    id: 'm1',
    role,
    text: blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    blocks,
    createdAt: new Date(2026, 7, 13, 12, 34, 56).getTime(),
  }
}

const NOW = new Date(2026, 7, 13, 12, 40, 0)

describe('messageToMarkdown', () => {
  it('纯 text 消息：header + 正文', () => {
    const md = messageToMarkdown(msg('assistant', [text('你好')]), { agentName: 'demo', now: NOW })
    expect(md).toBe('## Agent: demo\n## Turn: 12:34\n\n你好')
  })

  it('多个 text 块以 \\n\\n 拼接', () => {
    const md = messageToMarkdown(msg('assistant', [text('第一段'), text('第二段')]), { now: NOW })
    expect(md).toContain('第一段\n\n第二段')
  })

  it('tool_call 生成工具调用小节（kind/title/status/content）', () => {
    const md = messageToMarkdown(msg('assistant', [tool()]), { now: NOW })
    expect(md).toContain('### 工具调用')
    expect(md).toContain('- **execute**: `cargo build` → ✓ completed')
    expect(md).toContain('```text')
    expect(md).toContain('Building...\n  Done')
  })

  it('tool_call kind 为模糊 other 时降级显示 tool，不输出误导标签', () => {
    const md = messageToMarkdown(msg('assistant', [tool({ kind: 'other' })]), { now: NOW })
    expect(md).toContain('- **tool**:')
    expect(md).not.toContain('**other**')
  })

  it('tool_call content 超长截断到 maxToolLines 并标注省略', () => {
    const long = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n')
    const md = messageToMarkdown(msg('assistant', [tool({ content: long })]), {
      now: NOW,
      maxToolLines: 40,
    })
    expect(md).toContain('line39')
    expect(md).not.toContain('line40')
    expect(md).toContain('省略 10 行')
  })

  it('tool_call 无 content 时不生成内容块（仅摘要行）', () => {
    const md = messageToMarkdown(msg('assistant', [tool({ content: undefined })]), { now: NOW })
    expect(md).toContain('- **execute**: `cargo build` → ✓ completed')
    expect(md).not.toContain('```text')
  })

  it('thought 块默认省略', () => {
    const md = messageToMarkdown(msg('assistant', [{ type: 'thought', text: '思考' }, text('正文')]), {
      now: NOW,
    })
    expect(md).not.toContain('思考')
    expect(md).toContain('正文')
  })

  it('system 消息返回空串', () => {
    expect(messageToMarkdown(msg('system', [text('x')]), { now: NOW })).toBe('')
  })
})

describe('messageToMarkdown 图片渲染', () => {
  function image(overrides: Partial<Extract<ContentBlock, { type: 'image' }>> = {}): ContentBlock {
    return {
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'QUJD',
      ...overrides,
    }
  }

  it('默认（omit）不渲染图片块——单条复制行为逐字不变', () => {
    const md = messageToMarkdown(msg('user', [image()]), { now: NOW })
    expect(md).not.toContain('data:image')
    expect(md).not.toContain('图片')
  })

  it('inline：图片以 data URI 内联', () => {
    const md = messageToMarkdown(msg('user', [image()]), { now: NOW, images: 'inline' })
    expect(md).toContain('![图片 1](data:image/jpeg;base64,QUJD)')
  })

  it('inline 优先取缩略图（thumb 存在时不用 data）', () => {
    const md = messageToMarkdown(
      msg('user', [image({ data: 'T1JJRw==', thumb: { data: 'VEhVTUI=', mimeType: 'image/jpeg' } })]),
      { now: NOW, images: 'inline' },
    )
    expect(md).toContain('base64,VEhVTUI=')
    expect(md).not.toContain('T1JJRw==')
  })

  it('placeholder：只留占位符行，不含 data URI', () => {
    const md = messageToMarkdown(msg('user', [image()]), { now: NOW, images: 'placeholder' })
    expect(md).toContain('> [图片 1：未导出（超出体积上限）]')
    expect(md).not.toContain('data:image')
  })

  it('解析器收到消息内序号与内联渲染的字节数', () => {
    const seen: Array<[number, number]> = []
    messageToMarkdown(msg('user', [image(), image()]), {
      now: NOW,
      images: (index, byteLength) => {
        seen.push([index, byteLength])
        return 'inline'
      },
    })
    expect(seen.map(([i]) => i)).toEqual([1, 2])
    const expected = new TextEncoder().encode('![图片 1](data:image/jpeg;base64,QUJD)').length
    expect(seen[0][1]).toBe(expected)
  })

  it('多张图片按序编号', () => {
    const md = messageToMarkdown(msg('user', [image(), image()]), { now: NOW, images: 'inline' })
    expect(md).toContain('![图片 1]')
    expect(md).toContain('![图片 2]')
  })

  it('自定义 markers 覆盖默认中文（本地化路径）', () => {
    const markers = {
      toolCallsTitle: '### Tool calls',
      toolTruncated: (n: number) => `… (${n} lines omitted)`,
      imageOmitted: (i: number) => `[Image ${i}: not exported]`,
      imageAlt: (i: number) => `Image ${i}`,
    }
    const md = messageToMarkdown(msg('assistant', [tool({ content: 'a\nb\nc' })]), {
      now: NOW,
      maxToolLines: 2,
      markers,
    })
    expect(md).toContain('### Tool calls')
    expect(md).toContain('(1 lines omitted)')

    const img = messageToMarkdown(msg('user', [image()]), {
      now: NOW,
      images: 'placeholder',
      markers,
    })
    expect(img).toContain('> [Image 1: not exported]')

    const inline = messageToMarkdown(msg('user', [image()]), {
      now: NOW,
      images: 'inline',
      markers,
    })
    expect(inline).toContain('![Image 1](data:image/jpeg;base64,QUJD)')
  })
})
