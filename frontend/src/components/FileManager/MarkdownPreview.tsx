import { useMemo, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { MarkdownCore, MarkdownLink } from '../Common/MarkdownCore'
import { OverlayScroll } from '../Common/OverlayScroll'
import { getParentPath } from '../../utils/path'
import { buildFileDownloadUrl, resolveRelativeRef, slugifyHeading } from './filePreviewShared'

interface MarkdownPreviewProps {
  content: string
  /** 当前 md 的绝对路径 —— 文档内相对引用的解析基准 */
  filePath: string
  /** session 模式优先，否则 workspace 模式（与 FilePreview 同一组参数） */
  sessionId?: string
  workspaceId?: string
  projectId?: string | null
  /** 点击仓库内相对链接时，让抽屉切到目标文件 */
  onOpenFile?: (path: string) => void
}

/** 把 heading 的子节点（可能含 `**bold**` 等元素）压成纯文本，用于算锚点 id */
function textOf(children: ReactNode): string {
  if (children == null || typeof children === 'boolean') return ''
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(textOf).join('')
  if (typeof children === 'object' && 'props' in children) {
    return textOf((children as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

type HeadingTag = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'

function makeHeading(Tag: HeadingTag): Components[HeadingTag] {
  return ({ children }) => (
    <Tag id={slugifyHeading(textOf(children))}>{children}</Tag>
  )
}

const HEADING_COMPONENTS = Object.fromEntries(
  (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as HeadingTag[]).map((tag) => [tag, makeHeading(tag)]),
)

/**
 * 文件抽屉的 markdown 渲染视图。
 *
 * 与聊天面板共用 `Common/MarkdownCore`；这里只负责「文档在仓库里」特有的部分：
 * 相对图片 → 下载端点、相对链接 → 切换抽屉文件、heading 锚点 id。
 * 不渲染文档内嵌 HTML（react-markdown 默认行为，未启用 rehype-raw）—— 仓库文件
 * 属不可信输入，这是安全默认而非功能缺失。
 */
export function MarkdownPreview({
  content,
  filePath,
  sessionId,
  workspaceId,
  projectId,
  onOpenFile,
}: MarkdownPreviewProps) {
  const baseDir = getParentPath(filePath)

  const components = useMemo<Components>(
    () => ({
      ...HEADING_COMPONENTS,
      img({ src, alt }) {
        const abs = typeof src === 'string' ? resolveRelativeRef(baseDir, src) : null
        if (!abs) return <img src={src} alt={alt ?? ''} loading="lazy" />
        return (
          <img
            src={buildFileDownloadUrl(abs, { sessionId, workspaceId, projectId })}
            alt={alt ?? abs.split('/').pop() ?? ''}
            loading="lazy"
          />
        )
      },
      a({ href, children }) {
        // 锚点：heading 已注入 id，交给浏览器原生滚动，不要开新标签
        if (typeof href === 'string' && href.startsWith('#')) {
          return <a href={href} style={{ color: 'var(--accent)' }}>{children}</a>
        }
        const abs = typeof href === 'string' ? resolveRelativeRef(baseDir, href) : null
        if (!abs) return <MarkdownLink href={href}>{children}</MarkdownLink>
        return (
          <a
            href={href}
            style={{ color: 'var(--accent)' }}
            onClick={(e) => {
              e.preventDefault()
              onOpenFile?.(abs)
            }}
          >
            {children}
          </a>
        )
      },
    }),
    [baseDir, sessionId, workspaceId, projectId, onOpenFile],
  )

  return (
    <OverlayScroll style={{ height: '100%' }} contentClassName="fm-md-scroll">
      <MarkdownCore text={content} className="file-markdown" components={components} />
    </OverlayScroll>
  )
}
