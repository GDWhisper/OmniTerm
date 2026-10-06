import type { CSSProperties } from 'react'
import { READER_FONT } from './fonts'

/**
 * 行内代码的基础样式（背景/内距/圆角/字号/字体）。
 *
 * 单一真源：`Common/MarkdownCore.tsx`（默认行内渲染）与
 * `Chat/Markdown.tsx` 的 `ChatInlineCode`（在其上叠加路径点击态）共用。
 * 两处各写一份必然漂移，抽走这里。
 *
 * 放在 utils 而非 MarkdownCore.tsx：后者是组件文件，导出非组件会触发
 * eslint `react-refresh/only-export-components`（Fast Refresh 语义）。
 */
export function inlineCodeBaseStyle(inlineCodeRadius: number): CSSProperties {
  return {
    background: 'var(--bg-code-inline)',
    padding: '1px 5px',
    borderRadius: inlineCodeRadius,
    fontSize: '0.923em',
    fontFamily: READER_FONT,
  }
}
