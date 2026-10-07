import { describe, it, expect } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MarkdownCore } from './MarkdownCore'

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
