import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { FileEditor } from './FileEditor'

/**
 * 抽屉文件编辑器内搜索的行为锁定：
 * - Ctrl/Cmd+F 在编辑器容器捕获阶段被拦截（defaultPrevented）并打开面板，
 *   而不是放行浏览器内置查找——这条是用户报告的缺口本体
 * - 查询 → 全量高亮 + 计数；Aa 区分大小写切换实时收窄匹配
 * - Esc 收起面板并通知受控方
 *
 * 匹配计算的边界（正则非法 / 零长匹配 / 截断）在 fileSearch.test.ts 纯函数层。
 */

const SAMPLE = 'foo bar foo baz FOO'

function renderEditor(content: string, onOpenChange?: (open: boolean) => void) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const Harness = () => {
    const [open, setOpen] = useState(false)
    return (
      <FileEditor
        content={content}
        editable={false}
        fileName="sample.txt"
        searchOpen={open}
        onSearchOpenChange={(v) => {
          setOpen(v)
          onOpenChange?.(v)
        }}
      />
    )
  }
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <Harness />
      </I18nextProvider>,
    )
  })
  return { container, root }
}

/** 等 CodeMirror 挂载完成（语言加载是异步的，即便 txt 无加载器也过一个微任务） */
async function waitForEditor(container: HTMLElement) {
  await vi.waitFor(
    () => {
      expect(container.querySelector('.cm-editor')).toBeTruthy()
    },
    { timeout: 4000 },
  )
}

async function waitForSearchPanel(container: HTMLElement) {
  let input: HTMLInputElement | null = null
  await vi.waitFor(() => {
    input = container.querySelector('.fm-editor-search-input')
    expect(input).toBeTruthy()
  })
  return input as unknown as HTMLInputElement
}

/** 在编辑器内容上派发 Ctrl+F（捕获阶段应被容器监听器拦下） */
async function pressCtrlF(container: HTMLElement) {
  const target = container.querySelector('.cm-content') as HTMLElement
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

/** React 受控输入框：走原生 value setter + input 事件（无 testing-library） */
async function typeQuery(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('FileEditor in-editor search', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
  })

  it('intercepts Ctrl+F and opens the drawer search panel instead of the browser find', async () => {
    const onOpenChange = vi.fn()
    const rendered = renderEditor('hello world', onOpenChange)
    container = rendered.container
    root = rendered.root
    await waitForEditor(container)

    const event = await pressCtrlF(container)

    // 浏览器内置查找被拦下（否则焦点会跑到整页查找条上）
    expect(event.defaultPrevented).toBe(true)
    expect(onOpenChange).toHaveBeenCalledWith(true)

    const input = await waitForSearchPanel(container)
    // 打开即聚焦并全选：Ctrl+F 之后直接键入即替换旧查询
    expect(document.activeElement).toBe(input)
  })

  it('highlights every match and shows the running count', async () => {
    const rendered = renderEditor(SAMPLE)
    container = rendered.container
    root = rendered.root
    await waitForEditor(container)

    await pressCtrlF(container)
    const input = await waitForSearchPanel(container)
    await typeQuery(input, 'foo')

    await vi.waitFor(() => {
      expect(container.querySelector('.fm-editor-search-count')?.textContent).toBe('1/3')
    })
    // 三处匹配全部高亮，其中当前命中带选中档类名（omnitermTheme 提亮配色）
    expect(container.querySelectorAll('.cm-searchMatch').length).toBe(3)
    expect(container.querySelectorAll('.cm-searchMatch-selected').length).toBe(1)
  })

  it('case-sensitive toggle narrows the match set live', async () => {
    const rendered = renderEditor(SAMPLE)
    container = rendered.container
    root = rendered.root
    await waitForEditor(container)

    await pressCtrlF(container)
    const input = await waitForSearchPanel(container)
    await typeQuery(input, 'foo')
    await vi.waitFor(() => {
      expect(container.querySelector('.fm-editor-search-count')?.textContent).toBe('1/3')
    })

    const toggle = container.querySelector('.fm-editor-search-toggle') as HTMLButtonElement
    await act(async () => {
      toggle.click()
    })

    // 区分大小写后只剩两处小写 foo
    await vi.waitFor(() => {
      expect(container.querySelector('.fm-editor-search-count')?.textContent).toBe('1/2')
    })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('Escape in the search input closes the panel', async () => {
    const onOpenChange = vi.fn()
    const rendered = renderEditor(SAMPLE, onOpenChange)
    container = rendered.container
    root = rendered.root
    await waitForEditor(container)

    await pressCtrlF(container)
    const input = await waitForSearchPanel(container)

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })

    await vi.waitFor(() => {
      expect(container.querySelector('.fm-editor-search')).toBeFalsy()
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
