import { useMemo, type CSSProperties, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { READER_FONT } from '../../utils/fonts'
import { rewriteLocalUrl } from '../../utils/proxyUrl'

/**
 * Markdown 渲染核心 —— 聊天面板与文件抽屉共用同一套 element renderer。
 *
 * 站点差异不在此处加开关，而是从 `components` 注入覆盖（文件预览注入自己的
 * `img` / `a` 做相对路径解析）；只有「代码块圆角」这类纯尺寸 token 走 props，
 * 默认值取 UI 规范 §6 的 radius 0，已上线的聊天面板显式传它的历史值。
 */
export interface MarkdownCoreProps {
  text: string
  className?: string
  style?: CSSProperties
  /** 围栏代码块圆角。聊天 6（已上线，不动），新容器按规范用默认 0。 */
  codeRadius?: number
  /** 行内代码圆角。聊天 3（已上线，不动），新容器按规范用默认 0。 */
  inlineCodeRadius?: number
  /** 覆盖/追加 react-markdown 的 element renderer */
  components?: Components
}

/**
 * 绝对 / 协议相对 / localhost 链接的统一策略。
 * 相对路径由调用方决定怎么处理（文件预览自己接管），所以只兜住「不属于本地引用」的情况。
 */
export function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  // 本机 localhost 链接 → 走端口转发代理（新标签，同源 cookie 自动带鉴权）。
  // 保留原始 href（hover/复制仍是 localhost），点击时重写为 /proxy/{port}/。
  if (typeof href === 'string' && rewriteLocalUrl(href)) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          const rewritten = rewriteLocalUrl(href)
          if (rewritten) window.open(rewritten, '_blank', 'noopener')
        }}
        style={{ color: 'var(--accent)' }}
      >
        {children}
      </a>
    )
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
      {children}
    </a>
  )
}

function makeComponents({
  codeRadius,
  inlineCodeRadius,
}: {
  codeRadius: number
  inlineCodeRadius: number
}): Components {
  return {
    // TECH-DEBT: [react-markdown code 组件 props 用 any] | MarkdownCore.tsx | 根因：pnpm 严格 node_modules 使同一 @types/react 经两条路径被 tsc 实例化为两份模块实例，导致显式类型化后 <code {...props}> 触发 Ref/VoidOrUndefinedOnly 双类型不兼容（tsc -b 报错）。去重需调整 pnpm 去重/hoist 策略，超出质量门禁范围。升级路径：对齐 @types/react 单实例（pnpm dedupe 或 overrides）后改为显式 React.HTMLAttributes 类型并移除本 disable。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    code({ className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '')
      const codeStr = String(children).replace(/\n$/, '')
      if (match) {
        return (
          <SyntaxHighlighter
            style={oneDark}
            language={match[1]}
            PreTag="div"
            customStyle={{ margin: '8px 0', borderRadius: codeRadius, fontSize: '0.923em' }}
          >
            {codeStr}
          </SyntaxHighlighter>
        )
      }
      return (
        <code
          className={className}
          style={{
            background: 'var(--bg-code-inline)',
            padding: '1px 5px',
            borderRadius: inlineCodeRadius,
            fontSize: '0.923em',
            fontFamily: READER_FONT,
          }}
          {...props}
        >
          {children}
        </code>
      )
    },
    // 围栏代码块由上面的 code renderer 自己出 <pre>，这里剥掉嵌套避免双层容器
    pre({ children }) {
      return <>{children}</>
    },
    a({ href, children }) {
      return <MarkdownLink href={href}>{children}</MarkdownLink>
    },
    table({ children }) {
      return (
        <div style={{ overflowX: 'auto', margin: '8px 0' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '0.923em', width: '100%' }}>
            {children}
          </table>
        </div>
      )
    },
    th({ children }) {
      return (
        <th style={{ border: '1px solid var(--border-subtle)', padding: '4px 8px', background: 'var(--bg-elevated)', textAlign: 'left' }}>
          {children}
        </th>
      )
    },
    td({ children }) {
      return (
        <td style={{ border: '1px solid var(--border-subtle)', padding: '4px 8px' }}>
          {children}
        </td>
      )
    },
  }
}

export function MarkdownCore({
  text,
  className,
  style,
  codeRadius = 0,
  inlineCodeRadius = 0,
  components,
}: MarkdownCoreProps) {
  const merged = useMemo(
    () => ({ ...makeComponents({ codeRadius, inlineCodeRadius }), ...components }),
    [codeRadius, inlineCodeRadius, components],
  )
  return (
    <div
      className={className}
      style={{ fontFamily: READER_FONT, fontSize: '1em', lineHeight: 1.6, ...style }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={merged}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
