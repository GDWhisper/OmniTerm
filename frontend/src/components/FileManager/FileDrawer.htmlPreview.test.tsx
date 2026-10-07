import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { api } from '../../api/client'
import { FileDrawer } from './FileDrawer'
import { MAX_HTML_PREVIEW_BYTES } from './filePreviewShared'

/**
 * html 渲染预览的接线回归防线（真实缺陷场景：agent 在远程开发机生成
 * 自包含 html，用户无法本地浏览器打开，omniterm 此前只能看源码）。
 *
 * 覆盖三条主路径 + 两条边界：
 * - view 模式：iframe + sandbox，srcdoc 里相对引用已改写成 download URL
 *   （HtmlPreview 拿到的是 FileDrawer 的 scope，三个参数错一个 URL 就错）
 * - edit 模式：不进渲染，回落 CodeMirror 源码
 * - 超过字节上限：提示 + 退源码，不建 iframe
 * - htm 扩展名同族走渲染
 */
vi.mock('../../api/client', () => ({
  api: {
    readFile2: vi.fn().mockResolvedValue({ content: '', is_text: true }),
    writeFile2: vi.fn().mockResolvedValue({}),
  },
}))

const HTML_DOC = [
  '<!DOCTYPE html>',
  '<html><head><link rel="stylesheet" href="./style.css"></head>',
  '<body><a href="https://example.com">x</a><a href="#top">t</a></body></html>',
].join('')

const noop = () => {}

function renderDrawer(filePath: string, initialMode: 'view' | 'edit' = 'view') {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <FileDrawer
          filePath={filePath}
          sessionId="s1"
          projectId="p1"
          workspaceRoot="/repo"
          onClose={noop}
          height={300}
          onHeightChange={noop}
          fileChangeEvent={null}
          initialMode={initialMode}
        />
      </I18nextProvider>,
    )
  })
  return container
}

function iframe(container: HTMLElement): HTMLIFrameElement | null {
  return container.querySelector('iframe')
}

describe('FileDrawer html 渲染预览', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    const readFile2Mock = vi.mocked(api.readFile2)
    readFile2Mock.mockReset()
    readFile2Mock.mockImplementation(async ({ path }) => ({
      content: path.endsWith('.htm') ? HTML_DOC : 'x'.repeat(MAX_HTML_PREVIEW_BYTES + 1),
      is_text: true,
    }))
  })

  it('view 模式渲染 sandboxed iframe，相对引用改写为 download URL', async () => {
    const readFile2Mock = vi.mocked(api.readFile2)
    readFile2Mock.mockImplementation(async () => ({ content: HTML_DOC, is_text: true }))
    const container = renderDrawer('/repo/page.html')
    await vi.waitFor(() => expect(iframe(container)).toBeTruthy(), { timeout: 4000 })

    const el = iframe(container)!
    // 安全边界：allow-scripts 但不给 allow-same-origin（opaque origin）
    expect(el.getAttribute('sandbox')).toBe('allow-scripts')
    const srcdoc = el.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('href="/api/v1/files/download?session=s1&amp;path=%2Frepo%2Fstyle.css&amp;v=0&amp;inline=true"')
    // 外链与锚点保持原样
    expect(srcdoc).toContain('href="https://example.com"')
    expect(srcdoc).toContain('href="#top"')
  })

  it('edit 模式不进渲染预览，回落源码编辑器', async () => {
    const container = renderDrawer('/repo/page.html', 'edit')
    await vi.waitFor(
      () => expect(container.querySelector('.cm-editor')).toBeTruthy(),
      { timeout: 4000 },
    )
    expect(iframe(container)).toBeNull()
  })

  it('超过渲染字节上限：提示「文件过大」且不建 iframe（退回源码）', async () => {
    const container = renderDrawer('/repo/huge.html')
    await vi.waitFor(
      () => expect(container.querySelector('.fm-preview-notice')).toBeTruthy(),
      { timeout: 4000 },
    )
    expect(iframe(container)).toBeNull()
  })

  it('htm 扩展名同样走渲染（.htm 与 .html 同族）', async () => {
    const container = renderDrawer('/repo/page.htm')
    await vi.waitFor(() => expect(iframe(container)).toBeTruthy(), { timeout: 4000 })
    expect(iframe(container)!.getAttribute('srcdoc')).toContain('style.css')
  })
})
