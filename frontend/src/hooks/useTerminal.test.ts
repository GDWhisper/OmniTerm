import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import { useTerminal } from './useTerminal'

// vi.mock 工厂里的 FakeTerminal 带 static instances 收集器；类型层 import 到的
// 仍是真实 @xterm/xterm 类型（mock 只在运行时生效），故此处按测试视角收窄。
const FakeTerminalCtor = Terminal as unknown as {
  instances: Array<{ unicode: { activeVersion: string } }>
}

// Probe-component pattern (no @testing-library/react in deps),
// following useCellFrame.test.ts.

// ──────────────────────────────────────────────────────────
// 模块 mock（vi.mock 工厂必须自包含，不能引用顶层变量）
// ──────────────────────────────────────────────────────────

vi.mock('@xterm/xterm', () => {
  class FakeTerminal {
    static instances: FakeTerminal[] = []
    constructor() {
      FakeTerminal.instances.push(this)
    }
    cols = 80
    rows = 24
    options: { fontSize?: number } = {}
    modes = { bracketedPasteMode: false, mouseTrackingMode: 'none' as const }
    writes: string[] = []
    // Unicode11Addon 激活宽表用（useTerminal.createTerminal，2026-09-09）
    unicode = { activeVersion: '' }
    write(data: string | Uint8Array): void {
      this.writes.push(String(data))
    }
    writeln(data: string): void {
      this.writes.push(String(data))
    }
    reset(): void {
      this.writes.length = 0
    }
    open(): void {}
    loadAddon(): void {}
    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    onTitleChange(): { dispose: () => void } {
      return { dispose: () => {} }
    }
    focus(): void {}
    paste(): void {}
    scrollLines(): void {}
    getSelection(): string {
      return ''
    }
    dispose(): void {}
  }
  return { Terminal: FakeTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 }
    }
    dispose(): void {}
  },
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    dispose(): void {}
  },
}))

vi.mock('@xterm/addon-unicode11', () => ({
  Unicode11Addon: class {
    dispose(): void {}
  },
}))

vi.mock('./useAttention', () => ({
  useAttention: () => ({ fire: () => {}, clearAlert: () => {} }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { t: (k: string) => k } }),
}))

// ──────────────────────────────────────────────────────────
// FakeWebSocket：记录 send 内容，暴露手动事件触发器
// ──────────────────────────────────────────────────────────

class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWebSocket[] = []
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'blob'
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeWebSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
  }
  __open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
  __message(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }
  __close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
  /** 注意：不改 readyState —— onerror 时连接可能尚未完全关闭，用例须证明
   *  onerror 路径根本不调 requestResync，而非被 readyState 守卫挡住。 */
  __error(): void {
    this.onerror?.()
  }
}

/** 某连接 sent 里是否发过 resync 控制帧。 */
function sentResync(ws: FakeWebSocket): boolean {
  return ws.sent.some((s) => s.includes('"resync"'))
}

// rAF stub（useCellFrame enqueue 依赖；收而不 flush，帧不入 xterm）
let rafQueue: Array<() => void> = []

type HookResult = ReturnType<typeof useTerminal>

function Probe(props: { sessionId: string | null; onResult: (r: HookResult) => void }) {
  const r = useTerminal({ sessionId: props.sessionId, runtimeKind: 'pty' })
  props.onResult(r)
  return null
}

describe('useTerminal 状态行 resync（C1：mid-stream 直写后强制重同步）', () => {
  let root: Root
  let hook: HookResult

  beforeEach(() => {
    vi.stubGlobal(
      'requestAnimationFrame',
      (cb: () => void) => (rafQueue.push(cb), rafQueue.length),
    )
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
    root = createRoot(document.createElement('div'))
    act(() => {
      root.render(
        createElement(Probe, {
          sessionId: 's1',
          onResult: (r) => {
            hook = r
          },
        }),
      )
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    vi.unstubAllGlobals()
    rafQueue = []
  })

  /** 建 terminal + WS 连接（不 open），返回最新一条 FakeWebSocket。 */
  async function mountAndConnect(): Promise<FakeWebSocket> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      hook.initTerminal(container)
      for (let i = 0; i < 50 && FakeWebSocket.instances.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
    })
    // terminalReady → auto-connect effect 已跑，wsRef 持有最新实例
    const ws = FakeWebSocket.instances.at(-1)
    expect(ws).toBeDefined()
    return ws as FakeWebSocket
  }

  /** 一帧与 FakeTerminal 尺寸一致的全帧（不触发 resize 补发）。 */
  function fullFrame(): Record<string, unknown> {
    return {
      t: 'cell_frame',
      width: 80,
      height: 24,
      full: true,
      rows: [{ runs: ['', 'ok '] }],
    }
  }

  it('mid-stream error 状态行直写后发 resync', async () => {
    const ws = await mountAndConnect()
    act(() => ws.__open())
    act(() => ws.__message(fullFrame()))
    expect(sentResync(ws)).toBe(false)

    act(() => ws.__message({ type: 'error', message: 'boom' }))
    expect(sentResync(ws)).toBe(true)
  })

  it('mid-stream exit 状态行直写后发 resync', async () => {
    const ws = await mountAndConnect()
    act(() => ws.__open())
    act(() => ws.__message(fullFrame()))

    act(() => ws.__message({ type: 'exit', code: 1 }))
    expect(sentResync(ws)).toBe(true)
  })

  it('首帧前不触发：connected（onopen）与 attached 消息均无 resync', async () => {
    const ws = await mountAndConnect()
    act(() => ws.__open())
    expect(sentResync(ws)).toBe(false)

    act(() => ws.__message({ type: 'attached', session: 'ext-1' }))
    expect(sentResync(ws)).toBe(false)
  })

  it('流死后不触发：onclose / onerror 状态行直写均无 resync', async () => {
    const ws = await mountAndConnect()
    act(() => ws.__open())
    act(() => ws.__message(fullFrame()))

    // onerror：readyState 仍 OPEN（见 __error 注释），证明路径本身不调 requestResync
    act(() => ws.__error())
    expect(sentResync(ws)).toBe(false)

    act(() => ws.__close())
    expect(sentResync(ws)).toBe(false)
  })

  it('unicode11 宽表已激活（像素方块 logo 列宽对齐的前提）', async () => {
    FakeTerminalCtor.instances = []
    await mountAndConnect()
    const term = FakeTerminalCtor.instances.at(-1)
    expect(term).toBeDefined()
    // 后端 alacritty 按 Unicode 11+ 宽表布局 grid；前端不激活 '11' 则
    // ⬛🟥 等方块 emoji 少占 1 列，像素 logo 整体压扁错位。
    expect(term!.unicode.activeVersion).toBe('11')
  })})
