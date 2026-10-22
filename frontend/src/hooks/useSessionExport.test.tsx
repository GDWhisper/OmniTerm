import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useSessionExport } from './useSessionExport'
import { useToastStore } from '../stores/toastStore'
import { useAgentStore } from '../stores/agentStore'
import type { Session } from '../api/client'
import '../i18n'

// F08 会话导出 Markdown 的接线（docs/dev/plans/2026-10-21-acp-session-markdown-export.md）：
// 侧栏会话右键/长按菜单 → 独立分页拉全量 → 复用单条 messageToMarkdown 拼装 →
// Blob 下载。序列化规则本身在 utils/sessionMarkdown.test.ts 纯函数级覆盖，
// 这里只验接线（入口在 Sidebar，导出的是**指定会话**、与当前打开谁无关）。

const SESSION: Session = {
  id: 's1',
  project_id: 'p1',
  workspace_path: '/tmp/ws',
  name: 'demo',
  hook_enabled: false,
  created_at: '2026-10-21T00:00:00Z',
  runtime_kind: 'acp',
  agent_id: 'a1',
}

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
/** 依次返回的 /messages 分页（测试用例在点击前填好）。 */
let pages: Array<{ messages: unknown[]; nextCursor?: string | null }>
let blobs: Blob[]
let originalCreate: unknown
let originalRevoke: unknown

/** 一页 DB 行（wire 形态，经 toChatMessages 转换）。 */
const dbRow = (id: string, role: 'user' | 'assistant', text: string, at: string) => ({
  id,
  role,
  text,
  createdAt: at,
  blocks: null,
  status: 'complete',
})

/** 极简宿主：把 hook 暴露的 exportSession 绑到一个按钮上。 */
function Harness({ session }: { session: Session }) {
  const { exportSession } = useSessionExport()
  return (
    <button type="button" onClick={() => void exportSession(session)}>
      export
    </button>
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useToastStore.setState({ toasts: [] })
  useAgentStore.setState({ agents: [] })

  blobs = []
  originalCreate = (URL as unknown as Record<string, unknown>).createObjectURL
  originalRevoke = (URL as unknown as Record<string, unknown>).revokeObjectURL
  // jsdom 不实现 blob URL（实测 createObjectURL 为 undefined），此处补最小桩。
  ;(URL as unknown as Record<string, unknown>).createObjectURL = (b: Blob) => {
    blobs.push(b)
    return 'blob:mock'
  }
  ;(URL as unknown as Record<string, unknown>).revokeObjectURL = () => {}

  // 不真的触发导航（jsdom 的 anchor click 会报 "Not implemented"）。
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

  // 按 URL 分派，而不是按调用顺序：hook 挂载时会先拉一次 agent 注册表
  // （导出件要 agent 名 + 未命名会话的显示名），顺序式 mock 会把它错当成
  // /messages 的第一页。
  pages = []
  let pageIndex = 0
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (!url.includes('/messages')) {
      return { ok: true, status: 200, json: async () => [] } as unknown as Response
    }
    const page = pages[pageIndex++] ?? { messages: [] }
    return { ok: true, status: 200, json: async () => page } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  ;(URL as unknown as Record<string, unknown>).createObjectURL = originalCreate
  ;(URL as unknown as Record<string, unknown>).revokeObjectURL = originalRevoke
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderHarness(session: Session = SESSION) {
  act(() => root.render(<Harness session={session} />))
}

function exportButton(): HTMLButtonElement {
  const btn = container.querySelector<HTMLButtonElement>('button')
  if (!btn) throw new Error('未找到导出按钮')
  return btn
}

describe('useSessionExport', () => {
  it('独立分页拉全量并下载含全部消息的 Markdown', async () => {
    pages = [
      {
        messages: [dbRow('row-2', 'assistant', '第二条', '2026-10-21T09:00:02Z')],
        nextCursor: 'cursor-1',
      },
      {
        messages: [dbRow('row-1', 'user', '第一条', '2026-10-21T09:00:01Z')],
        nextCursor: null,
      },
    ]

    renderHarness()
    await act(async () => {
      exportButton().click()
    })

    // 两页都拉了（第二页带 before 游标）——不复用界面上已加载的页。
    const urls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((u) => u.includes('/messages'))
    expect(urls).toHaveLength(2)
    expect(urls[1]).toContain('before=cursor-1')

    expect(blobs).toHaveLength(1)
    const content = await blobs[0].text()
    expect(content).toContain('第一条')
    expect(content).toContain('第二条')
    // 时间正序：先出现的应是较早的那条。
    expect(content.indexOf('第一条')).toBeLessThan(content.indexOf('第二条'))
    // 头部文案跟随界面语言（测试环境语言为 en —— jsdom 的 navigator 是 en-US）。
    expect(content).toContain('# Session export: demo')
    expect(content).toContain('Exported at:')
  })

  it('导出的是被指定的会话（与当前打开哪个会话无关）', async () => {
    pages = [{ messages: [], nextCursor: null }]
    renderHarness({ ...SESSION, id: 'other-session', name: '另一个' })
    await act(async () => {
      exportButton().click()
    })
    const url = String(fetchMock.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/messages')))
    expect(url).toContain('/sessions/other-session/messages')
  })

  it('导出成功给出条数 toast', async () => {
    pages = [
      {
        messages: [dbRow('row-1', 'user', '你好', '2026-10-21T09:00:01Z')],
        nextCursor: null,
      },
    ]
    renderHarness()
    await act(async () => {
      exportButton().click()
    })
    expect(useToastStore.getState().toasts.some((t) => t.type === 'success')).toBe(true)
  })

  it('拉取失败给出错误 toast，不静默', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (!String(input).includes('/messages')) {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response
      }
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response
    })
    renderHarness()
    await act(async () => {
      exportButton().click()
    })
    expect(blobs).toHaveLength(0)
    expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true)
  })
})
