import { describe, it, expect } from 'vitest'
import { getParentPath } from '../../utils/path'
import {
  MAX_MARKDOWN_PREVIEW_LINES,
  buildFileDownloadUrl,
  countLines,
  isImageFile,
  isMarkdownFile,
  resolveRelativeRef,
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
