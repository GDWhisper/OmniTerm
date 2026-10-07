import { memo, useMemo } from 'react'
import type { Components } from 'react-markdown'
import { useTranslation } from 'react-i18next'
import { READER_FONT } from '../../utils/fonts'
import { inlineCodeBaseStyle } from '../../utils/inlineCodeStyle'
import { parseLocalFilePath, isLikelyPathString } from '../../utils/path'
import { revealReportedPath } from '../../utils/reportedPath'
import { MarkdownCore, MarkdownLink, FencedCodeBlock } from '../Common/MarkdownCore'

/**
 * 聊天气泡内超链接组件。
 *
 * - 若链接指向本地文件系统路径（如 `src/main.rs`、`./docs/plan.md:24`、`/home/pax/coding/OmniTerm-dev`），
 *   拦截点击并在右侧 FileManager 中打开（如果是目录则导航浏览，文件则开抽屉）。
 * - 性能契约：不订阅 store 状态，点击时使用 `useAppStore.getState()` 读取当前会话 id，
 *   保证 memo 契约与流式期间零额外渲染成本。
 * - 其余链接（http/https/localhost）走 `MarkdownLink` 统一策略。
 */
function ChatLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const { t } = useTranslation()
  const filePath = parseLocalFilePath(href)

  if (filePath) {
    return (
      <a
        href={href}
        title={t('chat.msg.openFile')}
        style={{ color: 'var(--accent)', cursor: 'pointer' }}
        onClick={(e) => {
          e.preventDefault()
          revealReportedPath(filePath)
        }}
      >
        {children}
      </a>
    )
  }

  return <MarkdownLink href={href}>{children}</MarkdownLink>
}

/**
 * 聊天气泡内行内代码组件。
 *
 * - 如果行内代码内容类似于文件或目录路径（如 `/home/pax/coding/OmniTerm-dev` 或 `src/main.rs`），
 *   将其增强为可点击的路径，点击直接在右侧 FileManager 中显示。
 * - **有意不做键盘可达**（无 tabIndex / role / Enter handler）：这是聊天气泡里的
 *   「锦上添花」入口，真正的键盘/读屏入口是旁边同一路径的 `ChatLink`（`a href`）
 *   与 `FileLocationLink`（`button`）。纯鼠标 affordance 是有意取舍，不是遗漏。
 * - 「链接文本内嵌路径代码」（``[`src/main.rs`](src/main.rs)``）时内层 code 优先：
 *   两者指向同一路径，行为一致；内层 `stopPropagation` 只是避免外层 `a` 重复处理。
 */
function ChatInlineCode({
  className,
  children,
  inlineCodeRadius,
  ...props
}: React.HTMLAttributes<HTMLElement> & { inlineCodeRadius: number }) {
  const { t } = useTranslation()
  const textContent = typeof children === 'string' ? children.trim() : null
  const isPath = textContent ? isLikelyPathString(textContent) : false

  const baseStyle: React.CSSProperties = {
    ...inlineCodeBaseStyle(inlineCodeRadius),
    ...(isPath
      ? {
          cursor: 'pointer',
          color: 'var(--accent)',
          textDecoration: 'underline',
          textUnderlineOffset: '2px',
        }
      : {}),
  }

  return (
    <code
      className={className}
      style={baseStyle}
      title={isPath ? t('chat.msg.openFile') : undefined}
      onClick={
        isPath && textContent
          ? (e) => {
              e.stopPropagation()
              revealReportedPath(textContent)
            }
          : undefined
      }
      {...props}
    >
      {children}
    </code>
  )
}

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
  const components = useMemo<Components>(
    () => ({
      a({ href, children }) {
        return <ChatLink href={href}>{children}</ChatLink>
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      code({ className, children, ...props }: any) {
        // 围栏代码块（带 language-*）：显式调回 MarkdownCore 的 FencedCodeBlock。
        // **不能 `return undefined`** 委派默认 renderer —— 同一 `code` key 被接管后返回
        // undefined 会让整块代码连同内容一起消失（曾表现为「带路径的 agent 气泡整条不显示」）。
        if (className?.includes('language-')) {
          return (
            <FencedCodeBlock className={className} codeRadius={6}>
              {children}
            </FencedCodeBlock>
          )
        }
        return (
          <ChatInlineCode className={className} inlineCodeRadius={3} {...props}>
            {children}
          </ChatInlineCode>
        )
      },
    }),
    [],
  )

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
  return (
    <MarkdownCore
      text={text}
      className="chat-markdown"
      codeRadius={6}
      inlineCodeRadius={3}
      components={components}
    />
  )
})


