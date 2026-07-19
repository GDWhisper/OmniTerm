import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { READER_FONT } from '../../utils/fonts'

export function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-markdown" style={{ fontFamily: READER_FONT, fontSize: 13, lineHeight: 1.6 }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '')
            const codeStr = String(children).replace(/\n$/, '')
            if (match) {
              return (
                <SyntaxHighlighter
                  style={oneDark}
                  language={match[1]}
                  PreTag="div"
                  customStyle={{ margin: '8px 0', borderRadius: 6, fontSize: 12 }}
                >
                  {codeStr}
                </SyntaxHighlighter>
              )
            }
            return (
              <code
                className={className}
                style={{
                  background: 'var(--bg-elevated)',
                  padding: '1px 5px',
                  borderRadius: 3,
                  fontSize: 12,
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
                <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
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
