import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { useAppStore } from '../../stores/appStore'
import { OpenTerminalConfirmDialog, type OpenTerminalConfirmTarget } from './OpenTerminalConfirmDialog'

/**
 * 弹窗经 Modal → createPortal(document.body) 渲染，查询面向 document.body。
 * 引擎行断言依赖 appStore 的 defaultTerminalEngine × multiplexerAvailable
 * （useTerminalEngine 的收敛语义）：展示的必须是收敛后的实际引擎，
 * 宿主缺复用器时即使默认引擎是 tmux 也要显示 pty。
 */
describe('OpenTerminalConfirmDialog', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  const target: OpenTerminalConfirmTarget = {
    projectId: 'p1',
    projectName: 'OmniTerm',
    cwd: '/home/pax/coding/OmniTerm-dev',
  }

  beforeAll(async () => {
    // i18n 用 LanguageDetector，jsdom 下探测落 fallback 'en'；显式切 zh 让文案断言确定
    await i18n.changeLanguage('zh')
  })

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useAppStore.setState({ defaultTerminalEngine: 'tmux', multiplexerAvailable: true })
  })

  afterEach(() => {
    root.unmount()
    document.body.removeChild(container)
  })

  async function render(props: Parameters<typeof OpenTerminalConfirmDialog>[0]) {
    root.render(
      <I18nextProvider i18n={i18n}>
        <OpenTerminalConfirmDialog {...props} />
      </I18nextProvider>,
    )
    if (props.target) {
      await vi.waitFor(() => {
        expect(document.body.textContent).toContain(props.target!.projectName)
      })
    }
  }

  function clickButtonByText(text: string) {
    const btn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === text)
    expect(btn, `button "${text}" not found`).toBeTruthy()
    btn!.click()
  }

  it('renders nothing when closed', async () => {
    await render({ target: null, onClose: () => {}, onConfirm: () => {} })
    expect(document.body.textContent).not.toContain('OmniTerm')
  })

  it('shows project name, cwd and resolved engine', async () => {
    await render({ target, onClose: () => {}, onConfirm: () => {} })
    expect(document.body.textContent).toContain('将在现有项目「OmniTerm」下打开终端')
    expect(document.body.textContent).toContain(target.cwd)
    expect(document.body.textContent).toContain('引擎：tmux')
    // 引擎名提亮强调（--text-primary，非交互文字强调约定；accent 只给交互元素）
    const engineSpan = Array.from(document.body.querySelectorAll('p span'))
      .find((s): s is HTMLElement => s.textContent === 'tmux')
    expect(engineSpan).toBeTruthy()
    expect(engineSpan!.style.color).toBe('var(--text-primary)')
  })

  it('shows the fallback engine when host lacks the multiplexer', async () => {
    useAppStore.setState({ defaultTerminalEngine: 'tmux', multiplexerAvailable: false })
    await render({ target, onClose: () => {}, onConfirm: () => {} })
    expect(document.body.textContent).toContain('引擎：pty')
  })

  it('confirm passes projectId and cancel closes', async () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    await render({ target, onClose, onConfirm })
    clickButtonByText('打开终端')
    expect(onConfirm).toHaveBeenCalledWith('p1')
    clickButtonByText('取消')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
