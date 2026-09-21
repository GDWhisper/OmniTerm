import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatMessageView } from './ChatMessage'
import type { ChatMessage } from '../../stores/chatStore'
import i18n from '../../i18n'

// 权限超时告知消息的渲染回归（2026-09-21）：用户回来后靠这条消息知道自己错过了
// 什么——label 命中 i18n key 必须插值（分钟数/选中项），detail 必须展开工具、
// 内容预览、可选项、省略量；未命中 key 的历史中文 label 原样显示。

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  await i18n.changeLanguage('zh')
})

function systemMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    role: 'system',
    text: '[system.permTimeout.abort]',
    blocks: [{ type: 'system', label: 'system.permTimeout.abort' }],
    createdAt: 0,
    ...overrides,
  }
}

function render(message: ChatMessage) {
  act(() => {
    root.render(<ChatMessageView message={message} />)
  })
}

describe('SystemBlockView permission-timeout notice', () => {
  it('interpolates the i18n label and renders the structured detail', () => {
    render(
      systemMessage({
        blocks: [
          {
            type: 'system',
            label: 'system.permTimeout.abort',
            detail: {
              minutes: 30,
              tool: 'Bash',
              kind: 'execute',
              content: 'git push origin main',
              content_omitted: 12,
              options: ['允许一次', '总是允许', '拒绝'],
            },
          },
        ],
      }),
    )
    const text = container.textContent ?? ''
    // 插值后的主文案（含分钟数），不是光板 key。
    expect(text).toContain('权限请求 30 分钟未获响应')
    expect(text).not.toContain('system.permTimeout.abort')
    // detail 三件套：请求工具、内容预览 + 省略量、可选项。
    expect(text).toContain('请求：Bash（execute）')
    expect(text).toContain('git push origin main')
    expect(text).toContain('已省略 12 字符')
    expect(text).toContain('可选项：允许一次 / 总是允许 / 拒绝')
  })

  it('names the auto-selected option in auto mode', async () => {
    await i18n.changeLanguage('en')
    render(
      systemMessage({
        blocks: [
          {
            type: 'system',
            label: 'system.permTimeout.auto',
            detail: { minutes: 10, tool: 'Edit', selected: 'Always Allow', options: ['Allow Once', 'Always Allow', 'Reject'] },
          },
        ],
      }),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('unanswered for 10 min')
    expect(text).toContain('Always Allow')
    expect(text).toContain('Options: Allow Once / Always Allow / Reject')
  })

  it('falls back to the raw label for legacy rows without detail', () => {
    render(systemMessage({ blocks: [{ type: 'system', label: '权限请求 30 分钟未获响应，系统已自动取消该请求并回收会话（agent 已终止）。可重新打开会话继续。' }] }))
    const text = container.textContent ?? ''
    expect(text).toContain('系统已自动取消该请求并回收会话')
    // 无 detail 时不渲染详情区。
    expect(text).not.toContain('可选项：')
  })
})
