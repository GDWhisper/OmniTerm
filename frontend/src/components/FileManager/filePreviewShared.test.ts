import { describe, it, expect } from 'vitest'
import { getParentPath } from '../../utils/path'
import {
  MAX_HTML_PREVIEW_BYTES,
  MAX_INLINE_EDIT_BYTES,
  MAX_MARKDOWN_PREVIEW_LINES,
  buildFileDownloadUrl,
  buildFileInlineUrl,
  canInlineEdit,
  isDirEntry,
  countLines,
  isHtmlFile,
  isImageFile,
  isMarkdownFile,
  resolveRelativeRef,
  rewriteHtmlForPreview,
  shouldRenderHtml,
  shouldRenderMarkdown,
  slugifyHeading,
} from './filePreviewShared'

/** 以某个 md 的绝对路径为基准解析相对引用 */
const inDoc = (docPath: string, ref: string) => resolveRelativeRef(getParentPath(docPath), ref)
const DOC = '/repo/docs/guide.md'

describe('resolveRelativeRef', () => {
  it('解析同目录与子目录引用（有无 ./ 前缀皆可）', () => {
    expect(inDoc(DOC, './diagram.png')).toBe('/repo/docs/diagram.png')
    expect(inDoc(DOC, 'diagram.png')).toBe('/repo/docs/diagram.png')
    expect(inDoc(DOC, 'img/sub/a.png')).toBe('/repo/docs/img/sub/a.png')
  })

  it('解码 %XX 以便作为 path 查询参数传给下载端点', () => {
    expect(inDoc(DOC, './my%20chart.png')).toBe('/repo/docs/my chart.png')
  })

  it('剥掉本地文件无意义的 query 与 fragment', () => {
    expect(inDoc(DOC, 'a.png?v=2')).toBe('/repo/docs/a.png')
    expect(inDoc(DOC, 'b.md#install')).toBe('/repo/docs/b.md')
  })

  it('外链、协议相对、mailto、锚点一律不重写', () => {
    for (const ref of ['http://x/a.png', 'https://x/a.png', '//cdn/x/a.png', 'mailto:a@b.c', '#sec', '']) {
      expect(inDoc(DOC, ref)).toBeNull()
    }
  })

  it('含 .. 的引用不解析 —— 越界判定权威在后端 fs::sanitize_path', () => {
    expect(inDoc(DOC, '../secrets.env')).toBeNull()
    expect(inDoc(DOC, 'sub/../../etc/passwd')).toBeNull()
  })

  it('绝对路径引用不猜语义（仓库根 or 文件系统根），保持原样', () => {
    expect(inDoc(DOC, '/assets/a.png')).toBeNull()
    expect(inDoc(DOC, 'C:/assets/a.png')).toBeNull()
  })

  it('畸形百分号编码不抛错，退回不解析', () => {
    expect(inDoc(DOC, 'a%zz.png')).toBeNull()
  })

  it('文件位于文件系统根时基准目录为空，仍拼出绝对路径', () => {
    expect(resolveRelativeRef(getParentPath('/readme.md'), './a.png')).toBe('/a.png')
  })
})

describe('扩展名分类', () => {
  it('md/markdown 走渲染，图片走图片预览，大小写不敏感', () => {
    expect(isMarkdownFile('README.md')).toBe(true)
    expect(isMarkdownFile('NOTES.MARKDOWN')).toBe(true)
    expect(isMarkdownFile('notes.txt')).toBe(false)
    expect(isMarkdownFile('Makefile')).toBe(false)
    expect(isImageFile('a.PNG')).toBe(true)
    expect(isImageFile('a.md')).toBe(false)
  })

  it('无扩展名文件不误判为 markdown（Makefile 的 ext 会退化成整名）', () => {
    expect(isMarkdownFile('.markdownrc')).toBe(false)
  })

  it('html/htm 走渲染预览，大小写不敏感', () => {
    expect(isHtmlFile('page.html')).toBe(true)
    expect(isHtmlFile('INDEX.HTM')).toBe(true)
    expect(isHtmlFile('index.xhtml')).toBe(false)
    expect(isHtmlFile('a.md')).toBe(false)
  })
})

describe('shouldRenderHtml（渲染预览判据：扩展名 + 字节上限）', () => {
  const bytes = (n: number) => 'x'.repeat(n)

  it('上限内的 html 走渲染', () => {
    expect(shouldRenderHtml('a.html', bytes(MAX_HTML_PREVIEW_BYTES))).toBe(true)
  })

  it('超过 1 字节即退回源码', () => {
    expect(shouldRenderHtml('a.html', bytes(MAX_HTML_PREVIEW_BYTES + 1))).toBe(false)
  })

  it('多字节字符按 UTF-8 字节计（上限维度是字节不是字符数）', () => {
    // 每字符 3 字节：ceil(MAX/3) 个字符 Unicode 长度不足上限，UTF-8 长度必超
    const cjk = '中'.repeat(Math.ceil(MAX_HTML_PREVIEW_BYTES / 3))
    expect(shouldRenderHtml('a.html', cjk)).toBe(false)
  })

  it('非 html 不参与渲染判定，且不去数字节', () => {
    expect(shouldRenderHtml('a.rs', bytes(MAX_HTML_PREVIEW_BYTES + 1))).toBe(false)
  })
})

describe('rewriteHtmlForPreview（srcdoc 化：相对引用改写 / base 剥离）', () => {
  const HTML = '/repo/research/page.html'
  const dl = (p: string) => `/api/v1/files/download?session=s1&path=${encodeURIComponent(p)}&v=0&inline=true`

  it('相对 src/href 改写成 inline download URL（script/css/img，会话作用域）', () => {
    const html = [
      '<link rel="stylesheet" href="./style.css">',
      '<script src="app.js"></script>',
      '<img src="img/a.png">',
      '<a href="sub/b.html">b</a>',
    ].join('')
    const out = rewriteHtmlForPreview(html, HTML, { sessionId: 's1' })
    expect(out).toContain(`href="${dl('/repo/research/style.css').replace(/&/g, '&amp;')}"`)
    expect(out).toContain(`src="${dl('/repo/research/app.js').replace(/&/g, '&amp;')}"`)
    expect(out).toContain(`src="${dl('/repo/research/img/a.png').replace(/&/g, '&amp;')}"`)
    expect(out).toContain(`href="${dl('/repo/research/sub/b.html').replace(/&/g, '&amp;')}"`)
  })

  it('workspace 作用域带 workspace_id 与 workspace 参数', () => {
    const out = rewriteHtmlForPreview('<img src="a.png">', HTML, { workspaceId: 'w1', projectId: 'p1' })
    const url = '/api/v1/files/download?workspace_id=w1&workspace=p1&path=%2Frepo%2Fresearch%2Fa.png&v=0&inline=true'
    expect(out).toContain(`src="${url.replace(/&/g, '&amp;')}"`)
  })

  it('外链 / 协议相对 / 锚点 / mailto 不改写', () => {
    const html = [
      '<a href="https://example.com/x">x</a>',
      '<a href="//cdn.example.com/a.css">c</a>',
      '<a href="#top">t</a>',
      '<a href="mailto:a@b.c">m</a>',
    ].join('')
    const out = rewriteHtmlForPreview(html, HTML, { sessionId: 's1' })
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('href="//cdn.example.com/a.css"')
    expect(out).toContain('href="#top"')
    expect(out).toContain('href="mailto:a@b.c"')
  })

  it('含 .. 的引用不解析（越界判定权威在后端），保持原样', () => {
    const out = rewriteHtmlForPreview('<img src="../secret.png">', HTML, { sessionId: 's1' })
    expect(out).toContain('src="../secret.png"')
  })

  it('<base href> 一律剥掉——它会改掉整篇的相对解析基准', () => {
    const out = rewriteHtmlForPreview('<base href="https://evil.example/"><img src="a.png">', HTML, { sessionId: 's1' })
    expect(out).not.toContain('<base')
    expect(out).toContain(`src="${dl('/repo/research/a.png').replace(/&/g, '&amp;')}"`)
  })

  it('补回 doctype——DOMParser 序列化会丢，缺了进 quirks mode', () => {
    const out = rewriteHtmlForPreview('<html><body><p>x</p></body></html>', HTML, { sessionId: 's1' })
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
  })

  it('无相对引用的自包含页面原样通过（外链 CDN 不受影响）', () => {
    const html = '<html><head><link href="https://fonts.googleapis.com/css2?family=X" rel="stylesheet"></head><body>ok</body></html>'
    expect(rewriteHtmlForPreview(html, HTML, { sessionId: 's1' })).toContain('https://fonts.googleapis.com/css2?family=X')
  })
})

describe('buildFileInlineUrl（html 预览子资源专用端点参数）', () => {
  it('session 作用域带 inline=true', () => {
    expect(buildFileInlineUrl('/a b.css', { sessionId: 's1' })).toBe(
      '/api/v1/files/download?session=s1&path=%2Fa%20b.css&v=0&inline=true',
    )
  })

  it('workspace 作用域同样带 inline=true', () => {
    expect(buildFileInlineUrl('/a.css', { workspaceId: 'w1', projectId: 'p1' })).toBe(
      '/api/v1/files/download?workspace_id=w1&workspace=p1&path=%2Fa.css&v=0&inline=true',
    )
  })
})

describe('shouldRenderMarkdown', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n')

  it('上限内的 md 渲染', () => {
    expect(shouldRenderMarkdown('a.md', lines(MAX_MARKDOWN_PREVIEW_LINES))).toBe(true)
  })

  it('超过上限退回源码', () => {
    expect(shouldRenderMarkdown('a.md', lines(MAX_MARKDOWN_PREVIEW_LINES + 1))).toBe(false)
  })

  it('非 md 文件不参与渲染判定，且不去数行数', () => {
    expect(shouldRenderMarkdown('a.rs', lines(MAX_MARKDOWN_PREVIEW_LINES + 10))).toBe(false)
  })

  it('countLines 与状态栏口径一致', () => {
    expect(countLines('')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
  })
})

describe('buildFileDownloadUrl', () => {
  it('session 模式带 session 参数', () => {
    expect(buildFileDownloadUrl('/a b.png', { sessionId: 's1' }, 3)).toBe(
      '/api/v1/files/download?session=s1&path=%2Fa%20b.png&v=3',
    )
  })

  it('workspace 模式带 workspace_id 与 workspace，缺省版本号为 0', () => {
    expect(buildFileDownloadUrl('/a.png', { workspaceId: 'w1', projectId: 'p1' })).toBe(
      '/api/v1/files/download?workspace_id=w1&workspace=p1&path=%2Fa.png&v=0',
    )
  })
})

describe('slugifyHeading', () => {
  it('贴近 GitHub 规则：小写、剥标点、空白折叠成 -', () => {
    expect(slugifyHeading('Hello, World!')).toBe('hello-world')
    expect(slugifyHeading('  Multiple   Spaces  ')).toBe('multiple-spaces')
    expect(slugifyHeading('API v2 — Changes')).toBe('api-v2-changes')
  })

  it('保留 CJK（本仓库文档标题多为中文）', () => {
    expect(slugifyHeading('1. 核心规则')).toBe('1-核心规则')
  })

  it('纯符号标题退化成空串（不会产生假锚点）', () => {
    expect(slugifyHeading('---')).toBe('')
  })
})

describe('canInlineEdit（行内编辑入口判据）', () => {
  const K = 1024

  it('普通文件在阈值内给入口', () => {
    expect(canInlineEdit(500 * K, 'File')).toBe(true)
  })

  it('恰好等于阈值仍给入口（<= 而非 <）', () => {
    expect(canInlineEdit(MAX_INLINE_EDIT_BYTES, 'File')).toBe(true)
  })

  it('超过 1 字节即不给入口', () => {
    expect(canInlineEdit(MAX_INLINE_EDIT_BYTES + 1, 'File')).toBe(false)
  })

  it('软链接文件与普通文件同判据', () => {
    expect(canInlineEdit(10, 'SymlinkFile')).toBe(true)
    expect(canInlineEdit(MAX_INLINE_EDIT_BYTES + 1, 'SymlinkFile')).toBe(false)
  })

  it('目录一律不给入口（size 对目录是条目数不是字节）', () => {
    expect(canInlineEdit(0, 'Dir')).toBe(false)
    expect(canInlineEdit(3, 'Dir')).toBe(false)
    expect(canInlineEdit(3, 'SymlinkDir')).toBe(false)
  })

  it('size 未知时放行——保守姿态，不能编辑由 FileDrawer 兜底', () => {
    expect(canInlineEdit(null, 'File')).toBe(true)
    expect(canInlineEdit(null, 'SymlinkFile')).toBe(true)
  })

  it('空文件给入口', () => {
    expect(canInlineEdit(0, 'File')).toBe(true)
  })
})

describe('isDirEntry（目录判据单一真源）', () => {
  it('目录与软链接目录都算目录', () => {
    expect(isDirEntry('Dir')).toBe(true)
    expect(isDirEntry('SymlinkDir')).toBe(true)
  })

  it('文件与软链接文件不算目录', () => {
    expect(isDirEntry('File')).toBe(false)
    expect(isDirEntry('SymlinkFile')).toBe(false)
  })

  it('未知 path_type 按非目录处理（不因拼写差异把文件当目录藏掉入口）', () => {
    expect(isDirEntry('')).toBe(false)
    expect(isDirEntry('dir')).toBe(false)
  })
})
