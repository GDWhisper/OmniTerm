import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { useAppStore } from '../../stores/appStore'
import { FileManager } from './FileManager'
import { FM_ROW_HEIGHT, FM_VIRTUALIZE_THRESHOLD } from './fileListWindow'

/**
 * 虚拟滚动接线回归：大列表必须只挂可视区 + 上下 spacer，而不是全量行。
 *
 * jsdom 无布局（clientHeight 恒 0），FileManager 会走兜底可视行数；这正好
 * 让断言不依赖真实视口。滚动事件通过元素自己的 scrollTop 数据属性模拟。
 */

const FILE_COUNT = 500

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
      files: Array.from({ length: 500 }, (_, i) => ({
        path_type: 'File',
        name: `file-${String(i).padStart(3, '0')}.txt`,
        mtime: 1_700_000_000_000,
        size: 0,
      })),
      cwd: '/repo',
      is_outside_workspace: false,
      workspace_root: '/repo',
    }),
  },
}))

const SESSION = 's1'
const PROJECT = 'p1'

function realRows(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll('.fm-table tbody tr')).filter(
    (tr) => !tr.classList.contains('fm-spacer-row'),
  ) as HTMLElement[]
}

function renderedNames(): string[] {
  return realRows().map((tr) => tr.querySelector('.fm-td-name')?.textContent?.trim() ?? '')
}

async function mount(root: ReturnType<typeof createRoot>) {
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
  if (!document.body.textContent?.includes('file-000.txt')) {
    throw new Error('file list did not render; body=' + (document.body.textContent ?? '').slice(0, 200))
  }
}

describe('FileManager 大列表虚拟滚动', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    await i18n.changeLanguage('en')
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

  it('超过阈值只渲染可视窗口，并保留上下 spacer', async () => {
    await mount(root)

    expect(FILE_COUNT).toBeGreaterThan(FM_VIRTUALIZE_THRESHOLD)
    const names = renderedNames()
    expect(names.length).toBeLessThan(FILE_COUNT)
    expect(names.length).toBeGreaterThan(0)
    expect(document.body.querySelector('.fm-spacer-row')).toBeTruthy()
  })

  it('滚动后窗口前移，spacer 总高度保持全量行高', async () => {
    await mount(root)
    const scroller = document.querySelector('.fm-table-scroll') as HTMLDivElement
    expect(scroller).toBeTruthy()

    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      writable: true,
      value: FM_ROW_HEIGHT * 300,
    })
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    const names = renderedNames()
    expect(names).not.toContain('file-000.txt')
    expect(names).toContain('file-300.txt')

    const spacers = Array.from(document.body.querySelectorAll<HTMLElement>('.fm-spacer-row td'))
    const spacerTotal = spacers.reduce((sum, td) => sum + (parseInt(td.style.height, 10) || 0), 0)
    expect(spacerTotal + names.length * FM_ROW_HEIGHT).toBe(FILE_COUNT * FM_ROW_HEIGHT)
  })
})
