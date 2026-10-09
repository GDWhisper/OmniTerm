import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useChatStore } from '../../stores/chatStore'
import { DeleteConfirmDialog, type DeleteTarget } from './DeleteConfirmDialog'
import type { DeleteSessionResponse } from '../../api/client'

/**
 * 删除确认弹窗的「同时永久删除 agent 侧会话记录」勾选框（ACP 协议 session/delete
 * 的前端入口）。钉住三件事：
 *
 * 1. 判据 → 勾选框可用性（仅「agent 已知不支持」禁用；能力未知可勾选，后端会
 *    临时拉起短命 agent 补删）；
 * 2. 勾选 → `deleteSession(id, { deleteAgentSide: true })`，未勾选 → 不带该参数；
 * 3. **记忆用户选择**：确认删除后写入 localStorage，下次打开默认沿用。
 */

const deleteSession = vi.fn(
  async (): Promise<DeleteSessionResponse> => ({ ok: true, agent_side: 'deleted' }),
)
const addToast = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../api/client', () => ({
  api: {
    deleteProject: vi.fn(async () => ({ ok: true })),
    deleteSession: (...args: unknown[]) =>
      (deleteSession as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
  },
}))

vi.mock('../../stores/toastStore', () => ({
  useToastStore: (selector: (s: { addToast: typeof addToast }) => unknown) => selector({ addToast }),
}))

// appStore 只用到几个字段；直接 mock 成固定值（不影响 chatStore 的真实读取）。
vi.mock('../../stores/appStore', () => ({
  useAppStore: (
    selector: (s: Record<string, unknown>) => unknown,
  ) =>
    selector({
      activeProjectId: null,
      activeSessionId: null,
      workspaceSessionMemory: {},
      setActiveProject: vi.fn(),
      setActiveWorkspace: vi.fn(),
      setActiveSession: vi.fn(),
      setSessions: vi.fn(),
      clearWorkspaceSession: vi.fn(),
    }),
}))

const acpTarget: DeleteTarget = {
  type: 'session',
  id: 'sess-1',
  name: 'acp session',
  runtimeKind: 'acp',
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

function render(target: DeleteTarget | null) {
  act(() => {
    root.render(
      <DeleteConfirmDialog
        target={target}
        onClose={vi.fn()}
        reloadProjects={vi.fn(async () => {})}
        reloadSessions={vi.fn(async () => {})}
      />,
    )
  })
}

/** Checkboxes live in a portal on document.body, not in `container`. */
function checkboxes(): HTMLInputElement[] {
  return Array.from(document.body.querySelectorAll('input[type="checkbox"]'))
}

function clickConfirm() {
  const btn = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent === 'sidebar.delete' || b.textContent === 'sidebar.remove',
  )
  if (!btn) throw new Error('confirm button not found')
  act(() => {
    btn.click()
  })
}

function setCapability(supported: boolean | undefined) {
  useChatStore.setState({ states: { 'sess-1': { agentDeleteSupported: supported } as never } })
}

beforeEach(() => {
  localStorage.clear()
  deleteSession.mockClear()
  addToast.mockClear()
  useChatStore.setState({ states: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
})

describe('DeleteConfirmDialog · agent 侧记录勾选框', () => {
  it('shows a red, enabled checkbox when the agent is confirmed to support deletion', () => {
    setCapability(true)
    render(acpTarget)
    const boxes = checkboxes()
    expect(boxes).toHaveLength(1)
    expect(boxes[0].disabled).toBe(false)
    // 红字：danger 语义 → 用 --danger 作为 checkbox accent
    expect(boxes[0].style.accentColor).toContain('--danger')
    expect(document.body.textContent).toContain('sidebar.deleteAgentSideLabel')
  })

  it('does not show the checkbox for non-ACP sessions', () => {
    render({ ...acpTarget, runtimeKind: 'tmux' })
    expect(checkboxes()).toHaveLength(0)
  })

  it('keeps the checkbox enabled when the capability is unknown (backend probes on demand)', async () => {
    setCapability(undefined)
    render(acpTarget)
    const box = checkboxes()[0]
    expect(box.disabled).toBe(false)
    expect(box.checked).toBe(false)
    // 勾选后照常请求 agent 侧删除：后端现场拉起短命 agent 探明能力再决定
    act(() => box.click())
    clickConfirm()
    await act(async () => {})
    expect(deleteSession).toHaveBeenCalledWith('sess-1', { deleteAgentSide: true })
  })

  it('disables the checkbox when the agent is known to lack the capability', () => {
    setCapability(false)
    render(acpTarget)
    expect(checkboxes()[0].disabled).toBe(true)
    expect(document.body.textContent).toContain('sidebar.deleteAgentSideHintUnsupported')
  })

  it('reports the agent-side outcome truthfully (skipped is not "deleted")', async () => {
    setCapability(true)
    deleteSession.mockResolvedValueOnce({ ok: true, agent_side: 'skipped' })
    render(acpTarget)
    act(() => checkboxes()[0].click())
    clickConfirm()
    await act(async () => {})
    expect(addToast).toHaveBeenCalledWith('warning', 'sidebar.agentSideSkipped')
  })

  it('does not request agent-side deletion when unchecked', async () => {
    setCapability(true)
    render(acpTarget)
    clickConfirm()
    await act(async () => {})
    expect(deleteSession).toHaveBeenCalledWith('sess-1', { deleteAgentSide: false })
  })

  it('requests agent-side deletion when checked, and remembers the choice', async () => {
    setCapability(true)
    render(acpTarget)
    act(() => checkboxes()[0].click())
    clickConfirm()
    await act(async () => {})
    expect(deleteSession).toHaveBeenCalledWith('sess-1', { deleteAgentSide: true })
    expect(localStorage.getItem('omniterm_delete_agent_side')).toBe('true')
    expect(addToast).toHaveBeenCalledWith('success', 'sidebar.agentSideDeleted')
  })

  it('remembers an opt-out too (unchecking after a remembered opt-in sticks)', async () => {
    localStorage.setItem('omniterm_delete_agent_side', 'true')
    setCapability(true)
    render(acpTarget)
    const box = checkboxes()[0]
    expect(box.checked).toBe(true) // 记忆生效：默认沿用上次的勾选
    act(() => box.click()) // 取消勾选
    clickConfirm()
    await act(async () => {})
    expect(deleteSession).toHaveBeenCalledWith('sess-1', { deleteAgentSide: false })
    expect(localStorage.getItem('omniterm_delete_agent_side')).toBe('false')
  })

  it('does not overwrite the remembered choice when the checkbox was disabled', async () => {
    localStorage.setItem('omniterm_delete_agent_side', 'true')
    setCapability(false) // 已知不支持 → 禁用
    render(acpTarget)
    clickConfirm()
    await act(async () => {})
    // 禁用是系统限制而非用户表达：偏好必须原样保留
    expect(localStorage.getItem('omniterm_delete_agent_side')).toBe('true')
    expect(deleteSession).toHaveBeenCalledWith('sess-1', { deleteAgentSide: false })
  })
})
