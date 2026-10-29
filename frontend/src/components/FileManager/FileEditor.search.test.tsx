import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { EditorView } from '@codemirror/view'
import i18n from '../../i18n'
import { FileEditor } from './FileEditor'
import * as fileSearch from './fileSearch'

/**
 * 抽屉文件编辑器内搜索的行为锁定：
 * - Ctrl/Cmd+F 在编辑器容器捕获阶段被拦截（defaultPrevented）并打开面板，
 *   而不是放行浏览器内置查找——这条是用户报告的缺口本体
 * - 查询 → 全量高亮 + 计数；Aa 区分大小写切换实时收窄匹配
 * - Enter / Shift+Enter / ↓ / ↑ 逐个跳转匹配并同步编辑器选区；查询逐键收窄时
 *   视口跟随首个匹配（参数变化必然重新定位）；文档编辑重算不抢用户光标
 * - Esc 收起面板并通知受控方
 *
 * 匹配计算的边界（正则非法 / 零长匹配 / 截断）在 fileSearch.test.ts 纯函数层。
 */

const SAMPLE = 'foo bar foo baz FOO'
/** 'a' 首匹配在 0，'ap' 首匹配只在末行（from=10）：验证逐键输入时定位跟随收窄 */
const NAV_SAMPLE = 'alpha\nzzz\napricot'

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

/** 在搜索输入框上派发按键（返回事件，供 defaultPrevented 断言） */
async function pressKey(input: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await act(async () => {
    input.dispatchEvent(event)
  })
  return event
}

/** 当前选中档（.cm-searchMatch-selected）在全部渲染匹配中的序号，-1 = 不在 DOM */
function selectedOrdinal(container: HTMLElement): number {
  const all = [...container.querySelectorAll('.cm-searchMatch')]
  return all.findIndex((el) => el.classList.contains('cm-searchMatch-selected'))
}

/** 从 DOM 找 CodeMirror 实例（选区断言用） */
function getView(container: HTMLElement): EditorView {
  const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)
  expect(view).toBeTruthy()
  return view!
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
    vi.restoreAllMocks()
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

  it('navigates matches with Enter / Shift+Enter / ArrowDown / ArrowUp', async () => {
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
    expect(selectedOrdinal(container)).toBe(0)

    await pressKey(input, 'Enter')
    await vi.waitFor(() => expect(selectedOrdinal(container)).toBe(1))

    await pressKey(input, 'ArrowDown')
    await vi.waitFor(() => expect(selectedOrdinal(container)).toBe(2))

    await pressKey(input, 'ArrowUp')
    await vi.waitFor(() => expect(selectedOrdinal(container)).toBe(1))

    await pressKey(input, 'Enter', { shiftKey: true })
    await vi.waitFor(() => expect(selectedOrdinal(container)).toBe(0))

    // 回绕：第一个再往上回到最后一个
    await pressKey(input, 'ArrowUp')
    await vi.waitFor(() => expect(selectedOrdinal(container)).toBe(2))
  })

  it('leaves navigation keys to the IME while composing', async () => {
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

    // 组合态（中文候选词确认/选择）：Enter 与 ↓ 不导航、不 preventDefault
    const enter = await pressKey(input, 'Enter', { isComposing: true })
    expect(enter.defaultPrevented).toBe(false)
    expect(container.querySelector('.fm-editor-search-count')?.textContent).toBe('1/3')

    const down = await pressKey(input, 'ArrowDown', { isComposing: true })
    expect(down.defaultPrevented).toBe(false)
    expect(selectedOrdinal(container)).toBe(0)
  })

  it('moves the editor selection onto the focused match', async () => {
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

    let sel = getView(container).state.selection.main
    expect([sel.from, sel.to]).toEqual([0, 3])

    await pressKey(input, 'Enter')
    await vi.waitFor(() => expect(selectedOrdinal(container)).toBe(1))
    sel = getView(container).state.selection.main
    expect([sel.from, sel.to]).toEqual([8, 11])
  })

  it('jumps to the first match while typing narrows the query', async () => {
    const spy = vi.spyOn(EditorView, 'scrollIntoView')
    const rendered = renderEditor(NAV_SAMPLE)
    container = rendered.container
    root = rendered.root
    await waitForEditor(container)

    await pressCtrlF(container)
    const input = await waitForSearchPanel(container)

    await typeQuery(input, 'a')
    await vi.waitFor(() => {
      expect(container.querySelector('.fm-editor-search-count')?.textContent).toBe('1/3')
    })
    expect(spy.mock.calls.at(-1)?.[0]).toBe(0)

    await typeQuery(input, 'ap')
    await vi.waitFor(() => {
      expect(container.querySelector('.fm-editor-search-count')?.textContent).toBe('1/1')
    })
    // 修复点：查询收窄后首匹配换到末行，参数变化必须重新定位而不是被「已在 0」拦截
    expect(spy.mock.calls.at(-1)?.[0]).toBe(10)
  })

  it('does not re-scroll on document edits while the match index is unchanged', async () => {
    const spy = vi.spyOn(EditorView, 'scrollIntoView')
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
    const callsBefore = spy.mock.calls.length

    // 模拟用户在编辑器里打字：docVersion 触发的重算不应抢走光标/视口
    await act(async () => {
      getView(container).dispatch({ changes: { from: 0, insert: 'x' } })
    })
    await vi.waitFor(() => {
      expect(container.querySelector('.fm-editor-search-count')?.textContent).toBe('1/3')
    })
    expect(spy.mock.calls.length).toBe(callsBefore)
  })

  // 2026-10-10 计划 ④：查询输入防抖（SEARCH_INPUT_DEBOUNCE_MS=150）。computeMatches
  // 是全文档同步扫描（+ fileSearch 的 1 万匹配上限），大文件逐键重扫会卡输入；连续
  // 键入合并为停顿后的一次计算，受控回显仍即时。
  it('debounces match computation: consecutive keystrokes compute once', async () => {
    const computeSpy = vi.spyOn(fileSearch, 'computeMatches')
    const rendered = renderEditor(NAV_SAMPLE)
    container = rendered.container
    root = rendered.root
    await waitForEditor(container)

    await pressCtrlF(container)
    const input = await waitForSearchPanel(container)

    // 两次键入落在同一防抖窗口内（act 同步连打，150ms 未到）。
    await typeQuery(input, 'a')
    await typeQuery(input, 'ap')

    // 只有防抖后的最终查询触发一次计算（无防抖 = 'a'、'ap' 各一次）。
    await vi.waitFor(() => {
      expect(container.querySelector('.fm-editor-search-count')?.textContent).toBe('1/1')
    })
    expect(computeSpy).toHaveBeenCalledTimes(1)
    expect(computeSpy.mock.calls[0][1]).toMatchObject({ query: 'ap' })
  })
})
