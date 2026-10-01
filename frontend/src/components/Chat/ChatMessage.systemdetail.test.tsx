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

/** 切 locale 再渲染：每次切换都包在 act 里，避免离开 act 的重渲染告警。 */
async function renderIn(message: ChatMessage, lang: string) {
  await act(async () => {
    await i18n.changeLanguage(lang)
  })
  render(message)
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

  it('renders the seconds-based payload and the legacy minutes payload alike', () => {
    // 2026-10-01 起后端 detail 走秒制（30 秒档不能被折成「0 分钟」）。
    render(
      systemMessage({
        blocks: [
          {
            type: 'system',
            label: 'system.permTimeout.abort',
            detail: { seconds: 30, tool: 'Bash' },
          },
        ],
      }),
    )
    expect(container.textContent).toContain('权限请求 30 秒未获响应')
    // 历史行只有 minutes：按 ×60 回退后仍显示分钟。
    act(() => root.unmount())
    root = createRoot(container)
    render(
      systemMessage({
        blocks: [{ type: 'system', label: 'system.permTimeout.abort', detail: { minutes: 30 } }],
      }),
    )
    expect(container.textContent).toContain('权限请求 30 分钟未获响应')
  })

  it('drops the waiting clause for the 总是 notch in auto mode', async () => {
    await i18n.changeLanguage('en')
    render(
      systemMessage({
        blocks: [
          {
            type: 'system',
            label: 'system.permTimeout.auto',
            detail: { seconds: 0, tool: 'Edit', selected: 'Always Allow' },
          },
        ],
      }),
    )
    const text = container.textContent ?? ''
    // 「总是」= 未等待应答，句式里不能出现时长，也不能出现「0 秒」。
    expect(text).toContain('no waiting')
    expect(text).toContain('Always Allow')
    expect(text).not.toContain('0s')
  })

  it('falls back to the raw label for legacy rows without detail', () => {
    render(systemMessage({ blocks: [{ type: 'system', label: '权限请求 30 分钟未获响应，系统已自动取消该请求并回收会话（agent 已终止）。可重新打开会话继续。' }] }))
    const text = container.textContent ?? ''
    expect(text).toContain('系统已自动取消该请求并回收会话')
    // 无 detail 时不渲染详情区。
    expect(text).not.toContain('可选项：')
  })

  it('renders the turn-failure refusal notice in both locales', async () => {
    const expectations: Record<string, string> = {
      zh: '这一轮未正常完成：agent 拒绝继续（stopReason=refusal）。',
      en: 'This turn did not complete: the agent refused to continue (stopReason=refusal).',
    }
    for (const lang of ['zh', 'en']) {
      await renderIn(
        systemMessage({
          blocks: [{ type: 'system', label: 'system.turnFailed.refusal', detail: { stop_reason: 'refusal' } }],
        }),
        lang,
      )
      const text = container.textContent ?? ''
      expect(text).toContain(expectations[lang])
      expect(text).not.toContain('system.turnFailed.refusal')
    }
  })

  it('interpolates the unknown stopReason raw value for system.turnFailed.other', async () => {
    const expectations: Record<string, string> = {
      zh: '这一轮以非正常原因结束（stopReason=_vendor_reason）。',
      en: 'This turn ended abnormally (stopReason=_vendor_reason).',
    }
    for (const lang of ['zh', 'en']) {
      await renderIn(
        systemMessage({
          blocks: [{ type: 'system', label: 'system.turnFailed.other', detail: { stop_reason: '_vendor_reason' } }],
        }),
        lang,
      )
      const text = container.textContent ?? ''
      // AGENTS.md §8：未知协议值必须原样可见，不得吞掉或替换成泛化文案。
      expect(text).toContain(expectations[lang])
      expect(text).not.toContain('system.turnFailed.other')
    }
  })

  it('renders only the one line for a {stop_reason}-only detail (no empty permission wrapper)', () => {
    render(systemMessage({
      blocks: [{ type: 'system', label: 'system.turnFailed.cancelled', detail: { stop_reason: 'cancelled' } }],
    }))
    const text = container.textContent ?? ''
    expect(text).toContain('这一轮已被取消（stopReason=cancelled）。')
    // 权限类详情行一个都不该出现（空 wrapper 回归）。
    expect(text).not.toContain('请求：')
    expect(text).not.toContain('可选项：')
    expect(text).not.toContain('另有')
    // 该 notice 不产生任何 <pre> 内容预览节点。
    expect(container.querySelectorAll('pre')).toHaveLength(0)
  })

  it('keeps rendering the permission detail block when permission fields are present', () => {
    // 同一 SystemBlockDetail 类型上的 turn-failure 字段不得挤掉权限详情区。
    render(systemMessage({
      blocks: [{
        type: 'system',
        label: 'system.permTimeout.abort',
        detail: { stop_reason: 'refusal', minutes: 30, tool: 'Bash', options: ['允许一次'] },
      }],
    }))
    const text = container.textContent ?? ''
    expect(text).toContain('权限请求 30 分钟未获响应')
    expect(text).toContain('请求：Bash')
    expect(text).toContain('可选项：允许一次')
  })
})
