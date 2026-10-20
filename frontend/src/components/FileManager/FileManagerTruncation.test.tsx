import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { useAppStore } from '../../stores/appStore'
import { FileManager } from './FileManager'

/**
 * 截断提示 + 显式「加载全部」接线回归。
 *
 * 后端默认最多返回 MAX_LIST_ENTRIES 条并带 total/truncated；前端必须：
 * 1) 显示「前 N / 共 M 项」而不是静默当完整列表；
 * 2) 用户点「加载全部」时带 all=true 重新请求，并隐藏提示条。
 */

const mocks = vi.hoisted(() => ({
  listFiles2: vi.fn(),
}))

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
  api: { listFiles2: mocks.listFiles2 },
}))

const SESSION = 's1'
const PROJECT = 'p1'

const file = (i: number) => ({
  path_type: 'File' as const,
  name: `file-${String(i).padStart(3, '0')}.txt`,
  mtime: 1_700_000_000_000,
  size: 0,
})

function response(files: ReturnType<typeof file>[], total: number, truncated: boolean) {
  return { files, cwd: '/repo', is_outside_workspace: false, workspace_root: '/repo', total, truncated }
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

describe('FileManager 列表截断与加载全部', () => {
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
    mocks.listFiles2.mockImplementation(async (params: { all?: boolean }) =>
      params.all
        ? response([0, 1, 2, 3, 4].map(file), 5, false)
        : response([0, 1, 2].map(file), 6000, true),
    )
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
    vi.clearAllMocks()
  })

  it('显示截断提示；点「加载全部」带 all=true 并隐藏提示', async () => {
    await mount(root)

    const bar = document.querySelector('.fm-truncated-bar')
    expect(bar).toBeTruthy()
    expect(bar?.textContent).toContain('Showing first 3 of 6000 entries')

    const loadAll = document.querySelector('.fm-truncated-action') as HTMLElement
    expect(loadAll?.textContent).toContain('LOAD ALL')
    await act(async () => {
      loadAll.click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300))
    })

    expect(mocks.listFiles2).toHaveBeenLastCalledWith(expect.objectContaining({ all: true }))
    expect(document.querySelector('.fm-truncated-bar')).toBeNull()
    expect(document.body.textContent).toContain('file-003.txt')
  })
})
