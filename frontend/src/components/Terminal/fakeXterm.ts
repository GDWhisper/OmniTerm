/**
 * 测试专用 xterm 替身（jsdom 无 canvas，真实 xterm 无法 open）。
 * 独立成普通模块的原因：Terminal.testUtils.tsx 的 `vi.mock('@xterm/xterm')`
 * 工厂要在工厂内 import 本类（工厂运行先于任何模块体，无法引用外部变量），
 * 测试代码与 mock 工厂由此共享同一个类身份（instances 注册表才对得上）。
 */
export class FakeXterm {
  static instances: FakeXterm[] = []
  cols = 80
  rows = 24
  options: Record<string, unknown> = {}
  element: HTMLElement | null = null
  focusCount = 0
  disposed = false
  // Unicode11Addon 激活宽表用（useTerminal.createTerminal，2026-09-09）
  unicode = { activeVersion: '' }
  constructor() {
    FakeXterm.instances.push(this)
  }
  open(container: HTMLElement) {
    // 假体在容器上落一个 .xterm 元素，测试可断言哪个容器承载终端
    const el = document.createElement('div')
    el.className = 'xterm'
    el.appendChild(document.createElement('textarea'))
    container.appendChild(el)
    this.element = el
  }
  loadAddon() {}
  focus() {
    this.focusCount += 1
  }
  write() {}
  writeln() {}
  reset() {}
  dispose() {
    this.disposed = true
    this.element?.remove()
    this.element = null
  }
  onData() {
    return { dispose() {} }
  }
  onResize() {
    return { dispose() {} }
  }
  onTitleChange() {
    return { dispose() {} }
  }
  attachCustomKeyEventHandler() {}
  attachCustomWheelEventHandler() {}
  getSelection() {
    return ''
  }
}
