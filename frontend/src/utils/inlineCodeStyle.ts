import type { CSSProperties } from 'react'
import { READER_FONT } from './fonts'

/**
 * 行内代码的基础样式（背景/内距/字号/字体）。
 *
 * 圆角恒 0（ui-style-guide §6 全局硬角）——历史上聊天面板传 3、别处传 0，
 * 两处必然漂移，随气泡像素化一并收敛，不再做成入参。
 *
 * 单一真源：`Common/MarkdownCore.tsx`（默认行内渲染）与
 * `Chat/Markdown.tsx` 的 `ChatInlineCode`（在其上叠加路径点击态）共用。
 * 两处各写一份必然漂移，抽走这里。
 *
 * 放在 utils 而非 MarkdownCore.tsx：后者是组件文件，导出非组件会触发
 * eslint `react-refresh/only-export-components`（Fast Refresh 语义）。
 */
export function inlineCodeBaseStyle(): CSSProperties {
  return {
    background: 'var(--bg-code-inline)',
    padding: '1px 5px',
    borderRadius: 0,
    fontSize: '0.923em',
    fontFamily: READER_FONT,
  }
}
