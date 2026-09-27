import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { useAppStore } from '../../stores/appStore'
import { FileManager } from './FileManager'

/**
 * **接线回归防线**：`FileManager → FileDrawer` 的 `initialMode` 传递。
 *
 * 这条链路就是 X08 那个 structural gap 的**唯一修法所在**：store 的
 * `drawerMode` 早已存在却无人消费（FileDrawer 的 mode 原是内部 state）。
 * `FileDrawer.initialMode.test.tsx` 直接渲染 FileDrawer 传 prop，**绕过
 * FileManager**——把 `FileManager.tsx:1353` 的 `initialMode={...}` 那行删掉，
 * 那 5 条测试全绿。故此处必须是 FileManager 级：渲染整个面板、点行内编辑
 * 图标、断言最终抽屉真的进了编辑态，删接线即转红。
 */

vi.mock('../../hooks/useTerminalEngine', () => ({
  useTerminalEngine: () => 'pty',
}))

vi.mock('../../hooks/useFileWatcher', () => ({
  useFileWatcher: () => ({ lastEvent: null }),
}))

vi.mock('./useFileDrag', () => ({
  useFileDrag: () => ({
    // FileManager 解构为 `preview: dragPreview`
    preview: { visible: false, x: 0, y: 0, icon: 'file', names: [] },
    dropTarget: null,
    isDragging: false,
    suppressClick: { current: false },
    tableWrapRef: { current: null },
  }),
}))

vi.mock('../../api/client', () => ({
  api: {
    listFiles2: vi.fn().mockResolvedValue({
      files: [
        { path_type: 'File', name: 'editable.ts', mtime: 1_700_000_000_000, size: 200 },
        { path_type: 'File', name: 'huge.ts', mtime: 1_700_000_000_000, size: 5 * 1024 * 1024 },
        { path_type: 'Dir', name: 'src', mtime: 1_700_000_000_000, size: 3 },
      ],
      cwd: '/repo',
      is_outside_workspace: false,
      workspace_root: '/repo',
    }),
    readFile2: vi.fn().mockResolvedValue({ content: 'const a = 1\n', is_text: true }),
    writeFile2: vi.fn().mockResolvedValue({}),
  },
}))

const SESSION = 's1'
const PROJECT = 'p1'

async function mountFileManager(root: ReturnType<typeof createRoot>) {
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <FileManager />
      </I18nextProvider>,
    )
  })
  // 等 listFiles2 的 promise 落地。刻意用真实定时器而非把 waitFor 包进 act：
  // act 的 async 作用域会吞掉 pending 的 microtask，使 waitFor 永不结束。
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300))
  })
  const text = document.body.textContent ?? ''
  if (!text.includes('editable.ts')) {
    throw new Error('file list did not render; body=' + text.slice(0, 200))
  }
}

/** 行内动作单元格的第 N 个图标（顺序见 FM_COL 与 JSX：copy / edit / rename / delete） */
function actionIconFor(rowName: string, index: number): HTMLElement | null {
  const rows = Array.from(document.body.querySelectorAll('tr'))
  const row = rows.find((tr) => tr.textContent?.includes(rowName))
  if (!row) return null
  const icons = Array.from(row.querySelectorAll('.fm-act-icon'))
  return (icons[index] as HTMLElement) ?? null
}

describe('FileManager 行内编辑入口 → 抽屉打开模式（接线回归）', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useAppStore.setState({
      activeSessionId: SESSION,
      activeProjectId: PROJECT,
      rightPanelTab: 'files',
      fmSessionStates: {},
    } as never)
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
    vi.clearAllMocks()
  })

  it('点行内编辑图标 ⇒ store drawerMode 变 edit', async () => {
    await mountFileManager(root)
    const editIcon = actionIconFor('editable.ts', 1)
    expect(editIcon, 'edit icon not found in the row').toBeTruthy()
    await act(async () => {
      editIcon!.click()
    })
    const st = useAppStore.getState().fmSessionStates[SESSION]
    expect(st?.drawerPath).toBe('/repo/editable.ts')
    expect(st?.drawerMode).toBe('edit')
  })

  it('接线贯通到抽屉：抽屉以编辑态出现（contenteditable=true）', async () => {
    await mountFileManager(root)
    const editIcon = actionIconFor('editable.ts', 1)
    await act(async () => {
      editIcon!.click()
    })
    // FileDrawer 随即挂载并懒加载 CodeMirror
    await act(async () => {
      await vi.waitFor(
        () => {
          expect(document.body.querySelector('.cm-editor')).toBeTruthy()
        },
        { timeout: 5000 },
      )
    })
    const content = document.body.querySelector('.cm-content')
    expect(content?.getAttribute('contenteditable')).toBe('true')
  })

  it('纯预览（单击行）仍是只读态 —— 编辑入口没有污染既有行为', async () => {
    await mountFileManager(root)
    const rows = Array.from(document.body.querySelectorAll('tr'))
    const row = rows.find((tr) => tr.textContent?.includes('editable.ts'))
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useAppStore.getState().fmSessionStates[SESSION]?.drawerMode).toBe('view')
  })

  it('超阈值文件不给编辑入口，但保留其余三个操作', async () => {
    await mountFileManager(root)
    const icons = Array.from(
      (Array.from(document.body.querySelectorAll('tr')).find((tr) =>
        tr.textContent?.includes('huge.ts'),
      ) as HTMLElement).querySelectorAll('.fm-act-icon'),
    )
    // copy / rename / delete 三个 + 一个退让的禁用图标（不可点）
    expect(icons.length).toBe(4)
    const disabled = icons.filter((i) => i.classList.contains('fm-act-icon-disabled'))
    expect(disabled.length).toBe(1)
    // 点击禁用图标不应打开抽屉
    await act(async () => {
      ;(disabled[0] as HTMLElement).click()
    })
    expect(useAppStore.getState().fmSessionStates[SESSION]?.drawerPath).toBeFalsy()
  })

  it('目录行不给编辑入口', async () => {
    await mountFileManager(root)
    const row = Array.from(document.body.querySelectorAll('tr')).find((tr) =>
      tr.textContent?.includes('src'),
    ) as HTMLElement
    const icons = Array.from(row.querySelectorAll('.fm-act-icon'))
    expect(icons.every((i) => !i.classList.contains('fm-act-icon-disabled'))).toBe(true)
    // 目录只有 copy/rename/delete
    expect(icons.length).toBe(3)
  })
})
