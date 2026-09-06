import { describe, it, expect, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MarkdownPreview } from './MarkdownPreview'

// react-markdown 会把非 http(s) 的 URL 里的空格按原样带出，端点参数需 encodeURIComponent
const DOC = '/repo/docs/guide.md'

function renderPreview(ui: Parameters<Root['render']>[0]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(ui)
  })
  return {
    container,
    dispose: () => {
      act(() => root.unmount())
      document.body.removeChild(container)
    },
  }
}

function preview(content: string, onOpenFile = vi.fn()) {
  return {
    onOpenFile,
    ...renderPreview(
      <MarkdownPreview
        content={content}
        filePath={DOC}
        sessionId="s1"
        projectId={null}
        onOpenFile={onOpenFile}
      />,
    ),
  }
}

describe('MarkdownPreview 相对资源解析', () => {
  it('同目录图片 → 指向下载端点并带上以 md 所在目录为基准的绝对路径', () => {
    const { container, dispose } = preview('![chart](./diagram.png)')
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe(
      '/api/v1/files/download?session=s1&path=%2Frepo%2Fdocs%2Fdiagram.png&v=0',
    )
    dispose()
  })

  it('外部图片不重写，仍按原 URL 加载', () => {
    const { container, dispose } = preview('![x](https://cdn.example.com/a.png)')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://cdn.example.com/a.png')
    dispose()
  })

  it('含 .. 的图片引用不重写（不在前端做越界判定）', () => {
    const { container, dispose } = preview('![x](../../etc/passwd)')
    expect(container.querySelector('img')?.getAttribute('src')).toBe('../../etc/passwd')
    dispose()
  })
})

describe('MarkdownPreview 文档内链接', () => {
  it('点击相对链接 → 回调拿到解析后的绝对路径，并阻止浏览器导航', () => {
    const { container, dispose, onOpenFile } = preview('[guide](./sub/other.md)')
    const link = container.querySelector('a')!
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => {
      link.dispatchEvent(event)
    })
    expect(onOpenFile).toHaveBeenCalledWith('/repo/docs/sub/other.md')
    expect(event.defaultPrevented).toBe(true)
    dispose()
  })

  it('外部链接不拦截，走 MarkdownLink 的新标签策略', () => {
    const { container, dispose, onOpenFile } = preview('[site](https://example.com/)')
    const link = container.querySelector('a')!
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onOpenFile).not.toHaveBeenCalled()
    dispose()
  })

  it('锚点链接交给浏览器原生滚动，且不开新标签', () => {
    const { container, dispose } = preview('## 安装步骤\n\n[跳](#安装步骤)')
    const heading = container.querySelector('h2')
    // href 经 react-markdown 的 urlTransform 会被百分号编码，按位置取而非按字面匹配
    const anchor = [...container.querySelectorAll('a')].at(-1)!
    expect(heading?.id).toBe('安装步骤')
    expect(decodeURIComponent(anchor.getAttribute('href') ?? '')).toBe('#安装步骤')
    expect(anchor.hasAttribute('target')).toBe(false)
    dispose()
  })
})

describe('MarkdownPreview 渲染边界', () => {
  it('表格按 GFM 渲染成真实 table', () => {
    const { container, dispose } = preview('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(container.querySelectorAll('tbody tr').length).toBe(1)
    expect(container.querySelectorAll('th').length).toBe(2)
    dispose()
  })

  it('不渲染文档内嵌 HTML（未启用 rehype-raw，仓库文件属不可信输入）', () => {
    const { container, dispose } = preview('<img src=x onerror="window.__pwned=1">\n\nhello')
    // 内嵌 HTML 退化为纯文本：既没有真的 img 元素被创建，也不会执行属性里的脚本
    expect(container.querySelector('img')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
    expect(container.querySelector('.file-markdown')?.textContent).toContain('hello')
    dispose()
  })
})
