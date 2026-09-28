import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { AuditLogSection } from './AuditLogSection'
import { api, type AuditEntry } from '../../api/client'

vi.mock('../../api/client', () => ({
  api: {
    getAuditLog: vi.fn(),
  },
}))

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1,
    actor: 'admin@192.168.1.7',
    action: 'file_write',
    target: 'src/main.rs',
    scope: 'project:p1',
    detail_json: null,
    created_at: new Date().toISOString(),
    ...over,
  }
}

describe('AuditLogSection（安全审计日志只读区块）', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    i18n.changeLanguage('en')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    vi.restoreAllMocks()
  })

  async function mount() {
    const React = await import('react')
    await React.act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <AuditLogSection />
        </I18nextProvider>,
      )
    })
    // 组件在 useEffect 里发请求；mock 的 promise 在 render 的 act 结束后才
    // settle。统一等到行/空态真的出现，避免「断言早于渲染」的偶发失败，
    // 也让 state 更新落进 act 作用域（项目用 vitest 自带 waitFor，未依赖
    // @testing-library/react）。
    await React.act(async () => {
      await vi.waitFor(() => {
        expect(
          container.querySelector('.audit-row') ?? container.querySelector('.audit-empty'),
        ).toBeTruthy()
      })
    })
  }

  it('renders one row per entry with action label, target and actor', async () => {
    vi.mocked(api.getAuditLog).mockResolvedValue({
      entries: [
        entry({ id: 2, action: 'git_push', target: '/tmp/repo' }),
        entry({ id: 1, action: 'file_delete', target: 'secret.txt' }),
      ],
    })
    await mount()

    const rows = container.querySelectorAll('.audit-row')
    expect(rows.length).toBe(2)
    // 顺序按后端返回（新→旧），不重排
    expect(rows[0].textContent).toContain('Git push')
    expect(rows[0].textContent).toContain('/tmp/repo')
    expect(rows[1].textContent).toContain('File delete')
    // actor 是追查的关键维度，必须出现在行内
    expect(container.textContent).toContain('admin@192.168.1.7')
  })

  it('renders the empty state when there are no records', async () => {
    vi.mocked(api.getAuditLog).mockResolvedValue({ entries: [] })
    await mount()
    expect(container.querySelector('.audit-empty')).toBeTruthy()
    expect(container.textContent).toContain('No audit records')
  })

  it('falls back to the raw action string for an unknown action', async () => {
    // 后端比前端新时不能渲染 "undefined" 或静默丢行
    vi.mocked(api.getAuditLog).mockResolvedValue({
      entries: [entry({ action: 'brand_new_action' as AuditEntry['action'] })],
    })
    await mount()
    expect(container.textContent).toContain('brand_new_action')
    expect(container.querySelector('.audit-row')).toBeTruthy()
  })

  it('does not throw when the request fails', async () => {
    vi.mocked(api.getAuditLog).mockRejectedValue(new Error('boom'))
    await mount()
    // 读不到审计不阻塞设置面板：退化为空态而不是崩溃
    expect(container.querySelector('.audit-empty')).toBeTruthy()
  })

  it('asks for a bounded page size', async () => {
    // 读口必须带 limit，否则可能拉全表
    vi.mocked(api.getAuditLog).mockResolvedValue({ entries: [] })
    await mount()
    expect(vi.mocked(api.getAuditLog).mock.calls[0][0]).toBe(60)
  })
})
