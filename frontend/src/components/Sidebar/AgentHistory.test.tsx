import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { AgentHistory } from './AgentHistory'
import { useAppStore } from '../../stores/appStore'
import { useAgentStore } from '../../stores/agentStore'
import type { AgentAcpSession } from '../../api/client'

const listSpy = vi.fn()

vi.mock('../../api/client', () => ({
  api: {
    listAgentAcpSessions: (...args: unknown[]) => listSpy(...args),
  },
}))

/**
 * 测试环境经 LanguageDetector 按 navigator 探测语言，在 zh 机器上解析成中文、
 * 其余机器成英文——断言会随机器翻。这里显式钉成 en，断言写英文原文。
 */
beforeEach(() => {
  void i18n.changeLanguage('en')
})

function setup(
  opts: {
    sessions?: AgentAcpSession[]
    truncated?: boolean
    reject?: Error
  } = {},
) {
  listSpy.mockReset()
  if (opts.reject) listSpy.mockRejectedValue(opts.reject)
  else
    listSpy.mockResolvedValue({
      sessions: opts.sessions ?? [],
      truncated: opts.truncated ?? false,
    })

  useAppStore.setState({
    activeProjectId: 'proj-1',
    activeWorkspaceId: 'wt-1',
    worktrees: {
      'proj-1': [
        {
          id: 'wt-1',
          project_id: 'proj-1',
          path: '/tmp/proj',
          label: 'main',
          is_main: true,
          is_git_repo: true,
          is_git_worktree: false,
        },
      ],
    },
    sessions: {},
    lastAcpAgentId: null,
    activateSession: vi.fn(),
  })
  useAgentStore.setState({
    agents: [
      { id: 'agent-1', display_name: 'Claude', command: 'claude', args: [], env: [], created_at: '', updated_at: '' },
      { id: 'agent-2', display_name: 'OpenCode', command: 'opencode', args: [], env: [], created_at: '', updated_at: '' },
    ],
    loaded: true,
  })
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render() {
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <AgentHistory />
      </I18nextProvider>,
    )
  })
}

/** 等一轮微任务 + 状态提交（面板加载是 async effect）。 */
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** 取**最深**的含目标文本的 div：外层容器 textContent 同样含该文本，点到它不会
 *  触发行内的 onClick（事件从目标向上冒泡，不会向下捕获）。 */
function deepestDivWith(text: string): HTMLElement | undefined {
  const matches = Array.from(document.querySelectorAll('div')).filter((el) =>
    (el.textContent ?? '').includes(text),
  )
  return matches[matches.length - 1]
}

const SAMPLE: AgentAcpSession[] = [
  {
    session_id: 'ses_aaaaaaaaaaaaaaaaaaaa',
    cwd: '/tmp/proj',
    title: '检查待提交改动',
    updated_at: '2026-09-23T15:00:33.485Z',
    managed: false,
  },
  {
    // title 缺省（§8：omp 部分会话不给）→ 必须回落 session_id 截断，不是空行
    session_id: 'ses_bbbbbbbbbbbbbbbbbbbb',
    cwd: '/other/worktree',
    updated_at: undefined,
    managed: true,
  },
]

describe('AgentHistory', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    setup()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('展开时按 agent × cwd 自动拉一次，且不轮询', async () => {
    render()
    await flush()
    expect(listSpy).toHaveBeenCalledTimes(1)
    // 默认 agent 取 lastAcpAgentId（null）→ 列表第一个
    expect(listSpy).toHaveBeenCalledWith('agent-1', '/tmp/proj')
  })

  it('渲染标题；title 缺省时回落 session_id 截断', async () => {
    setup({ sessions: SAMPLE })
    render()
    await flush()
    const text = document.body.textContent ?? ''
    expect(text).toContain('检查待提交改动')
    expect(text).toContain('ses_bb…bbbbbb')
  })

  it('已纳管行点击 = 切换到该会话', async () => {
    setup({
      sessions: [
        {
          session_id: 'ses_managed',
          cwd: '/tmp/proj',
          title: '已纳管的会话',
          managed: true,
        },
      ],
    })
    // appStore.sessions 里有绑定同一 acp_session_id 的行
    useAppStore.setState({
      sessions: {
        'proj-1': [
          {
            id: 'local-1',
            project_id: 'proj-1',
            workspace_path: '/tmp/proj',
            name: '本地行',
            created_at: '2026-10-01T00:00:00Z',
            runtime_kind: 'acp',
            acp_session_id: 'ses_managed',
            agent_id: 'agent-1',
            hook_enabled: false,
          },
        ],
      },
    })
    const activateSession = vi.fn()
    useAppStore.setState({ activateSession })

    render()
    await flush()
    const row = deepestDivWith('已纳管的会话')
    expect(row).toBeTruthy()
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(activateSession).toHaveBeenCalledWith('local-1')
  })

  it('未纳管行不可点击（不偷偷建会话）', async () => {
    setup({ sessions: [SAMPLE[0]] })
    const activateSession = vi.fn()
    useAppStore.setState({ activateSession })
    render()
    await flush()
    const row = deepestDivWith('检查待提交改动')
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(activateSession).not.toHaveBeenCalled()
  })

  it('truncated 时显示截断提示（不得假装看全了）', async () => {
    setup({ sessions: SAMPLE, truncated: true })
    render()
    await flush()
    expect(document.body.textContent).toContain('List too long')
  })

  it('查询失败时显示 agent 原文错误，不是空白列表', async () => {
    setup({ reject: new Error('Method not found: session/list') })
    render()
    await flush()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Query failed')
    expect(text).toContain('Method not found: session/list')
  })

  it('空列表有空态文案', async () => {
    setup({ sessions: [] })
    render()
    await flush()
    expect(document.body.textContent).toContain('has no sessions')
  })

  it('没有活动工作区时不发请求', async () => {
    setup()
    useAppStore.setState({ activeWorkspaceId: 'wt-none' })
    render()
    await flush()
    expect(listSpy).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('Pick a workspace first')
  })
})
