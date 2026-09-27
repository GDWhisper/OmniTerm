import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { FileDrawer } from './FileDrawer'

/**
 * initialMode（打开意图）的行为锁定：
 * - 传 'view' / 不传 → 编辑器只读（既有单击行预览行为）
 * - 传 'edit' → 以编辑态打开
 * - 换文件（filePath 变化）→ 回到**本次**传进来的意图，而不是无条件回 view
 *
 * 最后一条是本轮新增 structural gap 的回归防线：store 的 `drawerMode` 早已存在
 * 但无人消费，FileDrawer 的 mode 原是纯内部 state 且换文件恒置 'view'，
 * 「行内点编辑按钮 → 以编辑态打开」因此接不通。
 */
vi.mock('../../api/client', () => ({
  api: {
    readFile2: vi.fn().mockResolvedValue({ content: 'hello\nworld\n', is_text: true }),
    writeFile2: vi.fn().mockResolvedValue({}),
  },
}))

const noop = () => {}

function renderDrawer(props: Partial<Parameters<typeof FileDrawer>[0]> = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <FileDrawer
          filePath="/repo/a.ts"
          sessionId="s1"
          workspaceId={undefined}
          projectId="p1"
          workspaceRoot="/repo"
          onClose={noop}
          height={300}
          onHeightChange={noop}
          fileChangeEvent={null}
          {...props}
        />
      </I18nextProvider>,
    )
  })
  return { container, root }
}

/**
 * 等 CodeMirror 挂载完成（lazy 组件 + fetchContent 都是异步）。
 * 刻意用裸 vi.waitFor：把轮询包进 act(async) 会让 waitFor 永不结束
 * （实测 5/5 超时）。FileDrawer 收到内容后的 setState 因此会喷 act 警告，
 * 与仓库既有 FileEditor.dynamic.test.tsx 同源同形态，不额外处理。
 */
async function waitForEditor(container: HTMLElement) {
  await vi.waitFor(
    () => {
      expect(container.querySelector('.cm-editor')).toBeTruthy()
    },
    { timeout: 4000 },
  )
}

/**
 * 在同一组件实例上重渲染（不改 mount），用于验证「意图变化」与「换文件」
 * 两条路径。FileManager 复用同一 FileDrawer 实例，路径相同。
 */
async function rerenderDrawer(
  root: ReturnType<typeof createRoot>,
  filePath: string,
  initialMode: 'view' | 'edit',
) {
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <FileDrawer
          filePath={filePath}
          sessionId="s1"
          projectId="p1"
          workspaceRoot="/repo"
          onClose={noop}
          height={300}
          onHeightChange={noop}
          fileChangeEvent={null}
          initialMode={initialMode}
        />
      </I18nextProvider>,
    )
  })
}

function editorEditable(container: HTMLElement): boolean {
  return container.querySelector('.cm-content')?.getAttribute('contenteditable') === 'true'
}

describe('FileDrawer initialMode', () => {
  let container: HTMLElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
    vi.clearAllMocks()
  })

  it('不传 initialMode 时以预览（只读）打开 —— 既有单击行行为不变', async () => {
    ;({ container, root } = renderDrawer())
    await waitForEditor(container)
    expect(editorEditable(container)).toBe(false)
  })

  it("initialMode='view' 同样只读", async () => {
    ;({ container, root } = renderDrawer({ initialMode: 'view' }))
    await waitForEditor(container)
    expect(editorEditable(container)).toBe(false)
  })

  it("initialMode='edit' 以编辑态打开（store 的 drawerMode 真正被消费）", async () => {
    ;({ container, root } = renderDrawer({ initialMode: 'edit' }))
    await waitForEditor(container)
    expect(editorEditable(container)).toBe(true)
  })

  it('换文件后回到本次打开意图，而不是无条件回 view', async () => {
    ;({ container, root } = renderDrawer({ initialMode: 'edit' }))
    await waitForEditor(container)
    expect(editorEditable(container)).toBe(true)

    // 同一组件实例内切换 filePath（列表里点开另一个文件的编辑入口）
    await rerenderDrawer(root, '/repo/b.ts', 'edit')
    expect(editorEditable(container)).toBe(true)
  })

  it('从预览意图切到编辑意图时不被上一次的内部 state 粘住', async () => {
    // 先用 'view' 渲染一次（内部 state = view），再以 'edit' 重渲染同一实例。
    // 这是 FileManager 真实可达路径：先点行预览、再点同一文件的编辑按钮，
    // 此时 filePath 没变，只有意图变了。
    ;({ container, root } = renderDrawer({ initialMode: 'view' }))
    await waitForEditor(container)
    expect(editorEditable(container)).toBe(false)

    await rerenderDrawer(root, '/repo/a.ts', 'edit')
    expect(editorEditable(container)).toBe(true)
  })
})
