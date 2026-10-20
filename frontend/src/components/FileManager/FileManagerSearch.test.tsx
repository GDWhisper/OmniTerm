import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { useAppStore } from '../../stores/appStore'
import { FileManager } from './FileManager'

/**
 * 搜索路径正确性回归：命中项必须按后端返回的 rel_path 计算完整路径。
 * 旧实现用 `cwd + name`，同名文件散落在不同目录时会打开错文件。
 */

const mocks = vi.hoisted(() => ({
  listFiles2: vi.fn(),
  searchFiles2: vi.fn(),
  readFile2: vi.fn(),
  writeFile2: vi.fn(),
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
  api: {
    listFiles2: mocks.listFiles2,
    searchFiles2: mocks.searchFiles2,
    readFile2: mocks.readFile2,
    writeFile2: mocks.writeFile2,
  },
}))

const SESSION = 's1'
const PROJECT = 'p1'

const RESULT_FILES = [
  {
    path_type: 'File',
    name: 'same.ts',
    rel_path: 'b/same.ts',
    mtime: 1_700_000_000_000,
    size: 20,
  },
  {
    path_type: 'File',
    name: 'same.ts',
    rel_path: 'a/same.ts',
    mtime: 1_700_000_000_000,
    size: 10,
  },
]

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
  if (!document.body.textContent?.includes('local.txt')) {
    throw new Error('file list did not render; body=' + (document.body.textContent ?? '').slice(0, 200))
  }
}

async function search(query: string) {
  const button = Array.from(document.querySelectorAll('.fm-btn')).find(
    (b) => b.getAttribute('title') === 'Search files',
  ) as HTMLElement
  await act(async () => {
    button.click()
  })
  const input = document.querySelector('.fm-search') as HTMLInputElement
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setValue.call(input, query)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300))
  })
}

describe('FileManager 搜索结果', () => {
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

    mocks.listFiles2.mockResolvedValue({
      files: [{ path_type: 'File', name: 'local.txt', mtime: 1_700_000_000_000, size: 10 }],
      cwd: '/repo',
      is_outside_workspace: false,
      workspace_root: '/repo',
      total: 1,
      truncated: false,
    })
    mocks.searchFiles2.mockResolvedValue({ files: RESULT_FILES, truncated: false })
    mocks.readFile2.mockResolvedValue({ content: '', is_text: true })
    mocks.writeFile2.mockResolvedValue({})
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
    vi.clearAllMocks()
  })

  it('显示相对路径，点击同名结果打开正确文件', async () => {
    await mount(root)
    await search('same')

    const paths = Array.from(document.querySelectorAll('.fm-search-relpath')).map((el) =>
      el.getAttribute('title'),
    )
    expect(paths).toEqual(['a/same.ts', 'b/same.ts'])

    const rowB = Array.from(document.querySelectorAll('.fm-table tbody tr')).find((tr) =>
      tr.querySelector('.fm-search-relpath[title="b/same.ts"]'),
    ) as HTMLElement
    expect(rowB).toBeTruthy()
    await act(async () => {
      rowB.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useAppStore.getState().fmSessionStates[SESSION]?.drawerPath).toBe('/repo/b/same.ts')
  })

  it('搜索态排序只重排本地结果，不发目录请求；清除后回到目录', async () => {
    await mount(root)
    await search('same')
    expect(document.querySelector('.fm-search-results-bar')?.textContent).toContain(
      'Search results for "same" (2)',
    )

    const listCalls = mocks.listFiles2.mock.calls.length
    const searchCalls = mocks.searchFiles2.mock.calls.length

    const sizeHeader = Array.from(document.querySelectorAll('.fm-th-sort')).find((el) =>
      el.textContent?.includes('Size'),
    ) as HTMLElement
    await act(async () => {
      sizeHeader.click()
    })

    expect(mocks.listFiles2.mock.calls.length).toBe(listCalls)
    expect(mocks.searchFiles2.mock.calls.length).toBe(searchCalls)
    expect(document.querySelector('.fm-search-results-bar')).toBeTruthy()

    const clear = document.querySelector('.fm-search-clear') as HTMLElement
    await act(async () => {
      clear.click()
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300))
    })

    expect(mocks.listFiles2.mock.calls.length).toBeGreaterThan(listCalls)
    expect(document.querySelector('.fm-search-results-bar')).toBeNull()
    expect(document.body.textContent).toContain('local.txt')
  })
})
