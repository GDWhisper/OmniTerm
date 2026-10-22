import { describe, it, expect } from 'vitest'
import type { TFunction } from 'i18next'
import { markdownMarkers, sessionMarkdownLabels } from './markdownI18n'

/** 假 t：返回 `key` + 插值参数，便于断言「用了哪个 key、传了什么参数」。 */
const fakeT = ((key: string, opts?: Record<string, unknown>) =>
  `${key}|${JSON.stringify(opts ?? {})}`) as unknown as TFunction

describe('markdownMarkers', () => {
  it('标记文案全部走 i18n key，参数正确', () => {
    const m = markdownMarkers(fakeT)
    expect(m.toolCallsTitle).toBe('chat.export.marker.toolCallsTitle|{}')
    expect(m.toolTruncated(12)).toBe('chat.export.marker.toolTruncated|{"count":12}')
    expect(m.imageOmitted(3)).toBe('chat.export.marker.imageOmitted|{"index":3}')
    expect(m.imageAlt(1)).toBe('chat.export.marker.imageAlt|{"index":1}')
  })
})

describe('sessionMarkdownLabels', () => {
  it('头部文案走 i18n key，参数正确', () => {
    const l = sessionMarkdownLabels(fakeT)
    expect(l.title('demo')).toBe('chat.export.header.title|{"name":"demo"}')
    expect(l.exportedAt('2026-10-21 10:00:00')).toBe(
      'chat.export.header.exportedAt|{"time":"2026-10-21 10:00:00"}',
    )
    expect(l.messageCount(12, 20)).toBe('chat.export.header.messageCount|{"count":12,"total":20}')
    expect(l.messageCountTruncated(12)).toBe(
      'chat.export.header.messageCountTruncated|{"count":12}',
    )
    expect(l.noteToolLimit(40)).toBe('chat.export.header.noteToolLimit|{"count":40}')
    expect(l.noteImagesOmitted(2)).toBe('chat.export.header.noteImagesOmitted|{"count":2}')
    expect(l.omitted(3, '1.2 KB')).toBe('chat.export.header.omitted|{"count":3,"size":"1.2 KB"}')
  })

  it('静态说明行也走 i18n key', () => {
    const l = sessionMarkdownLabels(fakeT)
    expect(l.notesTitle).toBe('chat.export.header.notesTitle|{}')
    expect(l.noteImages).toBe('chat.export.header.noteImages|{}')
    expect(l.noteThinking).toBe('chat.export.header.noteThinking|{}')
  })

  it('会话名为空时用「未命名」的本地化文案兜底', () => {
    const l = sessionMarkdownLabels(fakeT)
    expect(l.title('')).toBe('chat.export.header.title|{"name":"sidebar.unnamed|{}"}')
  })

  it('正文标记与头部文案同源（labels.markers 复用 markdownMarkers）', () => {
    const l = sessionMarkdownLabels(fakeT)
    expect(l.markers.toolTruncated(1)).toBe('chat.export.marker.toolTruncated|{"count":1}')
  })
})
