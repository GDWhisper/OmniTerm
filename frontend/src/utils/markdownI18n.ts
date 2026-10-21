import type { TFunction } from 'i18next'
import type { MessageMarkdownMarkers } from './messageMarkdown'
import type { SessionMarkdownLabels } from './sessionMarkdown'

/**
 * Markdown 导出件的 **i18n 接线**。
 *
 * 为什么单独一个模块：序列化器（`messageMarkdown.ts` / `sessionMarkdown.ts`）是
 * 纯函数，不依赖 react-i18next（口径同 `utils/sessionDisplayName.ts`），
 * 于是「文案从哪来」这件事集中在本文件——**导出件用到的全部 i18n key 只有这一处**
 * （改文案 = 改本文件 + 两份 locale，不会漏）。
 *
 * 两种载体共用同一套文案：
 * - 消息级「复制为 Markdown」（`components/Chat/messageActions.ts` 的 `copyMarkdown`）
 * - 会话级「导出为 Markdown」（`components/Chat/ChatView.tsx` 标题栏按钮）
 *
 * 序列化规则只有一份，**文案**才需要分语言——两者不要混为一谈。
 */

/** 正文标记文案（工具调用小节 / 截断提示 / 图片占位与 alt）。 */
export function markdownMarkers(t: TFunction): MessageMarkdownMarkers {
  return {
    toolCallsTitle: t('chat.export.marker.toolCallsTitle'),
    toolTruncated: (omittedLines) => t('chat.export.marker.toolTruncated', { count: omittedLines }),
    imageOmitted: (index) => t('chat.export.marker.imageOmitted', { index }),
    imageAlt: (index) => t('chat.export.marker.imageAlt', { index }),
  }
}

/** 会话级导出件的文案（头部说明 + 正文标记）。 */
export function sessionMarkdownLabels(t: TFunction): SessionMarkdownLabels {
  return {
    markers: markdownMarkers(t),
    title: (sessionName) => t('chat.export.header.title', { name: sessionName || t('sidebar.unnamed') }),
    exportedAt: (time) => t('chat.export.header.exportedAt', { time }),
    messageCount: (included, total) => t('chat.export.header.messageCount', { count: included, total }),
    messageCountTruncated: (included) =>
      t('chat.export.header.messageCountTruncated', { count: included }),
    notesTitle: t('chat.export.header.notesTitle'),
    noteImages: t('chat.export.header.noteImages'),
    noteThinking: t('chat.export.header.noteThinking'),
    noteToolLimit: (maxToolLines) => t('chat.export.header.noteToolLimit', { count: maxToolLines }),
    noteImagesOmitted: (count) => t('chat.export.header.noteImagesOmitted', { count }),
    omitted: (count, size) => t('chat.export.header.omitted', { count, size }),
  }
}
