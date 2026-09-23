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
  // DECSET 解析态读口（cell_frame 模式中继的比对源，2026-09-23）：测试手动
  // 置值模拟「xterm 解析已生效」（真实翻转由 useTerminal.mouseSync.test.ts
  // 的真实 xterm 契约测试锁定）。
  modes = {
    bracketedPasteMode: false,
    mouseTrackingMode: 'none' as 'none' | 'vt200' | 'drag' | 'any',
  }
  /** write 调用记录（mouse_mode 同步串/幂等断言用，2026-09-23）。
   *  测试替身无上限 push：每次用例前清空、生命周期即单测运行期，P1 无界
   *  缓冲红线针对生产路径的累积，此处不适用（评审 nit 备注）。 */
  writes: string[] = []
  /** attachCustomWheelEventHandler 注册的 handler（滚轮放行断言用）。 */
  wheelHandler: ((ev: WheelEvent) => unknown) | null = null
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
  write(data: string | Uint8Array) {
    this.writes.push(String(data))
  }
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
  attachCustomWheelEventHandler(handler: (ev: WheelEvent) => unknown) {
    this.wheelHandler = handler
  }
  getSelection() {
    return ''
  }
}
