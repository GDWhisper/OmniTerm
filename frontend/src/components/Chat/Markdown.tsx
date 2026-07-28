import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { READER_FONT } from '../../utils/fonts'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown" style={{ fontFamily: READER_FONT, fontSize: '1em', lineHeight: 1.6 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // TECH-DEBT: [react-markdown code 组件 props 用 any] | Markdown.tsx 13行 | 根因：pnpm 严格 node_modules 使同一 @types/react 经两条路径被 tsc 实例化为两份模块实例，导致显式类型化后 <code {...props}> 触发 Ref/VoidOrUndefinedOnly 双类型不兼容（tsc -b 报错）。去重需调整 pnpm 去重/hoist 策略，超出质量门禁范围。升级路径：对齐 @types/react 单实例（pnpm dedupe 或 overrides）后改为显式 React.HTMLAttributes 类型并移除本 disable。
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
                  customStyle={{ margin: '8px 0', borderRadius: 6, fontSize: '0.923em' }}
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
                  borderRadius: 3,
                  fontSize: '0.923em',
                  fontFamily: READER_FONT,
                }}
                {...props}
              >
                {children}
              </code>
            )
          },
          pre({ children }) {
            return <>{children}</>
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                {children}
              </a>
            )
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
