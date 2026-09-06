import { memo } from 'react'
import { READER_FONT } from '../../utils/fonts'
import { MarkdownCore } from '../Common/MarkdownCore'

/**
 * Markdown 渲染。`streaming=true` 时文本仍在增长且常处于不完整语法状态
 * （未闭合的 `**` / 代码块等）：降级为 pre-wrap 纯文本，避免每 rAF 帧全量
 * markdown 解析 + 代码块语法高亮；turn 结束后以 streaming=false 一次性渲染。
 * 外层 memo：同一消息的历史 text block 引用稳定，重渲染时跳过 react-markdown。
 *
 * 渲染实现见 `Common/MarkdownCore`（与文件抽屉预览共用）；这里只保留聊天特有的
 * streaming 降级与历史外观参数 —— codeRadius/inlineCodeRadius 是已上线的圆角值，
 * 与 UI 规范 §6 的 radius 0 不一致，属既有偏差，改动需单独评审聊天视觉回归。
 */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  if (streaming) {
    return (
      <div
        className="chat-markdown"
        style={{
          fontFamily: READER_FONT,
          fontSize: '1em',
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </div>
    )
  }
  return <MarkdownCore text={text} className="chat-markdown" codeRadius={6} inlineCodeRadius={3} />
})
