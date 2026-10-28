import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MarkdownCore } from './MarkdownCore'
import { useToastStore } from '../../stores/toastStore'
// side-effect：初始化 i18next 实例，否则 useTranslation 在测试里拿不到资源
import '../../i18n'

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

describe('MarkdownCore 横向滚动面', () => {
  // data-x-scroll 是移动端切屏手势的抬手契约（Layout.tsx 的
  // PANE_SWIPE_LIFT_SELECTOR + index.css 的 touch-action）。桌面端完全不可见，
  // 属性一旦丢失（例如 SyntaxHighlighter 不再转发未知 prop）只有真机滑代码块
  // 才会发现，故在此钉住。
  it('围栏代码块带 data-x-scroll', () => {
    const { container, dispose } = renderMarkdown(
      <MarkdownCore text={'```ts\nconst answer = 42\n```'} />,
    )
    const block = container.querySelector('[data-x-scroll]')
    expect(block).toBeTruthy()
    expect(block?.tagName).toBe('DIV') // SyntaxHighlighter 的 PreTag="div"
    expect(block?.textContent).toContain('const answer = 42')
    dispose()
  })

  it('宽表格的滚动容器带 data-x-scroll', () => {
    const { container, dispose } = renderMarkdown(
      <MarkdownCore text={'| a | b |\n|---|---|\n| 1 | 2 |'} />,
    )
    const scroller = container.querySelector('div[data-x-scroll]')
    expect(scroller?.querySelector('table')).toBeTruthy()
    dispose()
  })

  it('普通段落不标记（切屏手势保持可用）', () => {
    const { container, dispose } = renderMarkdown(<MarkdownCore text="普通文本" />)
    expect(container.querySelector('[data-x-scroll]')).toBeNull()
    dispose()
  })
})

// 代码块复制入口属于代码块而不是气泡（2026-10-28 用户要求）：围栏块右上角
// 悬浮角标复制**代码原文**，去掉 Markdown 语法层带来的尾部换行。聊天气泡的块级
// 角标已移除（消息动作栏的「复制」覆盖整条消息），故这是聊天里复制代码的唯一入口。
describe('MarkdownCore 代码块复制', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    useToastStore.setState({ toasts: [] })
    // 恢复 jsdom 原始的「无 clipboard」状态，避免影响同文件后续断言
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })

  it('围栏代码块带复制按钮', () => {
    const { container, dispose } = renderMarkdown(
      <MarkdownCore text={'```ts\nconst answer = 42\n```'} />,
    )
    const btn = container.querySelector<HTMLButtonElement>('.md-code-copy-btn')
    expect(btn).toBeTruthy()
    // 角标挂在代码块的定位父元素下，而不是文档里游离的按钮
    expect(btn?.closest('.md-code-block')?.querySelector('[data-x-scroll]')).toBeTruthy()
    // 文案 key 必须存在，否则 title 会原样显示 `markdown.copyCode`
    expect(btn?.title).not.toBe('markdown.copyCode')
    dispose()
  })

  it('点击复制去掉尾部换行的代码原文并提示成功', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    const { container, dispose } = renderMarkdown(
      <MarkdownCore text={'```ts\nconst answer = 42\n```'} />,
    )
    const btn = container.querySelector<HTMLButtonElement>('.md-code-copy-btn')!
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // copyText 是异步的（clipboard 失败还要走 execCommand 兜底），等微任务落地
    await act(async () => {
      await Promise.resolve()
    })

    expect(writeText).toHaveBeenCalledWith('const answer = 42')
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].type).toBe('success')
    dispose()
  })
})
