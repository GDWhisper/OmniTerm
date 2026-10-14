import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { useAppStore } from '../../stores/appStore'
import { FileManager } from './FileManager'

/**
 * X17 接线回归防线：自适应模式由 `<table>` 的 `fm-table-fit` 类 + 内联
 * `width:100%` 承载（让 table-layout:fixed 生效、列宽由 JS 精确分配）；
 * 用户点击列宽拖拽手柄后（`nameColAuto=false`）两者必须同步移除，回到
 * D5 的「固定列 + 横向滚动」行为。
 *
 * 只测接线：把 FileManager.tsx 里 `className={...}` / `style={...}` 的
 * 三元接线删成常量，本文件即转红（列宽算式本身在 fileTableLayout.test.ts）。
 */

vi.mock('../../hooks/useTerminalEngine', () => ({
  useTerminalEngine: () => 'pty',
}))

vi.mock('../../hooks/useFileWatcher', () => ({
  useFileWatcher: () => ({ lastEvent: null }),
}))

vi.mock('./useFileDrag', () => ({
  useFileDrag: () => ({
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
      files: [{ path_type: 'File', name: 'a.ts', mtime: 1_700_000_000_000, size: 100 }],
      cwd: '/repo',
      is_outside_workspace: false,
      workspace_root: '/repo',
    }),
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
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300))
  })
  if (!document.body.querySelector('.fm-table')) {
    throw new Error('file table did not render')
  }
  return document.body.querySelector('.fm-table') as HTMLElement
}

describe('FileManager 表格自适应接线（X17）', () => {
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

  it('自适应模式：table 带 fm-table-fit 类且内联 width:100%', async () => {
    const table = await mountFileManager(root)
    expect(table.classList.contains('fm-table-fit')).toBe(true)
    expect(table.style.width).toBe('100%')
  })

  it('点击列宽拖拽手柄（退出自适应）后：类与内联宽度同步移除', async () => {
    const table = await mountFileManager(root)
    const handle = table.querySelector('.fm-th-resize') as HTMLElement
    expect(handle, 'resize handle not found').toBeTruthy()
    await act(async () => {
      handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(table.classList.contains('fm-table-fit')).toBe(false)
    expect(table.style.width).toBe('')
  })
})
