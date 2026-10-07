import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Markdown } from './Markdown'
import { useAppStore } from '../../stores/appStore'

function renderMarkdown(ui: Parameters<Root['render']>[0]) {
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

describe('Chat Markdown 链接拦截', () => {
  let revealPathInFileManagerMock: (sessionId: string, reportedPath: string, isDirectory?: boolean) => void

  beforeEach(() => {
    revealPathInFileManagerMock = vi.fn()
    useAppStore.setState({
      activeSessionId: 'sess-123',
      revealPathInFileManager: revealPathInFileManagerMock,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('本地相对路径链接点击时在文件抽屉中打开', () => {
    const { container, dispose } = renderMarkdown(<Markdown text="请查阅 [开发计划](docs/plan.md)" />)
    const link = container.querySelector('a')
    expect(link).toBeTruthy()
    expect(link?.textContent).toBe('开发计划')
    expect(link?.getAttribute('href')).toBe('docs/plan.md')

    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    expect(revealPathInFileManagerMock).toHaveBeenCalledTimes(1)
    expect(revealPathInFileManagerMock).toHaveBeenCalledWith('sess-123', 'docs/plan.md', false)
    dispose()
  })

  it('带行号后缀的本地路径点击时剥离行号并在文件抽屉中打开', () => {
    const { container, dispose } = renderMarkdown(
      <Markdown text="见代码 [main 入口](src/main.rs:42) 和 [行区间](src/lib.rs:10-25)" />,
    )
    const links = container.querySelectorAll('a')
    expect(links.length).toBe(2)

    act(() => {
      links[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(revealPathInFileManagerMock).toHaveBeenCalledWith('sess-123', 'src/main.rs', false)

    act(() => {
      links[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(revealPathInFileManagerMock).toHaveBeenCalledWith('sess-123', 'src/lib.rs', false)
    dispose()
  })

  it('带 #L 锚点的本地路径点击时剥离并在抽屉打开', () => {
    const { container, dispose } = renderMarkdown(<Markdown text="见 [引用代码](frontend/src/App.tsx#L10)" />)
    const link = container.querySelector('a')
    expect(link).toBeTruthy()

    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(revealPathInFileManagerMock).toHaveBeenCalledWith('sess-123', 'frontend/src/App.tsx', false)
    dispose()
  })

  it('外部网页链接不被拦截，在新标签页打开', () => {
    const { container, dispose } = renderMarkdown(<Markdown text="访问 [官网](https://github.com/foo/bar)" />)
    const link = container.querySelector('a')
    expect(link).toBeTruthy()
    expect(link?.getAttribute('href')).toBe('https://github.com/foo/bar')
    expect(link?.getAttribute('target')).toBe('_blank')

    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(revealPathInFileManagerMock).not.toHaveBeenCalled()
    dispose()
  })

  it('点击形如目录的行内代码（如 `/home/pax/coding/OmniTerm-dev`）导航到目录', () => {
    const { container, dispose } = renderMarkdown(
      <Markdown text="当前工作区：`/home/pax/coding/OmniTerm-dev`" />,
    )
    const code = container.querySelector('code')
    expect(code).toBeTruthy()
    expect(code?.textContent).toBe('/home/pax/coding/OmniTerm-dev')

    act(() => {
      code?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    expect(revealPathInFileManagerMock).toHaveBeenCalledTimes(1)
    expect(revealPathInFileManagerMock).toHaveBeenCalledWith('sess-123', '/home/pax/coding/OmniTerm-dev', true)
    dispose()
  })

  it('点击形如文件的行内代码（如 `src/main.rs`）在抽屉打开文件', () => {
    const { container, dispose } = renderMarkdown(
      <Markdown text="查看 `src/main.rs`" />,
    )
    const code = container.querySelector('code')
    expect(code).toBeTruthy()

    act(() => {
      code?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    expect(revealPathInFileManagerMock).toHaveBeenCalledWith('sess-123', 'src/main.rs', false)
    dispose()
  })

  it('普通非路径行内代码（如 `hello world`）不带有点击跳转', () => {
    const { container, dispose } = renderMarkdown(
      <Markdown text="运行 `npm test` 命令" />,
    )
    const code = container.querySelector('code')
    expect(code).toBeTruthy()

    act(() => {
      code?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    expect(revealPathInFileManagerMock).not.toHaveBeenCalled()
    dispose()
  })

  it('streaming 模式下作为纯文本渲染，不触发 markdown 解析', () => {
    const { container, dispose } = renderMarkdown(<Markdown text="[测试链接](src/a.ts)" streaming={true} />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('[测试链接](src/a.ts)')
    dispose()
  })

  // 回归：自定义 code renderer 曾 `return undefined` 试图把围栏块交回默认 renderer，
  // 但 react-markdown 同一 key 一旦接管就会把返回 undefined 的节点整块吞掉 ——
  // 带 ```md 代码块的 agent 输出整条不显示。现在必须显式渲染内容。
  it('围栏代码块内容仍然渲染（不整条消失）', () => {
    const { container, dispose } = renderMarkdown(
      <Markdown text={'```md\n/home/pax/coding/OmniTerm-dev/AGENTS.md\n```'} />,
    )
    expect(container.textContent).toContain('/home/pax/coding/OmniTerm-dev/AGENTS.md')
    dispose()
  })

  it('围栏代码块与行内路径代码可以共存', () => {
    const { container, dispose } = renderMarkdown(
      <Markdown text={'当前工作区：`/home/pax/coding/OmniTerm-dev`\n\n```md\n/home/pax/coding/OmniTerm-dev/AGENTS.md\n```'} />,
    )
    expect(container.textContent).toContain('/home/pax/coding/OmniTerm-dev')
    expect(container.textContent).toContain('/home/pax/coding/OmniTerm-dev/AGENTS.md')
    dispose()
  })
})
